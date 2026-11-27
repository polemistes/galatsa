// SPDX-License-Identifier: GPL-3.0-or-later

// The shape extension's drawing tools on the development page (apps/web) in a
// real browser, with the mouse: while dragging, the canvas shows a preview of
// the shape and the document is unchanged; on release the shape is made as one
// undo step, which Ctrl+Z takes back whole; Escape cancels a drag. Runs in the
// "chromium", "editor-firefox" and, where Playwright's WebKit can run,
// "editor-webkit" projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?scene=empty&lang=en`;
const SHAPE = "galatsa.shape/shape";

interface Probe {
  shapes: { id: string; kind: unknown; w: number; h: number; rot: number }[];
  undoSteps: number;
  tool: string | null;
  zoom: number;
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
            doc: {
              getMap(name: string): {
                get(id: string): {
                  toJSON(): {
                    data: Record<string, unknown>;
                    size: { w: number; h: number };
                    rot: number;
                  };
                };
              };
            };
            undo: { undoStack: unknown[] };
            tools: { current: string | null };
            camera: { zoom: number };
          } | null;
        };
      }
    ).galatsaDev.editor();
    if (editor === null) throw new Error("No editor");
    const shapes = [...editor.live.ids()]
      .filter((id) => !editor.live.isGone(id) && editor.live.get(id)?.type === shapeType)
      .map((id) => {
        // The record as the document holds it.
        const e = editor.doc.getMap("elements").get(id).toJSON();
        return { id, kind: e.data["kind"], w: e.size.w, h: e.size.h, rot: e.rot };
      });
    return {
      shapes,
      undoSteps: editor.undo.undoStack.length,
      tool: editor.tools.current,
      zoom: editor.camera.zoom,
    };
  }, SHAPE);
}

/** The colour of a canvas pixel at a point in CSS pixels of the canvas, after the next frame. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([px, py]) => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
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

test("the shape tools draw with the mouse, with a preview, as one undo step", async ({
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
  const box = (await surface.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
  const start = await probe(page);
  expect(start.shapes).toEqual([]);
  const background = await pixel(page, box.width * 0.4, box.height * 0.45);

  // The rectangle tool, picked by its key.
  await surface.focus();
  await page.keyboard.press("r");
  expect((await probe(page)).tool).toBe("galatsa.shape/rect");
  const from = at(box.width * 0.3, box.height * 0.3);
  const to = at(box.width * 0.5, box.height * 0.6);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });

  // While dragging: the preview shows the new shape's fill, the document is as it was.
  await expect
    .poll(() => pixel(page, box.width * 0.4, box.height * 0.45))
    .toEqual([0x93, 0xc5, 0xfd]);
  expect((await probe(page)).shapes).toEqual([]);
  expect((await probe(page)).undoSteps).toBe(start.undoSteps);

  await page.mouse.up();
  await expect.poll(async () => (await probe(page)).shapes.length).toBe(1);
  const made = await probe(page);
  expect(made.tool).toBe("galatsa.select/select");
  expect(made.undoSteps).toBe(start.undoSteps + 1);
  expect(made.shapes[0]).toMatchObject({ kind: "rect", rot: 0 });
  expect(made.shapes[0]!.w * made.zoom).toBeCloseTo(box.width * 0.2, 0);
  expect(made.shapes[0]!.h * made.zoom).toBeCloseTo(box.height * 0.3, 0);
  expect(await pixel(page, box.width * 0.4, box.height * 0.45)).toEqual([
    0x93, 0xc5, 0xfd,
  ]);

  // One undo step takes the whole shape back; redo brings it again.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await probe(page)).shapes.length).toBe(0);
  expect((await probe(page)).undoSteps).toBe(start.undoSteps);
  expect(await pixel(page, box.width * 0.4, box.height * 0.45)).toEqual(background);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => (await probe(page)).shapes.length).toBe(1);

  // A line from where the drag starts to where it ends, turned its way.
  await page.keyboard.press("l");
  expect((await probe(page)).tool).toBe("galatsa.shape/line");
  const a = at(box.width * 0.6, box.height * 0.7);
  const b = at(box.width * 0.6 + 120, box.height * 0.7 - 90);
  const middle = { x: box.width * 0.6 + 60, y: box.height * 0.7 - 45 };
  const before = await pixel(page, middle.x, middle.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await expect.poll(() => pixel(page, middle.x, middle.y)).not.toEqual(before);
  expect((await probe(page)).shapes).toHaveLength(1);
  await page.mouse.up();
  await expect.poll(async () => (await probe(page)).shapes.length).toBe(2);
  const lines = await probe(page);
  const line = lines.shapes.find((s) => s.kind === "line")!;
  expect(line.h).toBe(0);
  expect(line.w * lines.zoom).toBeCloseTo(150, 0);
  expect(line.rot).toBeCloseTo(Math.atan2(-90, 120) + 2 * Math.PI, 2);
  expect(lines.undoSteps).toBe(start.undoSteps + 2);

  // Escape cancels a drag: nothing is made.
  await page.keyboard.press("o");
  expect((await probe(page)).tool).toBe("galatsa.shape/ellipse");
  const c = at(box.width * 0.1, box.height * 0.1);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const after = await probe(page);
  expect(after.shapes).toHaveLength(2);
  expect(after.undoSteps).toBe(start.undoSteps + 2);

  expect(errors).toEqual([]);
});
