// SPDX-License-Identifier: GPL-3.0-or-later

// The state of a presentation and its camera: route, pause, roaming, back and
// jumps, with input at any time, also in the middle of a transition. See
// docs/adr/0015-presentation.md.

import {
  hiddenAt,
  MAX_ZOOM,
  maxPreciseZoom,
  stopRegion,
  type CameraView,
} from "@galatsa/core";
import {
  contributionId,
  defineTransition,
  type AnyTransition,
} from "@galatsa/extension-api";
import {
  BRAKE_DURATION,
  cut,
  fade,
  fly,
  TRANSITIONS_EXTENSION_ID,
} from "@galatsa/extension-transitions";
import { describe, expect, it } from "vitest";
import { sameView, sourceFromSnapshot, viewOfRegion } from "./model.ts";
import type { Picture } from "./playback.ts";
import { Presentation, type PresentationOptions } from "./presentation.ts";
import { MIN_STEER_MS } from "./steer.ts";
import {
  element,
  frame,
  inRoot,
  pictureGap,
  rect,
  route,
  seeded,
  stop,
  testClock,
  transition,
  usable,
  viewGap,
  type TestDocument,
} from "./test-support.ts";

const SCREEN = { width: 1280, height: 720 };
const FAR = 2 ** 40;
const FLY = contributionId(TRANSITIONS_EXTENSION_ID, fly.name);
const FADE = contributionId(TRANSITIONS_EXTENSION_ID, fade.name);
const CUT = contributionId(TRANSITIONS_EXTENSION_ID, cut.name);

const failing = defineTransition<null>({
  name: "failing",
  label: "test:failing",
  read: () => null,
  plan: () => {
    throw new Error("cannot plan");
  },
});
const stumbling = defineTransition<null>({
  name: "stumbling",
  label: "test:stumbling",
  read: () => null,
  plan: () => ({
    duration: 1000,
    frame: () => {
      throw new Error("cannot draw");
    },
  }),
});

const TRANSITIONS = new Map<string, AnyTransition>([
  [FLY, fly as AnyTransition],
  [FADE, fade as AnyTransition],
  [CUT, cut as AnyTransition],
  ["test/failing", failing as AnyTransition],
  ["test/stumbling", stumbling as AnyTransition],
]);

/** Seven stops on a main route, a side route that shares two of them, and an empty route. */
function document(): TestDocument {
  return {
    elements: {
      fA: frame(0, 0, 1600, 900, null, { name: "Opening" }),
      fB: frame(3000, 500, 800, 450),
      fC: frame(FAR, 0, 1600, 900),
      fD: frame(100, 100, 160, 90, "fC"),
      box: element({ pos: { x: 50, y: 50, space: null } }),
      chart: element({ parent: "fA", pos: { x: 20, y: 20, space: "fA" } }),
    },
    stops: {
      s0: stop({ kind: "frame", frame: "fA", padding: 0 }),
      s1: stop(rect(400, 200, 800, 450), { name: "Detail" }),
      s2: stop(
        { kind: "frame", frame: "fB", padding: 0 },
        { transition: transition(FADE) },
      ),
      s3: stop(rect(100, 100, 160, 90, "fB"), {
        visibility: { chart: { action: "show" } },
        notes: { $y: "text", delta: [{ insert: "Say " }, { insert: "hello" }] },
      }),
      s4: stop(rect(0, 0, 1600, 900, "fC")),
      s5: stop({ kind: "frame", frame: "fD", padding: 0 }),
      s6: stop(rect(-2000, -1000, 3200, 1800), {
        visibility: { box: { action: "hide" } },
      }),
    },
    routes: {
      main: route(["s0", "s1", "s2", "s3", "s4", "s5", "s6"], "a0"),
      side: route(["s2", "s6", "s0"], "a1"),
      empty: route([], "a2"),
    },
  };
}

function setup(
  doc: TestDocument = document(),
  options: Partial<PresentationOptions> = {},
) {
  const clock = testClock();
  const source = sourceFromSnapshot(doc);
  const p = new Presentation({
    source,
    screen: SCREEN,
    now: clock.now,
    transitions: (id) => TRANSITIONS.get(id),
    ...options,
  });
  /** The view of a stop at rest, in its own space. */
  const viewOf = (stopId: string, screen = SCREEN): CameraView =>
    viewOfRegion(stopRegion(doc, source.resolver, stopId)!, screen);
  /** Lets time pass in small steps, checking that the picture never jumps. */
  const run = (ms: number, step = 5): Picture => {
    let last = p.picture();
    for (let t = 0; t < ms; t += step) {
      clock.advance(Math.min(step, ms - t));
      const next = p.picture();
      expect(usable(next)).toBe(true);
      const { gap } = pictureGap(source.resolver, last, next, SCREEN.width);
      expect(gap).toBeLessThan(MAX_STEP);
      last = next;
    }
    return last;
  };
  return { doc, clock, source, p, viewOf, run };
}

/**
 * The most a picture may change in 5 ms. A flight at its peak moves 0.85
 * units of the metric of van Wijk and Nuij per second, which is at most 0.009
 * of the measure used here per 5 ms; a cross-fade's mix changes by at most
 * 0.011 per 5 ms at its steepest.
 */
const MAX_STEP = 0.03;

/** Long enough for any transition to end (the longest flight is 4.2 s, a fade 0.7 s). */
const LONG = 8000;

function single(picture: Picture): CameraView {
  expect(picture.kind).toBe("view");
  return (picture as Extract<Picture, { kind: "view" }>).view;
}

describe("a route", () => {
  it("starts at the first stop of the first route, fitted to the screen", () => {
    const { p, doc } = setup();
    expect(p.state.route).toBe("main");
    expect(p.state.routes.map((r) => r.id)).toEqual(["main", "side", "empty"]);
    expect(p.state.steps.map((s) => s.stop)).toEqual(Object.keys(doc.stops));
    expect(p.state.position).toBe(0);
    expect(p.state.phase).toBe("stop");
    expect(p.moving).toBe(false);
    // The frame is 1600 by 900 and the screen 1280 by 720: it fills the screen.
    expect(single(p.picture())).toEqual({ space: null, cx: 800, cy: 450, zoom: 0.8 });
  });

  it("names a stop by its own name, else by its frame's, and reads notes as text", () => {
    const { p } = setup();
    expect(p.state.steps.map((s) => s.name)).toEqual([
      "Opening",
      "Detail",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(p.state.steps[3]!.notes).toBe("Say hello");
  });

  it("starts at a given step of a given route", () => {
    const { p, viewOf } = setup(document(), { route: "side", step: 1 });
    expect(p.state.route).toBe("side");
    expect(p.state.position).toBe(1);
    expect(single(p.picture())).toEqual(viewOf("s6"));
    // A step that is not there is the nearest one; a route that is not, the first.
    expect(setup(document(), { step: 99 }).p.state.position).toBe(6);
    expect(setup(document(), { route: "gone" }).p.state.route).toBe("main");
  });

  it("goes to the next stop along its transition and arrives exactly", () => {
    const { p, run, viewOf, clock } = setup();
    let changes = 0;
    p.subscribe(() => changes++);
    p.next();
    expect(p.state.phase).toBe("moving");
    expect(p.state.position).toBe(1);
    expect(p.moving).toBe(true);
    expect(changes).toBe(1);
    clock.advance(200);
    // On its way: neither the start nor the goal.
    const under = single(p.picture());
    expect(under.zoom).toBeGreaterThan(0.8);
    expect(under.zoom).toBeLessThan(1.6);
    expect(single(run(LONG))).toEqual(viewOf("s1"));
    expect(p.state.phase).toBe("stop");
    expect(p.moving).toBe(false);
    expect(changes).toBe(2);
  });

  it("goes back, and stays at the ends of the route", () => {
    const { p, run, viewOf } = setup();
    p.previous();
    expect(p.state.phase).toBe("stop");
    expect(p.state.position).toBe(0);
    p.next();
    run(LONG);
    p.previous();
    expect(p.state.position).toBe(0);
    expect(single(run(LONG))).toEqual(viewOf("s0"));
    p.goTo(6);
    run(LONG);
    expect(p.state.position).toBe(6);
    // After the last stop: nothing happens.
    p.next();
    expect(p.state.phase).toBe("stop");
    expect(p.state.position).toBe(6);
    expect(single(p.picture())).toEqual(viewOf("s6"));
  });

  it("counts every press: two quick presses go two stops on", () => {
    const { p, run, viewOf, clock } = setup();
    p.next();
    clock.advance(150);
    p.next();
    expect(p.state.position).toBe(2);
    clock.advance(150);
    p.previous();
    expect(p.state.position).toBe(1);
    expect(single(run(LONG))).toEqual(viewOf("s1"));
    expect(p.state.phase).toBe("stop");
  });

  it("arrives in the stop's own space, however far from the root", () => {
    const { p, run, viewOf } = setup();
    p.goTo(3);
    const at = single(run(LONG));
    expect(at.space).toBe("fB");
    expect(at).toEqual(viewOf("s3"));
    p.goTo(4);
    run(LONG);
    p.next();
    // Between two stops in the far frame the flight is planned in that frame's
    // space, so its numbers stay small.
    for (let i = 0; i < 40; i++) {
      const picture = run(50);
      const view = picture.kind === "view" ? picture.view : picture.to.view;
      expect(view.space).toBe("fC");
      expect(Math.abs(view.cx)).toBeLessThan(2000);
    }
    expect(single(run(LONG))).toEqual(viewOf("s5"));
    expect(viewOf("s5").space).toBe("fC");
    expect(viewOf("s4").space).toBe("fC");
  });

  it("jumps to a stop, and ignores a stop that is not there", () => {
    const { p, run, viewOf } = setup();
    p.goTo(5);
    expect(p.state.position).toBe(5);
    expect(single(run(LONG))).toEqual(viewOf("s5"));
    for (const index of [-1, 7, 2.5, Number.NaN]) p.goTo(index);
    expect(p.state.position).toBe(5);
    expect(p.state.phase).toBe("stop");
  });

  it("cuts where the stop asks for a cut", () => {
    const doc = document();
    doc.stops["s1"]!.transition = transition(CUT);
    const { p, viewOf } = setup(doc);
    p.next();
    expect(p.state.phase).toBe("stop");
    expect(single(p.picture())).toEqual(viewOf("s1"));
  });

  it("flies where the stop names a transition nobody knows", () => {
    const doc = document();
    doc.stops["s1"]!.transition = transition("other.extension/spin");
    const { p, run, viewOf } = setup(doc);
    p.next();
    expect(p.state.phase).toBe("moving");
    expect(single(run(LONG))).toEqual(viewOf("s1"));
  });

  it("shows the goal when a transition cannot plan or cannot draw", () => {
    for (const type of ["test/failing", "test/stumbling"]) {
      const doc = document();
      doc.stops["s1"]!.transition = transition(type);
      const { p, viewOf, clock } = setup(doc);
      p.next();
      clock.advance(10);
      const picture = p.picture();
      expect(usable(picture)).toBe(true);
      clock.advance(2000);
      expect(single(p.picture())).toEqual(viewOf("s1"));
      expect(p.state.phase).toBe("stop");
    }
  });
});

describe("what a stop shows and hides", () => {
  it("applies the changes on arrival, counted from the start of the route", () => {
    const { p, run, doc } = setup();
    const at = (index: number) => [...hiddenAt(doc, "main", index)].sort();
    // The chart enters at the fourth stop: hidden until then.
    expect(hiddenOf(p.picture())).toEqual(at(0));
    expect(at(0)).toEqual(["chart"]);
    p.goTo(3);
    // During the flight what the last stop showed stays.
    for (let i = 0; i < 10; i++) {
      const picture = run(20);
      if (p.state.phase === "moving" && picture.kind === "view")
        expect(hiddenOf(picture)).toEqual(["chart"]);
    }
    run(LONG);
    expect(hiddenOf(p.picture())).toEqual([]);
    p.goTo(6);
    run(LONG);
    expect(hiddenOf(p.picture())).toEqual(["box"]);
    // A jump back computes the state from the start.
    p.goTo(1);
    run(LONG);
    expect(hiddenOf(p.picture())).toEqual(["chart"]);
  });

  it("fades into what the goal shows in a cross-fade", () => {
    const doc = document();
    doc.stops["s3"]!.transition = transition(FADE);
    const { p, run, clock } = setup(doc);
    p.goTo(2);
    run(LONG);
    p.next();
    clock.advance(300);
    const picture = p.picture();
    expect(picture.kind).toBe("blend");
    if (picture.kind !== "blend") return;
    expect([...picture.from.hidden]).toEqual(["chart"]);
    expect([...picture.to.hidden]).toEqual([]);
    run(LONG);
    expect(hiddenOf(p.picture())).toEqual([]);
  });

  it("keeps the last stop's state while roaming", () => {
    const { p, run } = setup();
    p.goTo(6);
    run(LONG);
    p.pan(300, 0);
    run(1000);
    expect(hiddenOf(p.picture())).toEqual(["box"]);
  });
});

function hiddenOf(picture: Picture): string[] {
  expect(picture.kind).toBe("view");
  return picture.kind === "view" ? [...picture.hidden].sort() : [];
}

describe("free roaming", () => {
  it("pauses the route; back returns to the stop, exactly", () => {
    const { p, run, viewOf } = setup();
    p.next();
    run(LONG);
    p.pan(100, -40);
    expect(p.state.phase).toBe("roaming");
    expect(p.state.position).toBe(1);
    const moved = single(p.picture());
    const home = viewOf("s1");
    expect(moved.cx).toBeCloseTo(home.cx - 100 / home.zoom, 9);
    expect(moved.cy).toBeCloseTo(home.cy + 40 / home.zoom, 9);
    p.back();
    expect(p.state.phase).toBe("moving");
    expect(single(run(LONG))).toEqual(home);
    expect(p.state.phase).toBe("stop");
    expect(p.state.position).toBe(1);
    // At the stop, back does nothing.
    p.back();
    expect(p.state.phase).toBe("stop");
  });

  it("goes on from where the route was left: next is the stop after the last one shown", () => {
    const { p, run, viewOf } = setup();
    p.next();
    run(LONG);
    p.zoomAt({ x: 200, y: 100 }, 3);
    p.pan(-500, 80);
    p.next();
    expect(p.state.position).toBe(2);
    expect(single(run(LONG))).toEqual(viewOf("s2"));
    // "Previous" while roaming returns to the stop shown last.
    p.pan(10, 10);
    p.previous();
    expect(p.state.position).toBe(2);
    expect(single(run(LONG))).toEqual(viewOf("s2"));
    // After the route's last stop, "next" while roaming returns to it.
    p.goTo(6);
    run(LONG);
    p.pan(50, 0);
    p.next();
    expect(p.state.position).toBe(6);
    expect(single(run(LONG))).toEqual(viewOf("s6"));
  });

  it("keeps the point under the pointer when zooming", () => {
    const { p, source } = setup();
    const before = inRoot(source.resolver, single(p.picture()));
    const at = { x: 1000, y: 200 };
    const world = {
      x: before.cx + (at.x - SCREEN.width / 2) / before.zoom,
      y: before.cy + (at.y - SCREEN.height / 2) / before.zoom,
    };
    p.zoomAt(at, 4);
    const after = inRoot(source.resolver, single(p.picture()));
    expect(after.zoom).toBeCloseTo(before.zoom * 4, 12);
    expect((world.x - after.cx) * after.zoom + SCREEN.width / 2).toBeCloseTo(at.x, 6);
    expect((world.y - after.cy) * after.zoom + SCREEN.height / 2).toBeCloseTo(at.y, 6);
    // Two fingers: the point between them follows them.
    p.pinch(at, { x: 900, y: 300 }, 0.5);
    const pinched = inRoot(source.resolver, single(p.picture()));
    expect((world.x - pinched.cx) * pinched.zoom + SCREEN.width / 2).toBeCloseTo(900, 6);
    expect((world.y - pinched.cy) * pinched.zoom + SCREEN.height / 2).toBeCloseTo(300, 6);
  });

  it("takes over in the middle of a flight: the camera follows at once and comes to rest", () => {
    const { p, run, clock, source, viewOf } = setup();
    p.goTo(1);
    run(LONG);
    p.previous();
    clock.advance(400);
    expect(p.state.phase).toBe("moving");
    expect(p.state.position).toBe(0);
    const before = inRoot(source.resolver, single(p.picture()));
    p.pan(120, 0);
    expect(p.state.phase).toBe("roaming");
    // The route is paused at the stop shown last, not the one it was heading to.
    expect(p.state.position).toBe(1);
    // The picture moved by what the presenter moved it, and by nothing else.
    const after = inRoot(source.resolver, single(p.picture()));
    expect(after.zoom).toBeCloseTo(before.zoom, 12);
    expect((before.cx - after.cx) * after.zoom).toBeCloseTo(120, 6);
    expect(after.cy).toBeCloseTo(before.cy, 9);
    // It slows down along its path and stops, without a jump.
    run(BRAKE_DURATION + 50);
    expect(p.moving).toBe(false);
    const rest = single(p.picture());
    clock.advance(500);
    expect(single(p.picture())).toEqual(rest);
    // More roaming goes on from there.
    p.zoomAt({ x: 640, y: 360 }, 2);
    expect(single(p.picture()).zoom).toBeCloseTo(rest.zoom * 2, 12);
    // "Next" goes on with the stop after the last one shown.
    p.next();
    expect(p.state.position).toBe(2);
    expect(single(run(LONG))).toEqual(viewOf("s2"));
  });

  it("takes over while the camera is still slowing down, and goes back from there", () => {
    const { p, run, clock, viewOf } = setup();
    p.next();
    clock.advance(400);
    p.pan(30, 30);
    clock.advance(100);
    p.zoomAt({ x: 100, y: 100 }, 1.5);
    clock.advance(100);
    p.pan(-10, 0);
    // Still slowing down; "back" continues from what is on screen.
    expect(p.moving).toBe(true);
    p.back();
    expect(p.state.phase).toBe("moving");
    expect(p.state.position).toBe(0);
    expect(single(run(LONG))).toEqual(viewOf("s0"));
  });

  it("takes over in the middle of a cross-fade", () => {
    const { p, run, clock } = setup();
    p.next();
    run(LONG);
    p.next();
    clock.advance(250);
    expect(p.picture().kind).toBe("blend");
    p.pan(60, 0);
    expect(p.state.phase).toBe("roaming");
    expect(p.state.position).toBe(1);
    // The fade settles on one of its two views; nothing else is shown.
    run(2000);
    expect(p.moving).toBe(false);
    expect(p.picture().kind).toBe("view");
  });

  it("anchors in the frame it is over, so the whole zoom range is there far from the root", () => {
    const { p, run } = setup();
    p.goTo(5);
    run(LONG);
    const start = single(p.picture());
    // At the root, this far out, the precision budget stops the zoom at 64.
    expect(maxPreciseZoom(FAR, 0)).toBe(64);
    for (let i = 0; i < 20; i++) p.zoomAt({ x: 640, y: 360 }, 4);
    const deep = single(p.picture());
    expect(deep.space).toBe("fD");
    expect(start.zoom).toBe(8);
    expect(deep.zoom).toBe(MAX_ZOOM);
    // Zoomed out it stays anchored where its centre is; moved away, it leaves the frames.
    for (let i = 0; i < 16; i++) p.zoomAt({ x: 640, y: 360 }, 0.25);
    expect(single(p.picture()).space).toBe("fD");
    p.pan(-5000, 0);
    expect(single(p.picture()).space).toBe(null);
    expect(single(p.picture()).zoom).toBe(1);
  });

  it("is all there is when the document has no stops", () => {
    const doc = document();
    doc.routes = {};
    const view = { space: null, cx: 5, cy: 6, zoom: 2 };
    const { p } = setup(doc, { view });
    expect(p.state.route).toBe(null);
    expect(p.state.position).toBe(-1);
    expect(p.state.phase).toBe("roaming");
    expect(single(p.picture())).toEqual(view);
    p.next();
    p.previous();
    p.back();
    p.goTo(0);
    expect(single(p.picture())).toEqual(view);
    p.pan(20, 0);
    expect(single(p.picture()).cx).toBe(-5);
  });
});

describe("routes", () => {
  it("goes on from the same stop in another route that visits it", () => {
    const { p, run, viewOf, doc } = setup();
    p.goTo(2);
    run(LONG);
    p.setRoute("side");
    expect(p.state.route).toBe("side");
    expect(p.state.steps.map((s) => s.stop)).toEqual(["s2", "s6", "s0"]);
    // The camera stays; the new route's own state takes over.
    expect(p.state.position).toBe(0);
    expect(p.state.phase).toBe("stop");
    expect(single(p.picture())).toEqual(viewOf("s2"));
    expect(hiddenOf(p.picture())).toEqual([...hiddenAt(doc, "side", 0)]);
    p.next();
    expect(single(run(LONG))).toEqual(viewOf("s6"));
  });

  it("starts another route from its first stop when it does not visit the stop shown", () => {
    const { p, run, viewOf } = setup();
    p.goTo(4);
    run(LONG);
    p.setRoute("side");
    expect(p.state.phase).toBe("moving");
    expect(p.state.position).toBe(0);
    expect(single(run(LONG))).toEqual(viewOf("s2"));
    // A route that is not there, or the one being played: nothing happens.
    p.setRoute("gone");
    p.setRoute("side");
    expect(p.state.route).toBe("side");
    expect(p.state.phase).toBe("stop");
  });

  it("switches in the middle of a transition and while roaming", () => {
    const { p, run, viewOf, clock } = setup();
    p.goTo(2);
    run(LONG);
    p.next();
    clock.advance(300);
    p.setRoute("side");
    // Back to the stop shown last, which the new route visits.
    expect(p.state.position).toBe(0);
    expect(single(run(LONG))).toEqual(viewOf("s2"));
    p.pan(40, 0);
    p.setRoute("main");
    expect(p.state.phase).toBe("roaming");
    expect(p.state.position).toBe(2);
    p.next();
    expect(single(run(LONG))).toEqual(viewOf("s3"));
  });

  it("leaves the camera to the presenter in a route without stops", () => {
    const { p, run, clock } = setup();
    p.next();
    clock.advance(300);
    p.setRoute("empty");
    expect(p.state.phase).toBe("roaming");
    expect(p.state.position).toBe(-1);
    expect(p.state.steps).toEqual([]);
    run(1000);
    expect(p.moving).toBe(false);
    p.next();
    expect(p.state.phase).toBe("roaming");
    p.setRoute("main");
    expect(p.state.phase).toBe("moving");
    expect(p.state.position).toBe(0);
  });
});

describe("comfort", () => {
  it("cross-fades instead of flying with reduced motion", () => {
    const { p, run, clock, viewOf } = setup();
    expect(p.state.reducedMotion).toBe(false);
    p.setReducedMotion(true);
    expect(p.state.reducedMotion).toBe(true);
    expect(p.state.motionChoice).toBe(true);
    p.next();
    clock.advance(200);
    const picture = p.picture();
    expect(picture.kind).toBe("blend");
    if (picture.kind !== "blend") return;
    expect(picture.from.view).toEqual(viewOf("s0"));
    expect(picture.to.view).toEqual(viewOf("s1"));
    expect(single(run(LONG))).toEqual(viewOf("s1"));
  });

  it("follows the system's setting until the presenter chooses", () => {
    const { p } = setup(document(), { systemReducedMotion: true });
    expect(p.state.reducedMotion).toBe(true);
    expect(p.state.motionChoice).toBe(null);
    p.setReducedMotion(false);
    expect(p.state.reducedMotion).toBe(false);
    p.setReducedMotion(null);
    expect(p.state.reducedMotion).toBe(true);
    p.setSystemReducedMotion(false);
    expect(p.state.reducedMotion).toBe(false);
  });

  it("stops a flight where it is when reduced motion is switched on, and fades to the goal", () => {
    const { p, run, clock, viewOf, source } = setup();
    p.next();
    clock.advance(400);
    const onScreen = single(p.picture());
    p.setReducedMotion(true);
    expect(p.state.phase).toBe("moving");
    // From now on only the view that was on screen and the goal are shown.
    const goal = inRoot(source.resolver, viewOf("s1"));
    for (let t = 0; t < 1500; t += 5) {
      const picture = run(5);
      const views =
        picture.kind === "view" ? [picture.view] : [picture.from.view, picture.to.view];
      for (const view of views) {
        const here = inRoot(source.resolver, view);
        const still = viewGap(source.resolver, here, onScreen, SCREEN.width) < 1e-9;
        const there = viewGap(source.resolver, here, goal, SCREEN.width) < 1e-9;
        expect(still || there).toBe(true);
      }
    }
    expect(single(p.picture())).toEqual(viewOf("s1"));
    expect(p.state.phase).toBe("stop");
  });

  it("flies on when reduced motion is switched off in the middle of a cross-fade", () => {
    const { p, run, clock, viewOf } = setup();
    p.setReducedMotion(true);
    p.next();
    clock.advance(300);
    p.setReducedMotion(false);
    expect(single(run(LONG))).toEqual(viewOf("s1"));
  });
});

/** The test document with a long flight (3.6 s) from the first stop to the second. */
function far(): TestDocument {
  const doc = document();
  doc.stops["s1"]!.view = rect(4000, 0, 1600, 900);
  return doc;
}

/** Milliseconds until the camera has arrived, checking every 5 ms that nothing jumps; calls `each` before each step. */
function arrival(
  { p, clock, source }: ReturnType<typeof setup>,
  each: (elapsed: number) => void = () => {},
): number {
  let last = p.picture();
  for (let elapsed = 0; elapsed < LONG; elapsed += 5) {
    each(elapsed);
    if (p.state.phase !== "moving") return elapsed;
    clock.advance(5);
    const next = p.picture();
    expect(usable(next)).toBe(true);
    const { gap } = pictureGap(source.resolver, last, next, SCREEN.width);
    expect(gap).toBeLessThan(MAX_STEP);
    last = next;
  }
  return Infinity;
}

describe("the surroundings", () => {
  it("flies on undisturbed when the document changes every 200 ms without moving the goal", () => {
    const plain = setup(far());
    plain.p.next();
    const alone = arrival(plain);
    expect(alone).toBeGreaterThan(3000);
    const busy = setup(far());
    busy.p.next();
    const pictures: Picture[] = [];
    const taken = arrival(busy, (elapsed) => {
      if (elapsed % 200 === 0 && elapsed > 0) busy.p.documentChanged();
      pictures.push(busy.p.picture());
    });
    // The same flight, frame by frame, arriving when it would have.
    expect(taken).toBe(alone);
    expect(single(busy.p.picture())).toEqual(busy.viewOf("s1"));
    const again = setup(far());
    again.p.next();
    for (const picture of pictures) {
      expect(picture).toEqual(again.p.picture());
      again.clock.advance(5);
    }
  });

  it("steers onto a goal the document moves a little every 200 ms, and arrives in about the flight's own time", () => {
    const plain = setup(far());
    plain.p.next();
    const alone = arrival(plain);
    const busy = setup(far());
    busy.p.next();
    let x = 4000;
    const taken = arrival(busy, (elapsed) => {
      if (elapsed % 200 !== 0 || elapsed === 0) return;
      x += 8;
      busy.doc.stops["s1"]!.view = rect(x, 0, 1600, 900);
      busy.p.documentChanged();
    });
    expect(taken).toBeLessThanOrEqual(alone + MIN_STEER_MS + 5);
    expect(busy.p.state.phase).toBe("stop");
    expect(single(busy.p.picture())).toEqual(busy.viewOf("s1"));
  });

  it("takes over what the goal hides without touching the flight", () => {
    const plain = setup(far());
    plain.p.next();
    const alone = arrival(plain);
    const busy = setup(far());
    busy.p.next();
    const before = hiddenOf(busy.p.picture());
    const taken = arrival(busy, (elapsed) => {
      if (elapsed !== 300) return;
      busy.doc.stops["s1"]!.visibility = { box: { action: "hide" } };
      busy.p.documentChanged();
      // Not before arrival.
      expect(hiddenOf(busy.p.picture())).toEqual(before);
    });
    expect(taken).toBe(alone);
    expect(hiddenOf(busy.p.picture())).toEqual([...hiddenAt(busy.doc, "main", 1)].sort());
    expect(hiddenOf(busy.p.picture())).toContain("box");
  });

  it("goes on undisturbed when the stop it is on its way to is chosen again", () => {
    const plain = setup(far());
    plain.p.goTo(6);
    const pictures: Picture[] = [];
    const alone = arrival(plain, () => pictures.push(plain.p.picture()));
    const again = setup(far());
    again.p.goTo(6);
    const taken = arrival(again, (elapsed) => {
      if (elapsed % 100 === 0) again.p.goTo(6);
      if (elapsed === 500) again.p.goTo(again.p.state.steps.length - 1);
      expect(again.p.picture()).toEqual(pictures[elapsed / 5]);
    });
    expect(taken).toBe(alone);
  });

  it("flies into a stop at the speed the stop asks for", () => {
    const times: Record<string, number> = {};
    for (const speed of ["calm", "normal", "fast"]) {
      const doc = far();
      doc.stops["s1"]!.transition = { type: FLY, options: { speed } };
      const t = setup(doc);
      t.p.next();
      times[speed] = arrival(t);
      expect(single(t.p.picture())).toEqual(t.viewOf("s1"));
    }
    const plain = setup(far());
    plain.p.next();
    // No transition named: the route's default, at normal speed.
    expect(arrival(plain)).toBe(times["normal"]);
    expect(times["calm"]! / times["normal"]!).toBeCloseTo(1 / 0.7, 1);
    expect(times["fast"]! / times["normal"]!).toBeCloseTo(1 / 1.4, 1);
  });

  it("steers onto the new fit when the screen changes size in the middle of a flight", () => {
    const plain = setup(far());
    plain.p.next();
    const alone = arrival(plain);
    const busy = setup(far());
    busy.p.next();
    // The window is dragged larger, a few pixels every frame, for a second.
    let screen = SCREEN;
    const taken = arrival(busy, (elapsed) => {
      if (elapsed < 200 || elapsed > 1200 || elapsed % 15 !== 0) return;
      screen = { width: screen.width + 4, height: screen.height + 2 };
      busy.p.resize(screen);
    });
    expect(taken).toBeLessThanOrEqual(alone + MIN_STEER_MS + 5);
    expect(single(busy.p.picture())).toEqual(busy.viewOf("s1", screen));
    // Going to full screen in the last moments of a flight is steered too.
    const late = setup(far());
    late.p.next();
    const big = { width: 1920, height: 1080 };
    const lateTaken = arrival(late, (elapsed) => {
      if (elapsed === alone - 20) late.p.resize(big);
    });
    expect(lateTaken).toBeLessThanOrEqual(alone - 20 + MIN_STEER_MS + 5);
    expect(single(late.p.picture())).toEqual(late.viewOf("s1", big));
  });

  it("fits the stop again when the screen changes size", () => {
    const { p, run, viewOf, clock } = setup();
    const tall = { width: 600, height: 1200 };
    p.resize(tall);
    expect(single(p.picture())).toEqual(viewOf("s0", tall));
    expect(single(p.picture()).zoom).toBe(600 / 1600);
    // In the middle of a transition it goes on to the stop as it now fits.
    p.next();
    clock.advance(300);
    p.resize(SCREEN);
    expect(p.state.phase).toBe("moving");
    expect(single(run(LONG))).toEqual(viewOf("s1"));
    // While roaming the camera stays.
    p.pan(10, 0);
    const roaming = single(p.picture());
    p.resize(tall);
    expect(single(p.picture())).toEqual(roaming);
  });

  it("stays at the same visit when the route changes under it", () => {
    const { p, run, viewOf, doc } = setup();
    p.goTo(3);
    run(LONG);
    // The first stop is taken out of the route.
    delete doc.routes["main"]!.entries["e0"];
    p.documentChanged();
    expect(p.state.steps.map((s) => s.stop)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ]);
    expect(p.state.position).toBe(2);
    expect(p.state.phase).toBe("stop");
    expect(single(p.picture())).toEqual(viewOf("s3"));
    // The stop is changed: the camera shows it as it is now.
    doc.stops["s3"]!.view = rect(0, 0, 320, 180, "fB");
    p.documentChanged();
    expect(single(p.picture())).toEqual(viewOf("s3"));
    expect(single(p.picture()).zoom).toBe(4);
    // The visit itself is taken out: the presentation stays at that place.
    delete doc.routes["main"]!.entries["e3"];
    p.documentChanged();
    expect(p.state.position).toBe(2);
    expect(p.state.steps[2]!.stop).toBe("s4");
    expect(single(p.picture())).toEqual(viewOf("s4"));
  });

  it("goes to the first route when the one being played is gone, and roams when none is left", () => {
    const { p, run, viewOf, doc } = setup(document(), { route: "side" });
    p.next();
    run(LONG);
    delete doc.routes["side"];
    p.documentChanged();
    expect(p.state.route).toBe("main");
    expect(p.state.phase).toBe("stop");
    expect(single(p.picture())).toEqual(viewOf(p.state.steps[p.state.position]!.stop));
    doc.routes = {};
    p.documentChanged();
    expect(p.state.route).toBe(null);
    expect(p.state.phase).toBe("roaming");
    expect(p.state.position).toBe(-1);
  });

  it("re-reads in the middle of a transition", () => {
    const { p, run, viewOf, doc, clock } = setup();
    p.next();
    clock.advance(300);
    doc.stops["s1"]!.view = rect(500, 300, 400, 225);
    p.documentChanged();
    expect(p.state.phase).toBe("moving");
    expect(single(run(LONG))).toEqual(viewOf("s1"));
    expect(single(p.picture()).zoom).toBe(3.2);
  });
});

describe("input at any time", () => {
  /** What an input may do to the document and the screen. */
  interface World {
    readonly doc: TestDocument;
    resize(screen: { width: number; height: number }): void;
  }
  type Input = (
    p: Presentation,
    random: () => number,
    world: World,
  ) => "roam" | "cut" | "route";

  const SCREENS = [SCREEN, { width: 1200, height: 800 }, { width: 1440, height: 810 }];

  const INPUTS: readonly Input[] = [
    (p) => (p.next(), "route"),
    (p) => (p.next(), "route"),
    (p) => (p.previous(), "route"),
    (p) => (p.back(), "route"),
    (p, random) => (p.goTo(Math.floor(random() * p.state.steps.length)), "route"),
    (p, random) => (p.setRoute(random() < 0.5 ? "main" : "side"), "route"),
    (p, random) => (p.setReducedMotion(random() < 0.5 ? random() < 0.5 : null), "route"),
    (p, random) => (p.pan((random() - 0.5) * 400, (random() - 0.5) * 300), "roam"),
    (p, random) => (
      p.zoomAt({ x: random() * 1280, y: random() * 720 }, 2 ** (random() * 2 - 1)),
      "roam"
    ),
    (p, random) => (
      p.pinch(
        { x: random() * 1280, y: random() * 720 },
        { x: random() * 1280, y: random() * 720 },
        2 ** (random() - 0.5),
      ),
      "roam"
    ),
    // The document changes somewhere else (another window, another user).
    (p) => (p.documentChanged(), "route"),
    // A stop is moved a little, or somewhere else: at rest a cut, in a
    // transition it goes on to the stop where it now is.
    (p, random, { doc }) => {
      const view = doc.stops["s1"]!.view as { x: number; y: number };
      const small = random() < 0.7;
      doc.stops["s1"]!.view = rect(
        small ? view.x + (random() - 0.5) * 20 : random() * 2000 - 500,
        small ? view.y + (random() - 0.5) * 20 : random() * 1000 - 200,
        800,
        450,
      );
      p.documentChanged();
      return "cut";
    },
    // The window changes size: at rest a cut, in a transition it is steered.
    (_p, random, { resize }) => (
      resize(SCREENS[Math.floor(random() * SCREENS.length)]!),
      "cut"
    ),
  ];

  it("never jumps and never locks, whatever is pressed and whenever", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = seeded(seed);
      const { p, clock, source, viewOf, doc } = setup();
      let screen = SCREEN;
      const world: World = {
        doc,
        resize: (next) => {
          screen = next;
          p.resize(next);
        },
      };
      let last = p.picture();
      for (let i = 0; i < 50; i++) {
        // Wait a random while, often too short for the transition to end.
        const wait = random() < 0.7 ? random() * 700 : random() * 5000;
        for (let t = 0; t < wait; t += 5) {
          clock.advance(5);
          const picture = p.picture();
          expect(usable(picture)).toBe(true);
          const { gap } = pictureGap(source.resolver, last, picture, screen.width);
          if (gap >= MAX_STEP)
            throw new Error(
              `seed ${seed}, input ${i}: the picture jumped by ${gap} in 5 ms`,
            );
          last = picture;
        }
        const routeBefore = p.state.route;
        const phaseBefore = p.state.phase;
        const kind = INPUTS[Math.floor(random() * INPUTS.length)]!(p, random, world);
        const picture = p.picture();
        expect(usable(picture)).toBe(true);
        // What the presenter moves by hand moves at once; nothing else may
        // change the picture at the moment it is pressed. (A change of route
        // at a stop both routes visit changes what is hidden there; a stop
        // that moved, or a new screen size, is shown at once at rest.)
        if (kind === "route" || (kind === "cut" && phaseBefore !== "stop")) {
          const { gap, popped } = pictureGap(
            source.resolver,
            last,
            picture,
            screen.width,
          );
          if (gap > 1e-9)
            throw new Error(
              `seed ${seed}, input ${i}: pressing made the picture jump by ${gap}`,
            );
          if (popped) expect(p.state.route).not.toBe(routeBefore);
        }
        last = picture;
        const state = p.state;
        expect(state.position).toBeGreaterThanOrEqual(-1);
        expect(state.position).toBeLessThan(state.steps.length);
      }
      // Never locked: a jump is always obeyed, and ends exactly at the stop.
      world.resize(SCREEN);
      last = p.picture();
      const steps = p.state.steps;
      const index = Math.floor(random() * steps.length);
      p.goTo(index);
      for (let t = 0; t < LONG; t += 5) {
        clock.advance(5);
        const picture = p.picture();
        const { gap } = pictureGap(source.resolver, last, picture, SCREEN.width);
        if (gap >= MAX_STEP)
          throw new Error(
            `seed ${seed}, final jump: the picture jumped by ${gap} in 5 ms`,
          );
        last = picture;
      }
      expect(p.state.phase).toBe("stop");
      expect(p.state.position).toBe(index);
      expect(p.moving).toBe(false);
      const end = p.picture();
      expect(single(end)).toEqual(viewOf(steps[index]!.stop));
      expect(hiddenOf(end)).toEqual(
        [...hiddenAt(doc, p.state.route!, steps[index]!.place)].sort(),
      );
    }
  }, 120_000);

  it("changes what is hidden only where the camera is at rest or fading", () => {
    for (let seed = 100; seed < 130; seed++) {
      const random = seeded(seed);
      const { p, clock, source } = setup();
      let last = p.picture();
      for (let i = 0; i < 40; i++) {
        const wait = random() * 1200;
        for (let t = 0; t < wait; t += 5) {
          clock.advance(5);
          const picture = p.picture();
          const { gap, popped } = pictureGap(
            source.resolver,
            last,
            picture,
            SCREEN.width,
          );
          // Elements appear and disappear on arrival, never in mid-flight.
          if (popped) expect(gap).toBeLessThan(0.002);
          last = picture;
        }
        INPUTS[Math.floor(random() * 5)]!(p, random, {
          doc: document(),
          resize: () => {},
        });
        last = p.picture();
      }
    }
  }, 120_000);

  it("obeys input in the middle of every kind of transition between every pair of stops", () => {
    const { p: probe } = setup();
    const count = probe.state.steps.length;
    for (let from = 0; from < count; from++) {
      for (let to = 0; to < count; to++) {
        if (from === to) continue;
        for (const when of [1, 120, 450]) {
          const { p, clock, viewOf, run } = setup(document(), { step: from });
          p.goTo(to);
          clock.advance(when);
          const third = (to + 3) % count;
          p.goTo(third);
          expect(p.state.position).toBe(third);
          expect(single(run(LONG))).toEqual(viewOf(p.state.steps[third]!.stop));
          expect(sameView(single(p.picture()), viewOf(`s${third}`))).toBe(true);
        }
      }
    }
  }, 120_000);
});
