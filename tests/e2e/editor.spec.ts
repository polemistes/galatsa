// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's development page (apps/web) in a real browser: it opens the
// sample scene, a shape tool from the sketches draws a rectangle with the
// mouse, the selection tool drags it (previewed while dragging, one step at the
// end), and undo and redo work from the keyboard. Runs in the "chromium",
// "editor-firefox" and, where Playwright's WebKit can run, "editor-webkit"
// projects (`pnpm --filter @galatsa/e2e exec playwright test editor.spec.ts`).

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en&fresh`;
const SHAPE = "examples.shape/shape";

interface Probe {
  shapes: number;
  elements: number;
  selection: string[];
  tool: string | null;
}

/** What the page's editor holds now. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate((shapeType) => {
    const editor = (
      window as unknown as {
        galatsaDev: {
          editor(): {
            live: {
              ids(): Iterable<string>;
              get(id: string): { type: string } | undefined;
              isGone(id: string): boolean;
            };
            selection: readonly string[];
            tools: { current: string | null };
          } | null;
        };
      }
    ).galatsaDev.editor();
    if (editor === null) throw new Error("No editor");
    const ids = [...editor.live.ids()].filter((id) => !editor.live.isGone(id));
    return {
      shapes: ids.filter((id) => editor.live.get(id)?.type === shapeType).length,
      elements: ids.length,
      selection: [...editor.selection],
      tool: editor.tools.current,
    };
  }, SHAPE);
}

/** Where a selected element is on screen (CSS pixels of the canvas), from the renderer. */
async function screenBox(page: Page, id: string) {
  return page.evaluate((elementId) => {
    const editor = (
      window as unknown as {
        galatsaDev: {
          editor(): {
            renderer: {
              screenBounds(
                id: string,
              ): { x: number; y: number; w: number; h: number } | null;
            };
          } | null;
        };
      }
    ).galatsaDev.editor();
    return editor?.renderer.screenBounds(elementId) ?? null;
  }, id);
}

/** The colour of a canvas pixel at a point in CSS pixels, after the next frame. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([px, py]) => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const canvas = document.querySelector<HTMLCanvasElement>(".galatsa-canvas canvas")!;
      const ratio = canvas.width / canvas.clientWidth;
      const data = canvas
        .getContext("2d")!
        .getImageData(Math.round(px! * ratio), Math.round(py! * ratio), 1, 1).data;
      return [data[0]!, data[1]!, data[2]!];
    },
    [x, y],
  );
}

test("the development page edits the sample scene with the mouse and the keyboard", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(URL);
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as unknown as { galatsaDev?: { editor(): unknown } }
        ).galatsaDev?.editor(),
      ),
    null,
    { timeout: 90_000 },
  );
  const surface = page.locator(".galatsa-canvas");
  await expect(surface).toBeVisible();
  await expect(surface).toHaveAttribute("aria-label", "Canvas");

  // The sample scene: the benchmark's 2,000 elements, 1,200 of them shapes.
  const start = await probe(page);
  expect(start.elements).toBe(2000);
  expect(start.shapes).toBe(1200);
  expect(start.tool).toBe("examples.select/select");

  const box = (await surface.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });

  // Pick the rectangle tool by its shortcut and draw with the mouse.
  await surface.focus();
  await page.keyboard.press("r");
  expect((await probe(page)).tool).toBe("examples.shape/rect");
  const from = at(box.width * 0.3, box.height * 0.3);
  const to = at(box.width * 0.5, box.height * 0.6);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await probe(page)).shapes).toBe(start.shapes + 1);
  await expect.poll(async () => (await probe(page)).tool).toBe("examples.select/select");

  // The new shape is drawn: the middle of the rectangle has the shape's fill.
  const mid = { x: box.width * 0.4, y: box.height * 0.45 };
  expect(await pixel(page, mid.x, mid.y)).toEqual([0x93, 0xc5, 0xfd]);

  // Undo, redo with Shift, undo, redo with Y.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await probe(page)).shapes).toBe(start.shapes);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => (await probe(page)).shapes).toBe(start.shapes + 1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await probe(page)).shapes).toBe(start.shapes);
  await page.keyboard.press("ControlOrMeta+y");
  await expect.poll(async () => (await probe(page)).shapes).toBe(start.shapes + 1);

  // Drag the new shape with the selection tool: one step, which undo takes back.
  await page.mouse.click(at(mid.x, mid.y).x, at(mid.x, mid.y).y);
  const selected = (await probe(page)).selection;
  expect(selected).toHaveLength(1);
  const before = (await screenBox(page, selected[0]!))!;
  await page.mouse.move(at(mid.x, mid.y).x, at(mid.x, mid.y).y);
  await page.mouse.down();
  await page.mouse.move(at(mid.x + 60, mid.y + 40).x, at(mid.x + 60, mid.y + 40).y, {
    steps: 6,
  });
  // While dragging, the renderer shows the shape where the pointer took it.
  const during = (await screenBox(page, selected[0]!))!;
  expect(during.x - before.x).toBeGreaterThan(40);
  await page.mouse.up();
  const after = (await screenBox(page, selected[0]!))!;
  expect(after.x - before.x).toBeGreaterThan(40);
  expect(after.y - before.y).toBeGreaterThan(25);

  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await screenBox(page, selected[0]!))!.x)
    .toBeCloseTo(before.x, 3);
  // The shape is still there; only the move was undone.
  expect((await probe(page)).shapes).toBe(start.shapes + 1);

  // The save status is shown in the React root.
  await expect(page.locator(".galatsa-save-status")).not.toBeEmpty({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
