// SPDX-License-Identifier: GPL-3.0-or-later

// The whole flow with the mouse, through the toolbar and the properties panel
// (docs/adr/0016), on the web page as a first visitor sees it: an empty
// presentation; a text, a rectangle and an image from a file; a frame around
// the selection where the program has a toolbar button for it; the fill
// changed in the properties panel as one undo step; a route of two stops from
// the routes panel; saved as a file and opened again, with everything there,
// the image's bytes included.
//
// Chromium (and Edge) save and open through the File System Access API; the
// test gives the pickers files of the origin private file system, so the
// real writes and reads run. Firefox has no such API: the file is downloaded
// and picked with the browser's file chooser. Runs in the "chromium" and
// "editor-firefox" projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en`;

interface DevEditor {
  readonly doc: { getMap(name: string): { toJSON(): Record<string, unknown> } };
  readonly live: {
    ids(): Iterable<string>;
    isGone(id: string): boolean;
    worldOrigin(id: string): { x: number; y: number };
  };
  readonly scene: {
    element(
      id: string,
    ):
      | { type: string; data: Record<string, unknown>; size?: { w: number; h: number } }
      | undefined;
  };
  readonly undo: { undoStack: unknown[] };
  readonly selection: readonly string[];
  readonly textEdit: { id: string | null };
  readonly tools: { current: string | null };
}

interface Dev {
  galatsaDev: {
    ready: Promise<{
      state: {
        document: { session: { getAsset(id: string): Promise<Uint8Array | undefined> } };
      };
    }>;
    editor(): DevEditor | null;
  };
  galatsaShellDoc?: unknown;
}

/** What the document holds, as the user sees it. */
interface Contents {
  elements: { type: string; x: number; y: number; data: string }[];
  stops: number;
  routes: number;
  /** Byte lengths of the images' assets in the open document's store. */
  imageBytes: number[];
  undoSteps: number;
}

async function contents(page: Page): Promise<Contents> {
  return page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const elements = [...editor.live.ids()]
      .filter((id) => !editor.live.isGone(id))
      .map((id) => {
        const element = editor.scene.element(id)!;
        const at = editor.live.worldOrigin(id);
        return {
          type: element.type,
          x: Math.round(at.x),
          y: Math.round(at.y),
          data: JSON.stringify(element.data),
        };
      })
      .sort((a, b) => (a.type + a.data < b.type + b.data ? -1 : 1));
    const live = (map: Record<string, unknown>) =>
      Object.values(map).filter(
        (r) => Object.keys((r as { deleted?: object }).deleted ?? {}).length === 0,
      ).length;
    const app = await dev.galatsaDev.ready;
    const imageBytes: number[] = [];
    for (const id of editor.live.ids()) {
      const element = editor.scene.element(id);
      if (element?.type !== "galatsa.image/image" || editor.live.isGone(id)) continue;
      const bytes = await app.state.document.session.getAsset(
        String(element.data["asset"]),
      );
      imageBytes.push(bytes?.length ?? 0);
    }
    return {
      elements,
      stops: live(editor.doc.getMap("stops").toJSON()),
      routes: live(editor.doc.getMap("routes").toJSON()),
      imageBytes,
      undoSteps: editor.undo.undoStack.length,
    };
  });
}

/** A PNG drawn in the page: a picture to insert from a file. */
async function pngBytes(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(320, 200);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0f766e";
    ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "#fde047";
    ctx.fillRect(40, 40, 120, 80);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

/**
 * Chromium: the save and open pickers of the File System Access API give
 * files of the origin private file system, so saving writes through the API
 * and opening reads through it, without a dialog a test cannot answer.
 */
function pickersOverPrivateFiles(): void {
  const w = window as unknown as {
    showSaveFilePicker?: unknown;
    showOpenFilePicker?: unknown;
  };
  if (typeof w.showSaveFilePicker !== "function") return;
  let last: FileSystemFileHandle | null = null;
  w.showSaveFilePicker = async (options: { suggestedName: string }) => {
    const root = await navigator.storage.getDirectory();
    last = await root.getFileHandle(options.suggestedName, { create: true });
    return last;
  };
  w.showOpenFilePicker = async () => {
    if (last === null) throw new DOMException("Nothing saved", "AbortError");
    return [last];
  };
}

test("a presentation made with the mouse is saved as a file and opened again", async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(pickersOverPrivateFiles);
  await page.goto(URL);
  await page.waitForFunction(
    () => Boolean((window as unknown as Partial<Dev>).galatsaDev?.editor()),
    null,
    { timeout: 90_000 },
  );
  await page.evaluate(() => document.fonts.ready);

  // A first visit: an empty presentation, and the toolbar.
  const toolbar = page.getByRole("toolbar", { name: "Toolbar" });
  await expect(toolbar).toBeVisible();
  expect((await contents(page)).elements).toEqual([]);
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
  const button = (id: string) => toolbar.locator(`button[data-id="${id}"]`);

  // Each button says what it does and its shortcut.
  await expect(button("galatsa.shape/rect")).toHaveAttribute("title", "Rectangle (R)");
  await expect(button("galatsa.basics/undo")).toHaveAttribute(
    "title",
    /^Undo \((Ctrl|⌘)/,
  );

  // A text: the text tool, a click on the canvas, typing; a click elsewhere ends it.
  await button("galatsa.text/text").click();
  await page.mouse.click(at(500, 120).x, at(500, 120).y);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Dev).galatsaDev.editor()!.textEdit.id),
    )
    .not.toBeNull();
  await page.keyboard.type("Hello");
  await page.mouse.click(
    at(box.width - 60, box.height - 120).x,
    at(box.width - 60, box.height - 120).y,
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Dev).galatsaDev.editor()!.textEdit.id),
    )
    .toBeNull();

  // A rectangle, drawn with the mouse; it is selected after it is made.
  await button("galatsa.shape/rect").click();
  await expect(button("galatsa.shape/rect")).toHaveAttribute("aria-pressed", "true");
  const from = at(200, 260);
  const to = at(400, 400);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await contents(page)).elements.map((e) => e.type))
    .toEqual(["galatsa.shape/shape", "galatsa.text/text"]);

  // The fill in the properties panel: one undo step.
  const panel = page.getByRole("complementary", { name: "Properties" });
  await expect(panel.getByRole("heading", { name: "Shape" })).toBeVisible();
  const steps = (await contents(page)).undoSteps;
  await panel.locator('[data-key="fill"] input[type="color"]').fill("#dc2626");
  await expect
    .poll(
      async () =>
        (await contents(page)).elements.find((e) => e.type === "galatsa.shape/shape")!
          .data,
    )
    .toContain('"fill":"#dc2626"');
  expect((await contents(page)).undoSteps).toBe(steps + 1);

  // An image from a file, through the toolbar's button and the file chooser.
  const png = await pngBytes(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    button("editor/insert-file").click(),
  ]);
  await chooser.setFiles({ name: "picture.png", mimeType: "image/png", buffer: png });
  await expect
    .poll(async () => (await contents(page)).elements.length, { timeout: 30_000 })
    .toBe(3);

  // A frame around the selection (the image), where the program has a button for it.
  const frameButton = toolbar.locator('button[data-id*="frame"]');
  const framed = (await frameButton.count()) > 0;
  if (framed) {
    await frameButton.first().click();
    await expect
      .poll(async () => (await contents(page)).elements.map((e) => e.type))
      .toContain("core/frame");
  }

  // A route of two stops, from the routes panel.
  await button("galatsa.routes/toggle-panel").click();
  await expect(button("galatsa.routes/toggle-panel")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const routesPanel = page.getByRole("complementary").filter({ hasText: "Routes" });
  await routesPanel.getByRole("button", { name: "Stop from the view" }).click();
  await routesPanel.getByRole("button", { name: "Stop from the view" }).click();
  await expect(
    routesPanel.getByRole("list", { name: "Stops in the route" }).getByRole("listitem"),
  ).toHaveCount(2);

  const before = await contents(page);
  expect(before.stops).toBe(2);
  expect(before.routes).toBe(1);
  expect(before.imageBytes).toHaveLength(1);
  expect(before.imageBytes[0]).toBeGreaterThan(0);
  expect(before.elements.find((e) => e.type === "galatsa.text/text")!.data).toContain(
    "Hello",
  );

  // Save as a file, then open it again.
  await page.evaluate(() => {
    const dev = window as unknown as Dev;
    dev.galatsaShellDoc = dev.galatsaDev.editor()!.doc;
  });
  if (browserName === "chromium") {
    await button("editor/save-file").click();
    await expect(page.locator(".galatsa-save-status")).toHaveText(/Saved/);
    // Saved to a file: opening another asks nothing.
    await button("editor/open-file").click();
  } else {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      button("editor/save-file").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.galatsa$/);
    const path = testInfo.outputPath("saved.galatsa");
    await download.saveAs(path);
    // A download does not count as saved: opening asks first.
    await button("editor/open-file").click();
    const dialog = page.getByRole("dialog", { name: "Open another presentation?" });
    await expect(dialog).toBeVisible();
    const [picker] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "Open without saving" }).click(),
    ]);
    await picker.setFiles(path);
  }
  await page.waitForFunction(() => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor();
    return editor !== null && editor.doc !== dev.galatsaShellDoc;
  });

  const after = await contents(page);
  expect(after.elements).toEqual(before.elements);
  expect(after.stops).toBe(2);
  expect(after.routes).toBe(1);
  expect(after.imageBytes).toEqual(before.imageBytes);
  if (framed) expect(after.elements.map((e) => e.type)).toContain("core/frame");
  expect(errors).toEqual([]);
});

test("the sample scene still opens with a parameter, and the language can be changed", async ({
  page,
}) => {
  await page.goto(`http://localhost:${WEB_PORT}/?lang=en&scene=bench`);
  await page.waitForFunction(
    () => Boolean((window as unknown as Partial<Dev>).galatsaDev?.editor()),
    null,
    { timeout: 90_000 },
  );
  await expect
    .poll(async () => (await contents(page)).elements.length, { timeout: 60_000 })
    .toBeGreaterThan(1000);
  const toolbar = page.getByRole("toolbar", { name: "Toolbar" });
  await toolbar.getByRole("combobox", { name: "Language" }).selectOption("nb");
  await expect(page.getByRole("toolbar", { name: "Verktøylinje" })).toBeVisible();
  await expect(page).toHaveTitle(/Galatsa/);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("nb");
});
