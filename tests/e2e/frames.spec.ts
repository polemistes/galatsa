// SPDX-License-Identifier: GPL-3.0-or-later

// Frames and the stacking order on the development page, with the mouse and
// the keyboard in a real browser (docs/adr/0014-stacking-and-frames.md):
// a frame drawn with the frame tool (F) around a picture and a text; the
// picture sent to the back of the frame with Ctrl+Shift+[ so the text is on
// top; the frame dragged by its name, with nothing inside it shifting; an
// element dragged out of the frame and back in; Ctrl+[ and Ctrl+] (and the
// keys of a Norwegian keyboard, sent as the browser reports them) restacking
// inside the frame without the browser going back in its history; and the
// frame renamed from the context menu. Every action is one undo step. Runs
// in the "chromium" and "editor-firefox" projects (and "editor-webkit"
// where Playwright's WebKit runs).

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en&scene=empty`;
const FRAME = "core/frame";

interface DevEditor {
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  selection: readonly string[];
  importFiles(files: File[]): Promise<boolean>;
  tools: { current: string | null };
  services: {
    selection: { set(ids: readonly string[]): void };
    camera: {
      set(view: { space: null; cx: number; cy: number; zoom: number }): void;
    };
    scene: {
      placement(id: string): { worldX: number; worldY: number } | null;
    };
  };
  live: {
    ids(): Iterable<string>;
    get(id: string): { type: string } | undefined;
    isGone(id: string): boolean;
    logicalParentOf(id: string): string | null;
    logicalChildren(id: string | null): string[];
  };
  screen: { width: number; height: number };
  doc: unknown;
}

interface Dev {
  galatsaDev: { editor(): DevEditor | null };
  galatsaTestImage(
    width: number,
    height: number,
    seed: number,
    type: string,
  ): Promise<Blob>;
}

/** A picture drawn in the page; nothing is downloaded. */
function installTestImage(): void {
  (window as unknown as Dev).galatsaTestImage = async (width, height, seed, type) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `hsl(${(seed * 47) % 360} 70% 55%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
    return canvas.convertToBlob({ type });
  };
}

async function open(page: Page): Promise<{ x: number; y: number }> {
  await page.addInitScript(installTestImage);
  await page.goto(URL);
  await page.waitForFunction(
    () => Boolean((window as unknown as Partial<Dev>).galatsaDev?.editor()),
    null,
    { timeout: 90_000 },
  );
  await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const { width, height } = editor.screen;
    editor.services.camera.set({ space: null, cx: width / 2, cy: height / 2, zoom: 1 });
  });
  const box = (await page.locator(".galatsa-canvas").boundingBox())!;
  await page.locator(".galatsa-canvas").focus();
  return { x: box.x, y: box.y };
}

async function where(page: Page, id: string) {
  return page.evaluate((elementId) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const p = editor.services.scene.placement(elementId)!;
    return {
      x: p.worldX,
      y: p.worldY,
      parent: editor.live.logicalParentOf(elementId),
    };
  }, id);
}

async function children(page: Page, id: string | null): Promise<string[]> {
  return page.evaluate(
    (parent) =>
      (window as unknown as Dev).galatsaDev.editor()!.live.logicalChildren(parent),
    id,
  );
}

async function frames(page: Page): Promise<string[]> {
  return page.evaluate((type) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    return [...editor.live.ids()].filter(
      (id) => !editor.live.isGone(id) && editor.live.get(id)?.type === type,
    );
  }, FRAME);
}

async function frameName(page: Page, id: string): Promise<string> {
  return page.evaluate((elementId) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const doc = editor.doc as {
      getMap(name: string): {
        get(id: string): { get(key: string): unknown } | undefined;
      };
    };
    return String(doc.getMap("elements").get(elementId)?.get("name") ?? "");
  }, id);
}

test("a picture at the back of a frame with text on top, and the frame moved without anything shifting", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const origin = await open(page);
  const at = (x: number, y: number) => ({ x: origin.x + x, y: origin.y + y });
  const dragFrom = async (from: [number, number], to: [number, number]) => {
    const a = at(...from);
    const b = at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  const undo = () => page.keyboard.press("ControlOrMeta+z");
  const redo = () => page.keyboard.press("ControlOrMeta+Shift+z");

  // A text, then a picture on top of it, at known places.
  const { text, picture } = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const insert = (id: string, args: unknown) => editor.run(id, args);
    let made = insert("galatsa.text/insert", { x: 220, y: 160, w: 200, text: "Hei" });
    if (!made.ok)
      made = insert("examples.text/insert", { x: 220, y: 160, w: 200, text: "Hei" });
    if (!made.ok) throw new Error("no text");
    const text = made.value as string;
    const blob = await dev.galatsaTestImage(300, 200, 3, "image/png");
    await editor.importFiles([new File([blob], "picture.png", { type: "image/png" })]);
    const picture = editor.selection[0]!;
    const p = editor.services.scene.placement(picture)!;
    editor.run("galatsa.basics/move", {
      ids: [picture],
      dx: 200 - p.worldX,
      dy: 150 - p.worldY,
    });
    editor.services.selection.set([]);
    return { text, picture };
  });
  expect(await where(page, picture)).toMatchObject({ x: 200, y: 150, parent: null });

  // The frame tool draws a frame around both; one undo takes it away.
  await page.keyboard.press("f");
  await dragFrom([150, 100], [600, 450]);
  await expect.poll(() => frames(page)).toHaveLength(1);
  const [frame] = await frames(page);
  expect(await children(page, frame!)).toEqual([text, picture]);
  await undo();
  await expect.poll(() => frames(page)).toHaveLength(0);
  expect(await where(page, picture)).toMatchObject({ parent: null });
  await redo();
  await expect.poll(() => frames(page)).toEqual([frame]);

  // The picture to the back of the frame: the text is on top.
  await page.mouse.click(at(500, 330).x, at(500, 330).y);
  expect(
    await page.evaluate(() => [
      ...(window as unknown as Dev).galatsaDev.editor()!.selection,
    ]),
  ).toEqual([picture]);
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect.poll(() => children(page, frame!)).toEqual([picture, text]);
  await undo();
  await expect.poll(() => children(page, frame!)).toEqual([text, picture]);
  await redo();
  await expect.poll(() => children(page, frame!)).toEqual([picture, text]);

  // The frame dragged by its name moves with all it holds; nothing shifts.
  const before = {
    frame: await where(page, frame!),
    picture: await where(page, picture),
    text: await where(page, text),
  };
  await dragFrom([170, 100 - 9], [270, 160 - 9]);
  const moved = (p: { x: number; y: number }) => ({ x: p.x + 100, y: p.y + 60 });
  await expect.poll(() => where(page, frame!)).toMatchObject(moved(before.frame));
  expect(await where(page, picture)).toMatchObject({
    ...moved(before.picture),
    parent: frame,
  });
  expect(await where(page, text)).toMatchObject({ ...moved(before.text), parent: frame });
  expect(await children(page, frame!)).toEqual([picture, text]);
  await undo();
  await expect.poll(() => where(page, picture)).toMatchObject(before.picture);

  // The text dragged out of the frame onto the canvas, and back in.
  await page.mouse.click(at(260, 175).x, at(260, 175).y);
  await dragFrom([260, 175], [760, 575]);
  await expect.poll(() => where(page, text)).toMatchObject({ parent: null });
  await undo();
  await expect.poll(() => where(page, text)).toMatchObject({ parent: frame });
  await page.mouse.click(at(260, 175).x, at(260, 175).y);
  await dragFrom([260, 175], [760, 575]);
  await expect.poll(() => where(page, text)).toMatchObject({ parent: null });
  await dragFrom([760, 575], [300, 200]);
  await expect.poll(() => where(page, text)).toMatchObject({ parent: frame });
  // Back in, it went in front.
  expect(await children(page, frame!)).toEqual([picture, text]);

  // Ctrl+[ one step back (the browser does not go back in its history), and
  // Ctrl+] one step forward.
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect.poll(() => children(page, frame!)).toEqual([text, picture]);
  expect(page.url()).toBe(url);
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect.poll(() => children(page, frame!)).toEqual([picture, text]);
  // A Norwegian keyboard, as the browser reports it: Ctrl and Å (the key
  // right of P), then Ctrl and the dead key right of it.
  const press = (key: string, code: string) =>
    page.locator(".galatsa-canvas").dispatchEvent("keydown", {
      key,
      code,
      ctrlKey: true,
      metaKey: false,
      bubbles: true,
      cancelable: true,
    });
  await press("å", "BracketLeft");
  await expect.poll(() => children(page, frame!)).toEqual([text, picture]);
  await press("Dead", "BracketRight");
  await expect.poll(() => children(page, frame!)).toEqual([picture, text]);
  // And the arrows, the same on every layout.
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect.poll(() => children(page, frame!)).toEqual([text, picture]);
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect.poll(() => children(page, frame!)).toEqual([picture, text]);

  // Rename the frame from the context menu.
  await page.mouse.click(at(170, 100 - 9).x, at(170, 100 - 9).y, { button: "right" });
  await page.getByRole("menuitem", { name: "Rename frame…" }).click();
  const field = page.getByLabel("Name of the frame");
  await expect(field).toBeFocused();
  await field.fill("Kapittel 1");
  await field.press("Enter");
  await expect.poll(() => frameName(page, frame!)).toBe("Kapittel 1");
  await expect(field).toBeHidden();
  await undo();
  await expect.poll(() => frameName(page, frame!)).toBe("");

  expect(errors).toEqual([]);
});
