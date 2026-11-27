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
// the presenter's notes open in a window of their own; Escape ends the
// presentation and gives the keys back to the editor. Runs in the "chromium"
// and "editor-firefox" projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?scene=empty&lang=en`;

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
      steps: { stop: string; name: string }[];
    };
    picture(): Picture;
    moving: boolean;
  };
  stage: { screen: { width: number; height: number } };
}

interface DevEditor {
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  services: {
    selection: { set(ids: readonly string[]): void };
    camera: { set(view: View): void; fit(rect: unknown, space: string | null): void };
  };
  live: { children(parent: string | null): readonly string[] };
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
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("button", { name: "2. Green" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, GREEN));

  // Another route that visits the stop shown: it goes on from there.
  await page.keyboard.press("g");
  await list.getByRole("combobox", { name: "Route" }).selectOption({ label: "Short" });
  await expect(player(page)).toHaveAttribute("data-route", made.side);
  await atStop(page, 0);
  await expect(list.getByRole("button")).toHaveText(["1. Green", "2. Red"]);
  // In the short route nothing brings the yellow frame in, so it is there from the start.
  expect(await middle(page)).toBe("#ffff00");
  // G closes the list again; the keys are the presentation's.
  await page.keyboard.press("g");
  await expect(list).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await atStop(page, 1);
  expect(await camera(page)).toEqual(await fitted(page, RED));

  // Escape ends it: the editor is back, with the keys, and nothing was changed.
  await page.keyboard.press("Escape");
  await expect(player(page)).toHaveCount(0);
  await expect(page.locator(".galatsa-canvas")).toBeFocused();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await withEditor(page, (e) => e.presenting, null)).toBeNull();
  expect(await withEditor(page, (e) => e.undo.undoStack.length, null)).toBe(undoSteps);
  expect(errors).toEqual([]);
});
