// SPDX-License-Identifier: GPL-3.0-or-later

// Presentation mode on the development page (docs/adr/0015-presentation.md):
// F5 starts the player over the editor, on the open document, in full screen;
// the keyboard and what clickers send (PageDown, PageUp, the arrows, B and the
// full stop) go through the route; a number and Enter, Home and End, and the
// list jump to a stop; another route is chosen in the list; what a stop shows
// and hides is applied on arrival; input in the middle of a transition is
// obeyed without a jump; the mouse, the wheel and touch move the camera
// freely, which pauses the route, Backspace returns to the stop and "next"
// goes on; reduced motion cross-fades; the laser pointer follows the mouse;
// the presenter's notes open in a window of their own; Escape in full screen
// leaves full screen, and Escape in a window ends the presentation and gives
// the keys back to the editor; the editor under the player is inert, Tab stays
// in the player, the clicker's keys always drive it, and keys that reload the
// page do nothing. Runs in the "chromium" and "editor-firefox" projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?scene=empty&lang=en`;

// Long tests, on machines that may be busy.
test.describe.configure({ timeout: 120_000 });

function frame(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  parent: string | null = null,
  order = "a0",
) {
  return {
    type: "core/frame",
    typeVersion: 1,
    parent,
    order,
    pos: { x, y, space: parent },
    rebase: null,
    size: { w, h },
    name,
    locked: false,
    rev: {},
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: { fill },
  };
}

/**
 * Three frames of 800 by 450 in plain colours, and a yellow frame in the
 * middle of the green one, as a fragment the basics' paste takes.
 */
const FRAGMENT = {
  elements: {
    red: frame("Red", 0, 0, 800, 450, "#ff0000", null, "a0"),
    green: frame("Green", 1000, 0, 800, 450, "#00ff00", null, "a1"),
    blue: frame("Blue", 0, 800, 800, 450, "#0000ff", null, "a2"),
    yellow: frame("Yellow", 300, 125, 200, 200, "#ffff00", "green", "a0"),
  },
  roots: ["red", "green", "blue"],
  stops: {},
  routes: {},
  fallbackViews: {},
  assets: {},
};

interface View {
  space: string | null;
  cx: number;
  cy: number;
  zoom: number;
}

type Picture =
  | { kind: "view"; view: View; hidden: Set<string> }
  | { kind: "blend"; from: { view: View }; to: { view: View }; mix: number };

interface DevPlayer {
  presentation: {
    state: {
      route: string | null;
      position: number;
      phase: string;
      reducedMotion: boolean;
      steps: { stop: string; name: string; entry: string }[];
    };
    picture(): Picture;
    moving: boolean;
  };
  stage: { screen: { width: number; height: number }; draw(picture: Picture): void };
}

interface DevEditor {
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  services: {
    selection: { set(ids: readonly string[]): void };
    camera: { set(view: View): void; fit(rect: unknown, space: string | null): void };
  };
  live: { children(parent: string | null): readonly string[] };
  scene: { offset(from: string | null, to: string | null): { x: number; y: number } };
  undo: { undoStack: unknown[] };
  presenting: DevPlayer | null;
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
      return (new Function(`return (${source as string})`)() as typeof fn)(
        editor,
        a as A,
      );
    },
    [fn.toString(), arg] as const,
  );
}

interface Made {
  /** The frames, by name. */
  frames: { red: string; green: string; blue: string; yellow: string };
  /** The main route: red, green, green with the yellow frame, blue. */
  main: string;
  /** A second route: green, red. */
  side: string;
  stops: string[];
}

/** Opens the page on an empty document and makes the frames, the stops and two routes. */
async function open(page: Page): Promise<{ made: Made; errors: string[] }> {
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
  await expect(page.locator(".galatsa-canvas")).toBeVisible();
  const made = await withEditor(
    page,
    (editor, fragment) => {
      const must = <R>(command: string, args?: unknown): R => {
        const outcome = editor.run(command, args);
        if (!outcome.ok) throw new Error(`${command} did not run`);
        return outcome.value as R;
      };
      const [red, green, blue] = must<{ ids: string[] }>("galatsa.basics/paste", {
        fragment,
      }).ids as [string, string, string];
      const yellow = editor.live.children(green)[0]!;
      type Added = { stop: string; route: string; entry: string };
      const first = must<Added[]>("galatsa.routes/add-stops-from-frames", {
        ids: [red, green],
      });
      const main = first[0]!.route;
      // A stop of the same view as the green frame's, where the yellow frame enters.
      editor.services.camera.set({ space: null, cx: 1400, cy: 225, zoom: 1.6 });
      const third = must<Added>("galatsa.routes/add-stop-from-view", { route: main });
      const last = must<Added[]>("galatsa.routes/add-stops-from-frames", {
        ids: [blue],
        route: main,
      });
      must("galatsa.routes/set-visibility", {
        stop: third.stop,
        ids: [yellow],
        action: "show",
      });
      must("galatsa.routes/set-stop-notes", {
        stop: first[1]!.stop,
        text: "Say why green matters.",
      });
      must("galatsa.routes/rename-stop", { stop: third.stop, name: "The yellow one" });
      must("galatsa.routes/rename-route", { route: main, name: "Long" });
      const side = must<string>("galatsa.routes/add-route", { name: "Short" });
      must("galatsa.routes/add-visit", { stop: first[1]!.stop, route: side });
      must("galatsa.routes/add-visit", { stop: first[0]!.stop, route: side });
      editor.services.selection.set([]);
      return {
        frames: { red, green, blue, yellow },
        main,
        side,
        stops: [first[0]!.stop, first[1]!.stop, third.stop, last[0]!.stop],
      };
    },
    FRAGMENT,
  );
  // The new route is the one shown; the long one is chosen in the panel, as a user would.
  await page.locator(".galatsa-canvas").focus();
  await page.keyboard.press("Shift+R");
  const panel = page.getByRole("complementary").filter({ hasText: "Routes" });
  await panel.getByRole("combobox", { name: "Route" }).selectOption({ label: "Long" });
  await page.keyboard.press("Shift+R");
  await expect(panel).toHaveCount(0);
  return { made, errors };
}

/** Runs `fn` with the running player. */
async function withPlayer<T, A>(
  page: Page,
  fn: (player: DevPlayer, arg: A) => T,
  arg: A,
): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const player = (
        window as unknown as { galatsaDev: { editor(): DevEditor | null } }
      ).galatsaDev.editor()?.presenting;
      if (!player) throw new Error("Not presenting");
      return (new Function(`return (${source as string})`)() as typeof fn)(
        player,
        a as A,
      );
    },
    [fn.toString(), arg] as const,
  );
}

const player = (page: Page) => page.locator(".galatsa-player");

/** Waits until the presentation shows step `position` (0 is the first) at rest. */
async function atStop(page: Page, position: number): Promise<void> {
  await expect(player(page)).toHaveAttribute("data-position", String(position));
  await expect(player(page)).toHaveAttribute("data-phase", "stop", { timeout: 15_000 });
}

/** The camera at rest. */
async function camera(page: Page): Promise<View> {
  return withPlayer(
    page,
    (p) => {
      const picture = p.presentation.picture();
      if (picture.kind !== "view") throw new Error("In a cross-fade");
      return picture.view;
    },
    null,
  );
}

/** The colour in the middle of the stage, as drawn on the canvas. */
async function middle(page: Page): Promise<string> {
  // Drawn in the next frame.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".galatsa-player .gp-stage canvas",
    )!;
    const data = canvas
      .getContext("2d")!
      .getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      ).data;
    return `#${[data[0]!, data[1]!, data[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  });
}

/** The camera that shows a rectangle filling the stage. */
async function fitted(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
): Promise<View> {
  const screen = await withPlayer(page, (p) => p.stage.screen, null);
  return {
    space: null,
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    zoom: Math.min(screen.width / rect.w, screen.height / rect.h),
  };
}

const RED = { x: 0, y: 0, w: 800, h: 450 };
const GREEN = { x: 1000, y: 0, w: 800, h: 450 };
const BLUE = { x: 0, y: 800, w: 800, h: 450 };

async function present(page: Page): Promise<void> {
  await page.locator(".galatsa-canvas").focus();
  await page.keyboard.press("F5");
  await expect(player(page)).toBeVisible();
  await atStop(page, 0);
}

async function fullscreen(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.fullscreenElement?.classList.contains("galatsa-player") ?? false,
  );
}

/** Ends the presentation with Escape: in full screen the first one only leaves full screen. */
async function end(page: Page): Promise<void> {
  if (await fullscreen(page)) {
    await page.keyboard.press("Escape");
    await expect.poll(() => fullscreen(page)).toBe(false);
    await expect(player(page)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(player(page)).toHaveCount(0);
}

test("F5 presents the open document; keys, clickers, jumps and routes; Escape ends it", async ({
  page,
}) => {
  const { made, errors } = await open(page);
  const undoSteps = await withEditor(page, (e) => e.undo.undoStack.length, null);
  await present(page);

  // Full screen, on the player; the first stop fills the stage.
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className ?? ""))
    .toContain("galatsa-player");
  await expect.poll(async () => camera(page)).toEqual(await fitted(page, RED));
  expect(await middle(page)).toBe("#ff0000");
  expect(await player(page).getAttribute("data-route")).toBe(made.main);

  // What clickers send: PageDown goes on.
  await page.keyboard.press("PageDown");
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));
  // The yellow frame enters at the next stop: hidden until then.
  expect(await middle(page)).toBe("#00ff00");
  await page.keyboard.press("ArrowRight");
  await atStop(page, 2);
  expect(await middle(page)).toBe("#ffff00");
  // The black screen of a clicker: B or the full stop; the next press lifts it
  // and moves nothing.
  await page.keyboard.press("b");
  await expect(page.locator(".gp-blank")).toBeVisible();
  await page.keyboard.press(".");
  await expect(page.locator(".gp-blank")).toBeHidden();
  await page.keyboard.press(".");
  await expect(page.locator(".gp-blank")).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect(page.locator(".gp-blank")).toBeHidden();
  await atStop(page, 2);
  // PageUp goes back; the state is that of the stop it comes to.
  await page.keyboard.press("PageUp");
  await atStop(page, 1);
  expect(await middle(page)).toBe("#00ff00");

  // A number and Enter, Home and End.
  await page.keyboard.press("4");
  await expect(page.locator(".gp-status")).toHaveText("Go to stop 4: press Enter");
  await page.keyboard.press("Enter");
  await atStop(page, 3);
  expect(await camera(page)).toEqual(await fitted(page, BLUE));
  expect(await middle(page)).toBe("#0000ff");
  await page.keyboard.press("Home");
  await atStop(page, 0);
  await page.keyboard.press("End");
  await atStop(page, 3);
  // After the last stop nothing happens.
  await page.keyboard.press("PageDown");
  await atStop(page, 3);

  // The list: jump to a stop, by its name (its own, or its frame's).
  await page.keyboard.press("g");
  const list = page.getByRole("dialog", { name: "Stops and routes" });
  await expect(list.getByRole("button")).toHaveText([
    "1. Red",
    "2. Green",
    "3. The yellow one",
    "4. Blue",
  ]);
  await expect(list.getByRole("button", { name: "4. Blue" })).toBeFocused();
  // Tab moves in the list; the clicker's keys drive the presentation, also here.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(list.getByRole("button", { name: "2. Green" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await atStop(page, 2);
  await expect(list.getByRole("button", { name: "2. Green" })).toBeFocused();
  await page.keyboard.press("PageDown");
  await atStop(page, 3);
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));

  // Another route that visits the stop shown: it goes on from there.
  await page.keyboard.press("g");
  const routes = list.getByRole("combobox", { name: "Route" });
  await routes.selectOption({ label: "Short" });
  await expect(player(page)).toHaveAttribute("data-route", made.side);
  await atStop(page, 0);
  await expect(list.getByRole("button")).toHaveText(["1. Green", "2. Red"]);
  // In the short route nothing brings the yellow frame in, so it is there from the start.
  expect(await middle(page)).toBe("#ffff00");
  // The route chosen has the keyboard: the clicker's keys still drive the
  // presentation, and never change the route.
  await routes.focus();
  await page.keyboard.press("PageDown");
  await atStop(page, 1);
  await page.keyboard.press("ArrowUp");
  await atStop(page, 0);
  await page.keyboard.press("ArrowDown");
  await atStop(page, 1);
  await page.keyboard.press("PageUp");
  await atStop(page, 0);
  await expect(player(page)).toHaveAttribute("data-route", made.side);
  await expect(routes).toHaveValue(made.side);
  // G closes the list again; the keys are the presentation's.
  await page.keyboard.press("g");
  await expect(list).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, RED));

  // Escape in full screen leaves full screen, and the presentation goes on in
  // the window, with a button back to full screen.
  expect(await fullscreen(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => fullscreen(page)).toBe(false);
  await expect(player(page)).toBeVisible();
  const back = page.getByRole("button", { name: "Back to full screen (F)" });
  await expect(back).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await atStop(page, 0);
  // Escape in the window ends it: the editor is back, with the keys, and
  // nothing was changed.
  await page.keyboard.press("Escape");
  await expect(player(page)).toHaveCount(0);
  await expect(page.locator(".galatsa-canvas")).toBeFocused();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await withEditor(page, (e) => e.presenting, null)).toBeNull();
  expect(await withEditor(page, (e) => e.undo.undoStack.length, null)).toBe(undoSteps);
  expect(errors).toEqual([]);
});

/** Starts noting, in every frame, the picture the player draws (its views in root space). */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      galatsaDev: { editor(): DevEditor | null };
      recorded: { t: number; picture: unknown }[];
      recording: boolean;
    };
    const editor = w.galatsaDev.editor()!;
    const presenting = editor.presenting!;
    const inRoot = (view: View): View => {
      const o = editor.scene.offset(view.space, null);
      return { space: null, cx: view.cx + o.x, cy: view.cy + o.y, zoom: view.zoom };
    };
    w.recorded = [];
    w.recording = true;
    const frame = (): void => {
      if (!w.recording) return;
      const picture = presenting.presentation.picture();
      w.recorded.push({
        t: performance.now(),
        picture:
          picture.kind === "view"
            ? { kind: "view", view: inRoot(picture.view) }
            : {
                kind: "blend",
                from: { view: inRoot(picture.from.view) },
                to: { view: inRoot(picture.to.view) },
                mix: picture.mix,
              },
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

interface Recorded {
  t: number;
  picture:
    | { kind: "view"; view: View }
    | { kind: "blend"; from: { view: View }; to: { view: View }; mix: number };
}

/** Stops noting, and returns what was noted. */
async function recorded(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => {
    const w = window as unknown as { recorded: Recorded[]; recording: boolean };
    w.recording = false;
    return w.recorded;
  });
}

/** A frame as the stage drew it: its views in root space, and colours read back from the canvas. */
interface Drawn extends Recorded {
  /** Points of the frames' plain colours, where the picture puts them, with the colour drawn there. */
  checks: { expected: string; drawn: string }[];
}

/**
 * Starts noting every picture the stage draws, as it draws it, and after
 * each a few points of the canvas: the middle of the red and the blue frame
 * and a corner of the green one, where the picture puts them (when they are
 * well inside the stage and the frame).
 */
async function recordDrawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      galatsaDev: { editor(): DevEditor | null };
      drawn: Drawn[];
      drawing: boolean;
      undraw?: () => void;
    };
    const editor = w.galatsaDev.editor()!;
    const stage = editor.presenting!.stage;
    const inRoot = (view: View): View => {
      const o = editor.scene.offset(view.space, null);
      return { space: null, cx: view.cx + o.x, cy: view.cy + o.y, zoom: view.zoom };
    };
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".galatsa-player .gp-stage canvas",
    )!;
    const ctx = canvas.getContext("2d")!;
    // Plain colours, a point and how far the frame reaches around it (world units).
    const points = [
      { x: 400, y: 225, reach: 225, expected: "#ff0000" },
      { x: 400, y: 1025, reach: 225, expected: "#0000ff" },
      { x: 1100, y: 75, reach: 75, expected: "#00ff00" },
    ];
    const original = stage.draw;
    w.drawn = [];
    w.drawing = true;
    stage.draw = (picture: Picture) => {
      original.call(stage, picture);
      if (!w.drawing) return;
      const { width, height } = stage.screen;
      const ratio = canvas.width / width;
      const checks: { expected: string; drawn: string }[] = [];
      if (picture.kind === "view") {
        const view = inRoot(picture.view);
        for (const p of points) {
          const sx = (p.x - view.cx) * view.zoom + width / 2;
          const sy = (p.y - view.cy) * view.zoom + height / 2;
          if (
            p.reach * view.zoom < 4 ||
            sx < 4 ||
            sy < 4 ||
            sx > width - 4 ||
            sy > height - 4
          )
            continue;
          const d = ctx.getImageData(
            Math.floor(sx * ratio),
            Math.floor(sy * ratio),
            1,
            1,
          ).data;
          const hex = (v: number): string => v.toString(16).padStart(2, "0");
          checks.push({
            expected: p.expected,
            drawn: `#${hex(d[0]!)}${hex(d[1]!)}${hex(d[2]!)}`,
          });
        }
      }
      w.drawn.push({
        t: performance.now(),
        picture:
          picture.kind === "view"
            ? { kind: "view", view: inRoot(picture.view) }
            : {
                kind: "blend",
                from: { view: inRoot(picture.from.view) },
                to: { view: inRoot(picture.to.view) },
                mix: picture.mix,
              },
        checks,
      });
    };
    w.undraw = () => {
      stage.draw = original;
    };
  });
}

/** Stops noting what is drawn, and returns it. */
async function drawn(page: Page): Promise<Drawn[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      drawn: Drawn[];
      drawing: boolean;
      undraw?: () => void;
    };
    w.drawing = false;
    w.undraw?.();
    return w.drawn;
  });
}

/**
 * The largest change between two frames, as a share of what the fastest
 * transition may change in the time between them. Two views: the distance
 * between the centres in screen widths plus the zoom between them (as a
 * natural logarithm). In a cross-fade: how much of the picture changed hands.
 * A flight moves at most 1.8 of that measure per second and a cross-fade at
 * most 2.3, so anything well above 1 here is a jump.
 */
function worstStep(
  frames: readonly Recorded[],
  width: number,
): { worst: number; at: readonly Recorded[] } {
  const gap = (a: View, b: View): number =>
    (Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.min(a.zoom, b.zoom)) / width +
    Math.abs(Math.log(b.zoom / a.zoom));
  const layers = (p: Recorded["picture"]): { view: View; weight: number }[] =>
    p.kind === "view"
      ? [{ view: p.view, weight: 1 }]
      : [
          { view: p.from.view, weight: 1 - p.mix },
          { view: p.to.view, weight: p.mix },
        ];
  let worst = 0;
  let at: Recorded[] = [];
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i]!.t - frames[i - 1]!.t;
    // A frame that came late says nothing about jumps.
    if (dt <= 0 || dt > 100) continue;
    const a = layers(frames[i - 1]!.picture);
    const b = layers(frames[i]!.picture);
    let change: number;
    if (a.length === 1 && b.length === 1) change = gap(a[0]!.view, b[0]!.view);
    else {
      // Views that stay keep their place; their weights change hands.
      let moved = 0;
      const used = new Set<number>();
      for (const p of a) {
        const at = b.findIndex((q, j) => !used.has(j) && gap(p.view, q.view) < 0.02);
        if (at < 0) moved += p.weight;
        else {
          used.add(at);
          moved += Math.abs(p.weight - b[at]!.weight) + gap(p.view, b[at]!.view);
        }
      }
      b.forEach((q, j) => {
        if (!used.has(j)) moved += q.weight;
      });
      change = moved / 2;
    }
    const share = change / (0.0035 * dt + 0.01);
    if (share > worst) {
      worst = share;
      at = [frames[i - 1]!, frames[i]!];
    }
  }
  return { worst, at };
}

async function phase(page: Page): Promise<string> {
  return (await player(page).getAttribute("data-phase")) ?? "";
}

/** Waits until the camera is at rest. */
async function still(page: Page): Promise<void> {
  await expect
    .poll(() => withPlayer(page, (p) => p.presentation.moving, null), { timeout: 15_000 })
    .toBe(false);
}

test("input in the middle of a transition is obeyed without a jump; roaming pauses the route", async ({
  page,
}) => {
  const { errors } = await open(page);
  await present(page);
  const screen = await withPlayer(page, (p) => p.stage.screen, null);
  await recordDrawn(page);

  // Keys in the middle of transitions: each is obeyed, from what is on screen.
  await page.keyboard.press("ArrowRight");
  await expect(player(page)).toHaveAttribute("data-phase", "moving");
  await page.waitForTimeout(250);
  expect(await phase(page)).toBe("moving");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await page.keyboard.press("m");
  await page.waitForTimeout(150);
  await page.keyboard.press("m");
  await page.waitForTimeout(200);
  await page.keyboard.press("Home");
  await page.waitForTimeout(150);
  await page.keyboard.press("PageDown");
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));
  // Nothing jumped in what the stage drew, whatever was pressed; and the
  // canvas shows what the stage was given: the frames' colours are where
  // the pictures put them.
  const pressed = await drawn(page);
  expect(pressed.length).toBeGreaterThan(60);
  const views = new Set(
    pressed.map((f) =>
      JSON.stringify(f.picture.kind === "view" ? f.picture.view : f.picture.to.view),
    ),
  );
  // The camera really moved: many different pictures, not a few.
  expect(views.size).toBeGreaterThan(30);
  const { worst, at } = worstStep(pressed, screen.width);
  expect(worst, JSON.stringify(at)).toBeLessThan(1.5);
  const checks = pressed.flatMap((f) => f.checks);
  expect(checks.length).toBeGreaterThan(30);
  const wrong = checks.filter((c) => c.drawn !== c.expected);
  expect(wrong, JSON.stringify(wrong.slice(0, 5))).toEqual([]);

  // The mouse takes the camera in the middle of a flight: the route is paused
  // at the stop shown last, and the camera comes to rest.
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(250);
  expect(await phase(page)).toBe("moving");
  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(680, 330, { steps: 4 });
  await expect(player(page)).toHaveAttribute("data-phase", "roaming");
  await expect(player(page)).toHaveAttribute("data-position", "1");
  await expect(page.locator(".gp-status")).toHaveText(
    "The route is paused. Backspace goes back to the stop.",
  );
  await page.mouse.move(700, 340, { steps: 2 });
  await page.mouse.up();
  await still(page);
  const roamed = await camera(page);
  expect(roamed).not.toEqual(await fitted(page, GREEN));
  // One key back to the stop.
  await page.keyboard.press("Backspace");
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));

  // The wheel moves the canvas, and zooms with Ctrl; "next" goes on from the route.
  await page.mouse.wheel(0, 240);
  await expect(player(page)).toHaveAttribute("data-phase", "roaming");
  const scrolled = await camera(page);
  expect(scrolled.cy).toBeGreaterThan(225);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  expect((await camera(page)).zoom).toBeGreaterThan(scrolled.zoom);
  await page.keyboard.press("PageDown");
  await atStop(page, 2);

  // A click goes on; a drag does not.
  await page.mouse.click(640, 300);
  await atStop(page, 3);
  expect(await camera(page)).toEqual(await fitted(page, BLUE));

  // The controls: they come when the mouse moves.
  await page.mouse.move(640, 320);
  await page.mouse.move(644, 324);
  const bar = page.getByRole("toolbar", { name: "Presentation" });
  await bar.getByRole("button", { name: "Previous" }).click();
  await atStop(page, 2);
  await expect(bar.getByRole("button", { name: "Stops and routes" })).toHaveText(
    "3 of 4",
  );

  // Reduced motion: the camera does not move; the pictures fade into each other.
  await bar.getByRole("button", { name: "Reduced motion" }).click();
  await expect(bar.getByRole("button", { name: "Reduced motion" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".gp-status")).toHaveText("Reduced motion is on");
  await record(page);
  // The still layer's opacity, in every frame while it is there.
  const opacities = page.evaluate(
    () =>
      new Promise<number[]>((done) => {
        const seen: number[] = [];
        let started = false;
        const frame = (): void => {
          const layer = document.querySelector<HTMLElement>(".galatsa-player .gp-fade");
          const showing =
            layer !== null && !layer.hidden && layer.style.display !== "none";
          if (showing) {
            started = true;
            seen.push(Number(getComputedStyle(layer).opacity));
          } else if (started || seen.length > 600) {
            done(seen);
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  await page.keyboard.press("Home");
  await expect(page.locator(".gp-fade")).toBeVisible();
  await atStop(page, 0);
  // The layer faded: it was seen part of the way, and its opacity only went one way.
  const seen = await opacities;
  expect(
    seen.some((o) => o > 0.05 && o < 0.95),
    JSON.stringify(seen),
  ).toBe(true);
  const rising = seen.every((o, i) => i === 0 || o >= seen[i - 1]! - 1e-6);
  const falling = seen.every((o, i) => i === 0 || o <= seen[i - 1]! + 1e-6);
  expect(rising || falling, JSON.stringify(seen)).toBe(true);
  await expect(page.locator(".gp-fade")).toBeHidden();
  expect(await middle(page)).toBe("#ff0000");

  // Only the two views of the fade were shown, and the fade did not jump.
  const faded = await recorded(page);
  expect(faded.length).toBeGreaterThan(10);
  expect(
    worstStep(faded, screen.width).worst,
    JSON.stringify(worstStep(faded, screen.width).at),
  ).toBeLessThan(1.5);
  const fitRed = await fitted(page, RED);
  const shown = new Set<string>();
  const key = (view: View): string =>
    [view.cx, view.cy, view.zoom].map((n) => n.toFixed(6)).join(" ");
  for (const frame of faded) {
    const views =
      frame.picture.kind === "view"
        ? [frame.picture.view]
        : [frame.picture.from.view, frame.picture.to.view];
    for (const view of views) shown.add(key(view));
  }
  expect(shown.size).toBe(2);
  expect(shown.has(key(fitRed))).toBe(true);

  await end(page);
  expect(errors).toEqual([]);
});

/** Sends a touch pointer event to the stage. */
async function touch(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  id: number,
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ([kind, pointerId, clientX, clientY]) => {
      document.querySelector(".galatsa-player .gp-stage")!.dispatchEvent(
        new PointerEvent(kind as string, {
          pointerId: pointerId as number,
          pointerType: "touch",
          isPrimary: pointerId === 11,
          clientX: clientX as number,
          clientY: clientY as number,
          button: 0,
          buttons: kind === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [type, id, x, y] as const,
  );
}

test("the panel's button and Shift+F5, the laser pointer, touch, and the notes in a window of their own", async ({
  page,
}) => {
  const { errors } = await open(page);

  // The routes panel: the second stop is chosen, and "Present" starts there.
  await page.locator(".galatsa-canvas").focus();
  await page.keyboard.press("Shift+R");
  const panel = page.getByRole("complementary").filter({ hasText: "Routes" });
  await panel
    .getByRole("list", { name: "Stops in the route" })
    .getByRole("button", { name: "Green" })
    .click();
  await panel.getByRole("button", { name: "Present" }).click();
  await expect(player(page)).toBeVisible();
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));
  await end(page);
  await expect(page.locator(".galatsa-canvas")).toBeFocused();
  // Shift+F5 does the same from the keyboard; F5 starts from the first stop.
  // (Started right after the last one ended: it stays.)
  await page.keyboard.press("Shift+F5");
  await expect(player(page)).toBeVisible();
  await atStop(page, 1);
  await page.waitForTimeout(500);
  await expect(player(page)).toBeVisible();
  const { width, height } = await withPlayer(page, (p) => p.stage.screen, null);

  // The laser pointer follows the mouse; with it out, a drag points and does
  // not move the canvas.
  await page.keyboard.press("l");
  await expect(page.locator(".gp-status")).toHaveText("The laser pointer is on");
  await page.mouse.move(500, 300);
  const dot = page.locator(".gp-laser");
  await expect(dot).toBeVisible();
  const box = (await dot.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 500)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - 300)).toBeLessThan(2);
  await page.mouse.down();
  await page.mouse.move(600, 360, { steps: 4 });
  await page.mouse.up();
  expect(await phase(page)).toBe("stop");
  expect(await camera(page)).toEqual(await fitted(page, GREEN));
  const moved = (await dot.boundingBox())!;
  expect(Math.abs(moved.x + moved.width / 2 - 600)).toBeLessThan(2);
  await page.keyboard.press("l");
  await expect(dot).toBeHidden();
  await expect(page.locator(".gp-status")).toHaveText("The laser pointer is off");

  // Touch: a tap goes on, a tap in the left quarter goes back, two fingers
  // move and zoom the canvas.
  await touch(page, "pointerdown", 11, width * 0.7, height * 0.5);
  await touch(page, "pointerup", 11, width * 0.7, height * 0.5);
  await atStop(page, 2);
  await touch(page, "pointerdown", 11, width * 0.1, height * 0.5);
  await touch(page, "pointerup", 11, width * 0.1, height * 0.5);
  await atStop(page, 1);
  const before = await camera(page);
  await touch(page, "pointerdown", 11, width * 0.4, height * 0.5);
  await touch(page, "pointerdown", 12, width * 0.6, height * 0.5);
  await touch(page, "pointermove", 12, width * 0.8, height * 0.5);
  await touch(page, "pointermove", 11, width * 0.2, height * 0.5);
  await touch(page, "pointerup", 12, width * 0.8, height * 0.5);
  await touch(page, "pointerup", 11, width * 0.2, height * 0.5);
  await expect(player(page)).toHaveAttribute("data-phase", "roaming");
  const pinched = await camera(page);
  // The fingers went from a fifth of the width apart to three fifths, about
  // the middle of the stage. (The camera is now anchored in the frame it is over.)
  expect(pinched.zoom / before.zoom).toBeCloseTo(3, 6);
  const offset = await withEditor(
    page,
    (editor, space) => editor.scene.offset(space, null),
    pinched.space,
  );
  expect(pinched.cx + offset.x).toBeCloseTo(before.cx, 6);
  expect(pinched.cy + offset.y).toBeCloseTo(before.cy, 6);
  // Still at the second stop: lifting the fingers was not a tap.
  await expect(player(page)).toHaveAttribute("data-position", "1");
  await page.keyboard.press("Backspace");
  await atStop(page, 1);

  // The notes, in a window of their own.
  const opening = page.waitForEvent("popup");
  await page.keyboard.press("s");
  const notes = await opening;
  await expect(notes).toHaveTitle("Presenter notes");
  await expect(notes.locator(".gn-where")).toHaveText("2 of 4 · Green");
  await expect(notes.locator(".gn-text")).toHaveText("Say why green matters.");
  await expect(notes.locator(".gn-next")).toHaveText("Next: The yellow one");
  await expect(notes.locator(".gn-clock")).toHaveText(/\d{1,2}[:.]\d{2}[:.]\d{2}/);
  await expect(notes.locator(".gn-elapsed")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(notes.locator(".gn-paused")).toBeHidden();
  // The presentation goes on behind it (out of full screen, if the browser left it).
  await expect(player(page)).toBeVisible();
  // The notes window can drive the presentation, with its buttons and its keys.
  await notes.getByRole("button", { name: "Next" }).click();
  await atStop(page, 2);
  await expect(notes.locator(".gn-where")).toHaveText("3 of 4 · The yellow one");
  await expect(notes.locator(".gn-text")).toHaveText("No notes for this stop.");
  await expect(notes.locator(".gn-next")).toHaveText("Next: Blue");
  await notes.keyboard.press("PageDown");
  await atStop(page, 3);
  await expect(notes.locator(".gn-next")).toHaveText("This is the last stop.");
  await expect(notes.getByRole("button", { name: "Next" })).toBeDisabled();
  await notes.keyboard.press("PageUp");
  await atStop(page, 2);
  // Roaming shows there too.
  await page.mouse.wheel(0, 120);
  await expect(notes.locator(".gn-paused")).toHaveText("Paused, away from the route");
  await notes.getByRole("button", { name: "Back to the stop" }).click();
  await atStop(page, 2);
  await expect(notes.locator(".gn-paused")).toBeHidden();
  // The time used runs, and can be set back.
  await expect(notes.locator(".gn-elapsed")).not.toHaveText("00:00", { timeout: 10_000 });
  await notes.getByRole("button", { name: "Reset the time" }).click();
  await expect(notes.locator(".gn-elapsed")).toHaveText("00:00");

  // Closing the window closes the notes; they open again, and go with the presentation.
  const toggle = page.getByRole("button", { name: "Notes" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await notes.close();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(player(page)).toBeVisible();
  const again = page.waitForEvent("popup");
  await page.keyboard.press("s");
  const second = await again;
  await expect(second.locator(".gn-where")).toHaveText("3 of 4 · The yellow one");
  await page.keyboard.press("Escape");
  await expect(player(page)).toHaveCount(0);
  await expect.poll(() => second.isClosed()).toBe(true);
  await expect(page.locator(".galatsa-canvas")).toBeFocused();
  expect(errors).toEqual([]);
});

test("the player keeps the keyboard out of full screen: Tab, then the clicker, Escape and Delete; no reload", async ({
  page,
}) => {
  const { errors } = await open(page);
  const undoSteps = await withEditor(page, (e) => e.undo.undoStack.length, null);
  await present(page);
  // Out of full screen by the player's own key: no button back.
  await page.keyboard.press("f");
  await expect.poll(() => fullscreen(page)).toBe(false);
  await expect(player(page)).toBeVisible();
  await expect(page.locator(".gp-full-back")).toBeHidden();

  // The editor under the player is inert while it runs.
  expect(
    await page.evaluate(
      () => document.querySelector(".galatsa-canvas")!.closest("[inert]") !== null,
    ),
  ).toBe(true);
  // Tab, many times and both ways: the keyboard stays in the player.
  const inPlayer = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return (
        active !== null && document.querySelector(".galatsa-player")!.contains(active)
      );
    });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await inPlayer()).toBe(true);
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inPlayer()).toBe(true);
  }
  // Wherever Tab left the keyboard, the clicker goes on.
  await page.keyboard.press("PageDown");
  await atStop(page, 1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("PageDown");
  await atStop(page, 2);
  // Delete changes nothing in the document under the player.
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  expect(await withEditor(page, (e) => e.undo.undoStack.length, null)).toBe(undoSteps);

  // Keys that reload the page are kept from the browser.
  await page.evaluate(() => {
    const w = window as unknown as { reloads: boolean[] };
    w.reloads = [];
    window.addEventListener("keydown", (e) => {
      if (e.key === "F5" || e.key.toLowerCase() === "r")
        w.reloads.push(e.defaultPrevented);
    });
  });
  await page.keyboard.press("F5");
  await page.keyboard.press("Shift+F5");
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Control+Shift+R");
  expect(
    await page.evaluate(() => (window as unknown as { reloads: boolean[] }).reloads),
  ).toEqual([true, true, true, true]);
  await expect(player(page)).toBeVisible();
  await atStop(page, 2);

  // Escape in the window ends the presentation; the editor gets the keys back.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(player(page)).toHaveCount(0);
  await expect(page.locator(".galatsa-canvas")).toBeFocused();
  expect(
    await page.evaluate(() =>
      document.querySelector(".galatsa-canvas")!.closest("[inert]"),
    ),
  ).toBeNull();
  expect(await withEditor(page, (e) => e.undo.undoStack.length, null)).toBe(undoSteps);
  expect(errors).toEqual([]);
});

test("losing full screen goes on in the window with a button back; the black screen, the list and the notes window", async ({
  page,
}) => {
  const { errors } = await open(page);
  await present(page);
  expect(await fullscreen(page)).toBe(true);

  // Full screen is lost without the player asking (a cable, another screen):
  // the presentation goes on in the window, and a button takes it back.
  await page.evaluate(() => void document.exitFullscreen());
  await expect.poll(() => fullscreen(page)).toBe(false);
  await expect(player(page)).toBeVisible();
  const back = page.getByRole("button", { name: "Back to full screen (F)" });
  await expect(back).toBeVisible();
  await page.keyboard.press("PageDown");
  await atStop(page, 1);
  await back.click();
  await expect.poll(() => fullscreen(page)).toBe(true);
  await expect(back).toBeHidden();
  await expect(player(page)).toBeFocused();

  // The black screen: a click lifts it and does nothing else; a stop's number
  // and Enter lift it and go there.
  await page.keyboard.press("b");
  const blank = page.locator(".gp-blank");
  await expect(blank).toBeVisible();
  await page.mouse.click(640, 300);
  await expect(blank).toBeHidden();
  await atStop(page, 1);
  await page.keyboard.press("b");
  await expect(blank).toBeVisible();
  await page.keyboard.press("4");
  await page.keyboard.press("Enter");
  await expect(blank).toBeHidden();
  await atStop(page, 3);

  // In the list, the keyboard stays with the stop it was on when the route changes.
  await page.keyboard.press("g");
  const list = page.getByRole("dialog", { name: "Stops and routes" });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(list.getByRole("button", { name: "2. Green" })).toBeFocused();
  const steps = await withPlayer(page, (p) => p.presentation.state.steps, null);
  const outcome = await withEditor(
    page,
    (editor, a) => editor.run("galatsa.routes/move-visit", a).ok,
    {
      route: await player(page).getAttribute("data-route"),
      entry: steps[3]!.entry,
      index: 0,
    },
  );
  expect(outcome).toBe(true);
  await expect(list.getByRole("button")).toHaveText([
    "1. Blue",
    "2. Red",
    "3. Green",
    "4. The yellow one",
  ]);
  await expect(list.getByRole("button", { name: "3. Green" })).toBeFocused();
  await page.keyboard.press("g");
  await expect(list).toBeHidden();

  // The notes window goes when the page is reloaded.
  const opening = page.waitForEvent("popup");
  await page.keyboard.press("s");
  const notes = await opening;
  await expect(notes).toHaveTitle("Presenter notes");
  await page.reload();
  await expect.poll(() => notes.isClosed()).toBe(true);
  expect(errors).toEqual([]);
});
