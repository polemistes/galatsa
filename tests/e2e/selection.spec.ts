// SPDX-License-Identifier: GPL-3.0-or-later

// The selection tool on the development page, with the mouse and the keyboard
// in a real browser: click, Shift-click and rubber-band selection; grouping
// with Ctrl+G and scaling the group with a corner handle, its proportions
// kept and one Ctrl+Z taking it back; rotating with the handle above the box;
// a locked element that cannot be dragged and is unlocked from the context
// menu; duplicate and delete; and copy and paste through the system
// clipboard, into a second page with a document of its own, so that nothing
// but the clipboard can carry the copy. Runs in the "chromium",
// "editor-firefox" and, where Playwright's WebKit can run, "editor-webkit"
// projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en&scene=empty&mode=advanced`;

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

interface DevEditor {
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  selection: readonly string[];
  services: {
    camera: {
      set(view: { space: null; cx: number; cy: number; zoom: number }): void;
    };
    scene: {
      placement(id: string): {
        worldX: number;
        worldY: number;
        w: number;
        h: number;
        rot: number;
      } | null;
    };
  };
  live: {
    ids(): Iterable<string>;
    get(id: string): { type: string } | undefined;
    isGone(id: string): boolean;
    isLocked(id: string): boolean;
  };
  screen: { width: number; height: number };
}

/** What the development page offers tests (`window.galatsaDev`). */
interface Dev {
  galatsaDev: { editor(): DevEditor | null };
}

/** Opens an empty document, and puts root space one to one on the canvas. */
async function open(page: Page): Promise<{ x: number; y: number }> {
  await page.goto(URL);
  await page.waitForFunction(
    () => Boolean((window as unknown as Partial<Dev>).galatsaDev?.editor()),
    null,
    {
      timeout: 90_000,
    },
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

async function insertRect(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(
    ([px, py, pw, ph]) => {
      const editor = (window as unknown as Dev).galatsaDev.editor()!;
      const outcome = editor.run("examples.shape/insert", {
        kind: "rect",
        x: px,
        y: py,
        w: pw,
        h: ph,
      });
      if (!outcome.ok) throw new Error("insert refused");
      return outcome.value as string;
    },
    [x, y, w, h],
  );
}

async function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as Dev).galatsaDev.editor()!.selection,
  ]);
}

async function placed(page: Page, id: string): Promise<Placed | null> {
  return page.evaluate((elementId) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const p = editor.services.scene.placement(elementId);
    return p === null ? null : { x: p.worldX, y: p.worldY, w: p.w, h: p.h, rot: p.rot };
  }, id);
}

/** Elements the user sees, by type. */
async function count(page: Page, type?: string): Promise<number> {
  return page.evaluate((only) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    return [...editor.live.ids()].filter(
      (id) =>
        !editor.live.isGone(id) &&
        (only === undefined || editor.live.get(id)?.type === only),
    ).length;
  }, type);
}

async function locked(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    (elementId) =>
      (window as unknown as Dev).galatsaDev.editor()!.live.isLocked(elementId),
    id,
  );
}

test("the selection tool selects, groups, scales, rotates, locks and copies with mouse and keys", async ({
  page,
  context,
  browserName,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const origin = await open(page);
  const at = (x: number, y: number) => ({ x: origin.x + x, y: origin.y + y });
  const click = async (x: number, y: number, options = {}) => {
    const p = at(x, y);
    await page.mouse.click(p.x, p.y, options);
  };
  const dragFrom = async (from: [number, number], to: [number, number]) => {
    const a = at(...from);
    const b = at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };

  const a = await insertRect(page, 100, 100, 100, 100);
  const b = await insertRect(page, 300, 100, 100, 100);
  const SHAPE = "examples.shape/shape";
  expect(await count(page, SHAPE)).toBe(2);

  // Click, Shift-click, a click on empty canvas, and a rubber band.
  await click(150, 150);
  expect(await selection(page)).toEqual([a]);
  await page.keyboard.down("Shift");
  await click(350, 150);
  await page.keyboard.up("Shift");
  expect(await selection(page)).toEqual([a, b]);
  await click(600, 400);
  expect(await selection(page)).toEqual([]);
  await dragFrom([50, 50], [450, 250]);
  expect(await selection(page)).toEqual([a, b]);

  // Group with Ctrl+G, then scale the group from its bottom right corner:
  // the box 100..400 by 100..200 from (400, 200) to (500, 250) is a factor
  // of 1.35 about the top left corner, the same for both members.
  await page.keyboard.press("ControlOrMeta+g");
  const [group] = await selection(page);
  expect(group).not.toBe(a);
  await dragFrom([400, 200], [500, 250]);
  const k = 1.35;
  const sa = (await placed(page, a))!;
  const sb = (await placed(page, b))!;
  expect(sa.w).toBeCloseTo(100 * k, 6);
  expect(sb.x).toBeCloseTo(100 + 200 * k, 6);
  expect(sb.w).toBeCloseTo(100 * k, 6);
  expect((sb.x - sa.x) / sa.w).toBeCloseTo(2, 6);
  // One drag, one step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await placed(page, b))!.w).toBeCloseTo(100, 6);
  expect((await placed(page, b))!.x).toBeCloseTo(300, 6);

  // Ungroup, select one, and rotate it a quarter turn with the handle above it.
  await page.keyboard.press("ControlOrMeta+Shift+G");
  await click(150, 150);
  expect(await selection(page)).toEqual([a]);
  await dragFrom([150, 100 - 24], [300, 150]);
  expect((await placed(page, a))!.rot).toBeCloseTo(Math.PI / 2, 2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await placed(page, a))!.rot).toBe(0);

  // Lock it (Ctrl+Shift+L in advanced mode): it cannot be dragged.
  await click(150, 150);
  await page.keyboard.press("ControlOrMeta+Shift+L");
  expect(await locked(page, a)).toBe(true);
  await dragFrom([150, 150], [250, 250]);
  expect(await placed(page, a)).toMatchObject({ x: 100, y: 100 });
  // A right click selects it, and the context menu unlocks it.
  await click(150, 150, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect(await selection(page)).toEqual([a]);
  await page.getByRole("menuitem", { name: "Unlock" }).click();
  await expect(menu).toBeHidden();
  expect(await locked(page, a)).toBe(false);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => locked(page, a)).toBe(true);
  await page.keyboard.press("ControlOrMeta+y");
  await expect.poll(() => locked(page, a)).toBe(false);

  // Duplicate and delete, each taken back by one undo.
  await click(350, 150);
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(() => count(page, SHAPE)).toBe(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => count(page, SHAPE)).toBe(2);
  await click(350, 150);
  await page.keyboard.press("Delete");
  await expect.poll(() => count(page, SHAPE)).toBe(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => count(page, SHAPE)).toBe(2);

  // Copy with the keyboard: the system clipboard holds the program's envelope.
  await click(350, 150);
  expect(await selection(page)).toEqual([b]);
  await page.keyboard.press("ControlOrMeta+c");
  if (browserName === "chromium") {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(text)).toMatchObject({
      kind: "galatsa/fragment",
      version: 1,
      fragment: { roots: [b] },
    });
  }

  // Paste into a second page, a document of its own: only the system
  // clipboard can carry the copy there.
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(String(error)));
  await open(second);
  expect(await count(second, SHAPE)).toBe(0);
  await second.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => count(second, SHAPE)).toBe(1);
  const [pasted] = await selection(second);
  expect(await placed(second, pasted!)).toMatchObject({ x: 300, y: 100, w: 100, h: 100 });
  await second.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => count(second, SHAPE)).toBe(0);

  // Copy from the context menu, and paste again in the second page.
  await page.bringToFront();
  await click(150, 150, { button: "right" });
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await second.bringToFront();
  await second.locator(".galatsa-canvas").focus();
  await second.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => count(second, SHAPE)).toBe(1);
  const [fromMenu] = await selection(second);
  expect(await placed(second, fromMenu!)).toMatchObject({ x: 100, y: 100 });

  // Paste from the context menu reads the asynchronous clipboard, which
  // Chromium lets the page read once permitted.
  if (browserName === "chromium") {
    const box = (await second.locator(".galatsa-canvas").boundingBox())!;
    await second.mouse.click(box.x + 600, box.y + 400, { button: "right" });
    await second.getByRole("menuitem", { name: "Paste" }).click();
    await expect.poll(() => count(second, SHAPE)).toBe(2);
  }

  expect(errors).toEqual([]);
});
