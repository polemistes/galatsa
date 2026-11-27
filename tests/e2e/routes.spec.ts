// SPDX-License-Identifier: GPL-3.0-or-later

// Routes and stops on the development page (docs/adr/0013-routes-and-stops.md),
// through the routes panel with the mouse and the keyboard: Alt+R opens the
// panel; a stop from the view makes the first route; a stop from a selected
// frame follows the frame when it is dragged, and a click on the stop jumps
// the camera there; each action is one undo step that Ctrl+Z takes back; a
// second route visits the same stop, and renaming it renames it in both;
// deleting it warns, in the program's own dialog, that two routes use it, and
// Cancel keeps it; deleting anyway takes it out of both routes, and Ctrl+Z
// brings it back to both; the route is drawn on the canvas. Runs in the
// "chromium" and "editor-firefox" projects (and "editor-webkit" where
// Playwright's WebKit runs).

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?scene=empty&lang=en`;

/** A frame named "Intro" at (100, 100), 300 x 200, as a fragment the basics' paste takes. */
const FRAME_FRAGMENT = {
  elements: {
    frameIntro: {
      type: "core/frame",
      typeVersion: 1,
      parent: null,
      order: "a0",
      pos: { x: 100, y: 100, space: null },
      rebase: null,
      size: { w: 300, h: 200 },
      name: "Intro",
      locked: false,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [],
      ext: {},
      data: { fill: "#fef3c7", stroke: "#92400e" },
    },
  },
  roots: ["frameIntro"],
  stops: {},
  routes: {},
  fallbackViews: {},
  assets: {},
};

interface DevEditor {
  doc: {
    getMap(name: string): {
      toJSON(): Record<string, unknown>;
    };
  };
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  services: { selection: { set(ids: readonly string[]): void } };
  camera: { space: string | null; cx: number; cy: number; zoom: number };
  scene: { offset(from: string | null, to: string | null): { x: number; y: number } };
  live: {
    worldOrigin(id: string): { x: number; y: number };
    get(id: string): { size?: { w: number; h: number } } | undefined;
  };
  projection(space: string | null): { scale: number; ox: number; oy: number };
  undo: { undoStack: unknown[] };
}

/** Runs `fn` with the page's editor. */
async function withEditor<T, A>(
  page: Page,
  fn: (editor: DevEditor, arg: A) => T,
  arg: A,
): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const editor = (
        window as unknown as { galatsaDev: { editor(): DevEditor | null } }
      ).galatsaDev.editor();
      if (editor === null) throw new Error("No editor");
      return (new Function(`return (${source as string})`)() as typeof fn)(editor, a as A);
    },
    [fn.toString(), arg] as const,
  );
}

interface RouteState {
  /** Live routes' visits, as stop ids in playing order (removed stops left out). */
  routes: string[][];
  names: Record<string, string>;
  undoSteps: number;
}

/** The routes as the document holds them now. */
async function routes(page: Page): Promise<RouteState> {
  return withEditor(
    page,
    (editor) => {
      type Marks = Record<string, { seen: Record<string, string> }>;
      const stops = editor.doc.getMap("stops").toJSON() as Record<
        string,
        { name: string; deleted: Marks }
      >;
      const all = editor.doc.getMap("routes").toJSON() as Record<
        string,
        {
          order: string;
          deleted: Marks;
          entries: Record<string, { stop: string; order: string }>;
        }
      >;
      // A record is removed while a mark lists it (fresh records here have no
      // concurrent work, so any mark that lists the id is current).
      const removed = (id: string, marks: Marks) =>
        Object.values(marks).some((mark) => Object.hasOwn(mark.seen, id));
      const byKey = (a: [string, { order: string }], b: [string, { order: string }]) =>
        a[1].order < b[1].order ? -1 : a[1].order > b[1].order ? 1 : a[0] < b[0] ? -1 : 1;
      const live = Object.entries(all)
        .filter(([id, r]) => !removed(id, r.deleted))
        .sort(byKey);
      return {
        routes: live.map(([, r]) =>
          Object.entries(r.entries)
            .sort(byKey)
            .map(([, e]) => e.stop)
            .filter((s) => stops[s] !== undefined && !removed(s, stops[s].deleted)),
        ),
        names: Object.fromEntries(Object.entries(stops).map(([id, s]) => [id, s.name])),
        undoSteps: editor.undo.undoStack.length,
      };
    },
    null,
  );
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

test("routes and stops through the panel, each action one undo step", async ({
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

  // A frame on the canvas, and the camera with the canvas origin at the top left.
  const pasted = await withEditor(
    page,
    (editor, fragment) => {
      const outcome = editor.run("galatsa.basics/paste", { fragment });
      return outcome.ok ? (outcome.value as { ids: string[] }).ids[0]! : null;
    },
    FRAME_FRAGMENT,
  );
  expect(pasted).not.toBeNull();
  const frame = pasted!;
  await withEditor(
    page,
    (editor, size) => {
      (
        editor as unknown as {
          services: { camera: { set(v: unknown): void } };
        }
      ).services.camera.set({ space: null, cx: size.w / 2, cy: size.h / 2, zoom: 1 });
      editor.services.selection.set([]);
    },
    { w: box.width, h: box.height },
  );

  // Alt+R opens the panel.
  await surface.focus();
  await page.keyboard.press("Alt+r");
  const panel = page.getByRole("complementary").filter({ hasText: "Routes" });
  await expect(panel.getByRole("heading", { name: "Routes" })).toBeVisible();
  await expect(panel.getByText("No routes yet")).toBeVisible();
  const steps = panel.getByRole("list", { name: "Stops in the route" });

  // A stop from the view: the first route.
  const start = await routes(page);
  await panel.getByRole("button", { name: "Stop from the view" }).click();
  await expect(steps.getByRole("listitem")).toHaveCount(1);
  let now = await routes(page);
  expect(now.routes).toHaveLength(1);
  expect(now.routes[0]).toHaveLength(1);
  expect(now.undoSteps).toBe(start.undoSteps + 1);
  const viewStop = now.routes[0]![0]!;

  // A stop from the selected frame, named after the frame.
  await withEditor(page, (editor, id) => editor.services.selection.set([id]), frame);
  await panel.getByRole("button", { name: "Stops from selected frames" }).click();
  await expect(steps.getByRole("listitem")).toHaveCount(2);
  await expect(steps.getByRole("listitem").nth(1)).toContainText("Intro");
  now = await routes(page);
  const frameStop = now.routes[0]![1]!;
  expect(now.undoSteps).toBe(start.undoSteps + 2);

  // The button kept the keyboard on the canvas: Ctrl+Z takes the stop back, redo brings it.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(steps.getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(steps.getByRole("listitem")).toHaveCount(2);

  // The route on the canvas: the numbered mark of the first stop, in the
  // middle of the view it was made of.
  const mark = await pixel(page, box.width / 2 + 7, box.height / 2);
  expect([
    [0x7c, 0x3a, 0xed],
    [0xdb, 0x27, 0x77],
  ]).toContainEqual(mark);

  // Drag the frame with the mouse: the stop follows it.
  await withEditor(page, (editor) => editor.services.selection.set([]), null);
  await page.mouse.move(box.x + 250, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 330, box.y + 180, { steps: 8 });
  await page.mouse.up();
  const moved = await withEditor(
    page,
    (editor, id) => {
      const o = editor.live.worldOrigin(id);
      const size = editor.live.get(id)!.size!;
      return { x: o.x + size.w / 2, y: o.y + size.h / 2 };
    },
    frame,
  );
  expect(moved.x).toBeCloseTo(250 + 80, 0);
  expect(moved.y).toBeCloseTo(200 + 60, 0);

  // A click on the stop flies the camera there: it ends centred on the moved frame.
  await surface.focus();
  await steps.getByRole("button", { name: /Intro/ }).click();
  await expect
    .poll(
      () =>
        withEditor(
          page,
          (editor) => {
            const c = editor.camera;
            const o = editor.scene.offset(c.space, null);
            return [Math.round(c.cx + o.x), Math.round(c.cy + o.y)];
          },
          null,
        ),
      { timeout: 10_000 },
    )
    .toEqual([Math.round(moved.x), Math.round(moved.y)]);

  // A second route visits the same stop.
  await panel.getByRole("button", { name: "New route" }).click();
  await expect(panel.getByText("The route has no stops yet.")).toBeVisible();
  await panel.getByLabel("Existing stop").selectOption({ label: "Intro" });
  await panel.getByRole("button", { name: "Add to the route" }).click();
  await expect(steps.getByRole("listitem")).toHaveCount(1);
  now = await routes(page);
  expect(now.routes).toEqual([[viewStop, frameStop], [frameStop]]);

  // Renaming it in the second route renames it in the first.
  const name = panel.getByLabel("Stop name");
  await name.fill("Opening");
  await name.press("Enter");
  await name.blur();
  await expect.poll(async () => (await routes(page)).names[frameStop]).toBe("Opening");
  await panel.getByLabel("Route", { exact: true }).selectOption({ index: 0 });
  await expect(steps.getByRole("listitem").nth(1)).toContainText("Opening");

  // Deleting it warns that two routes use it; Cancel keeps it.
  await steps.getByRole("button", { name: /Opening/ }).click();
  await panel.getByRole("button", { name: "Delete stop" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("used in 2 routes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await routes(page)).routes).toEqual([[viewStop, frameStop], [frameStop]]);

  // Deleting anyway takes it out of both routes, as one step.
  const before = (await routes(page)).undoSteps;
  await panel.getByRole("button", { name: "Delete stop" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete anyway" }).click();
  await expect(steps.getByRole("listitem")).toHaveCount(1);
  now = await routes(page);
  expect(now.routes).toEqual([[viewStop], []]);
  expect(now.undoSteps).toBe(before + 1);

  // Ctrl+Z brings it back to both.
  await surface.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(steps.getByRole("listitem")).toHaveCount(2);
  expect((await routes(page)).routes).toEqual([[viewStop, frameStop], [frameStop]]);

  // Alt+R closes the panel.
  await page.keyboard.press("Alt+r");
  await expect(panel).toHaveCount(0);

  expect(errors).toEqual([]);
});
