// SPDX-License-Identifier: GPL-3.0-or-later

// The built-in transitions: durations, the speed profile in the metric of van
// Wijk and Nuij, the limits above which a flight becomes a cross-fade, reduced
// motion, the extreme cases and breaking off a transition midway.

import type { CameraView } from "@galatsa/core";
import {
  DEFAULT_COMFORT,
  EXTENSION_API_VERSION,
  guardComfort,
  readTransitionValue,
  ViewHost,
  type CameraMotion,
  type ComfortSettings,
  type MotionFrame,
} from "@galatsa/extension-api";
import { describe, expect, it } from "vitest";
import { smoothProgress } from "./easing.ts";
import { flightPath, metricDistance } from "./flight.ts";
import {
  cut,
  DEFAULT_TRANSITION,
  exceedsFlightLimits,
  fade,
  FADE_DURATION,
  FLIGHT_SPEED,
  flightDuration,
  fly,
  MIN_FLIGHT_DURATION,
  planFlight,
  restingView,
  transitionsExtension,
} from "./transitions.ts";

const VIEWPORT = { width: 1000, height: 600 };
const NO_LIMITS: ComfortSettings = {
  ...DEFAULT_COMFORT,
  maxFlightZoomRatio: Infinity,
  maxFlightDistance: Infinity,
  maxFlightDuration: Infinity,
};

function plan(from: CameraView, to: CameraView, comfort = DEFAULT_COMFORT): CameraMotion {
  return fly.plan({ from, to, options: fly.read(null), comfort, viewport: VIEWPORT });
}

/** Every frame at whole milliseconds, and the last one. */
function everyFrame(motion: CameraMotion): MotionFrame[] {
  const out: MotionFrame[] = [];
  for (let t = 0; t < motion.duration; t++) out.push(motion.frame(t));
  out.push(motion.frame(motion.duration));
  return out;
}

function viewsOf(frame: MotionFrame): CameraView[] {
  return frame.kind === "view" ? [frame.view] : [frame.from, frame.to];
}

function isFinite(view: CameraView): boolean {
  return Number.isFinite(view.cx) && Number.isFinite(view.cy) && Number.isFinite(view.zoom);
}

/** Only the start and the goal are ever shown. */
function expectNoMotion(motion: CameraMotion, from: CameraView, to: CameraView): void {
  for (const frame of everyFrame(motion)) {
    for (const view of viewsOf(frame)) expect([from, to]).toContainEqual(view);
    if (frame.kind === "blend") {
      expect(frame.from).toEqual(from);
      expect(frame.to).toEqual(to);
      expect(frame.mix).toBeGreaterThanOrEqual(0);
      expect(frame.mix).toBeLessThanOrEqual(1);
    }
  }
}

const A: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };

describe("comfort defaults", () => {
  it("are calm", () => {
    expect(DEFAULT_COMFORT).toEqual({
      reducedMotion: false,
      maxFlightZoomRatio: 64,
      maxFlightDistance: 4,
      maxFlightDuration: 4000,
      durationScale: 1,
    });
    // The peak speed in the metric: the mean speed over 1 - the ramp share.
    expect(FLIGHT_SPEED).toBe(0.75);
    expect(MIN_FLIGHT_DURATION).toBe(500);
    expect(FADE_DURATION).toBe(700);
  });
});

describe("the flight", () => {
  it("takes as long as its length at the calm speed", () => {
    // One screen width to the side: length 2 asinh(1) / sqrt(2).
    const pan = plan(A, { space: null, cx: 1000, cy: 0, zoom: 1 });
    expect(pan.duration).toBeCloseTo((1.246450480280461 / 0.75) * 1000, 9);
    expect(pan.duration).toBeCloseTo(1661.9339737072814, 9);
    // A zoom by four: ln(4) / sqrt(2).
    const zoom = plan(A, { space: null, cx: 0, cy: 0, zoom: 4 });
    expect(zoom.duration).toBeCloseTo(1307.0108579580628, 9);
    // Slower when the viewer asks for it.
    const slow = plan(A, { space: null, cx: 0, cy: 0, zoom: 4 }, {
      ...DEFAULT_COMFORT,
      durationScale: 2,
    });
    expect(slow.duration).toBeCloseTo(2614.0217159161256, 9);
    // A short move still takes half a second, so it is not abrupt.
    expect(plan(A, { space: null, cx: 1, cy: 0, zoom: 1 }).duration).toBe(500);
    expect(flightDuration(0, 1)).toBe(0);
    expect(flightDuration(0.001, 1)).toBe(500);
    expect(flightDuration(1.5, 1)).toBeCloseTo(2000, 9);
    expect(flightDuration(1.5, 0.5)).toBeCloseTo(1000, 9);
  });

  it("starts and ends exactly at the start and the goal", () => {
    const to: CameraView = { space: null, cx: 1234.5, cy: -987.25, zoom: 3.75 };
    const motion = plan(A, to);
    expect(motion.frame(0)).toEqual({ kind: "view", view: A });
    expect(motion.frame(motion.duration)).toEqual({ kind: "view", view: to });
    expect(motion.frame(-10)).toEqual({ kind: "view", view: A });
    expect(motion.frame(motion.duration + 10)).toEqual({ kind: "view", view: to });
    expect(motion.frame(Number.NaN)).toEqual({ kind: "view", view: A });
  });

  it("follows the smooth speed profile in the metric", () => {
    const to: CameraView = { space: null, cx: 1500, cy: 500, zoom: 4 };
    const motion = plan(A, to);
    const length = metricDistance(A, to, VIEWPORT.width);
    expect(motion.duration).toBeCloseTo((length / FLIGHT_SPEED) * 1000, 9);
    const n = 500;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t1 = (motion.duration * i) / n;
      const t2 = (motion.duration * (i + 1)) / n;
      const f1 = motion.frame(t1);
      const f2 = motion.frame(t2);
      expect(f1.kind).toBe("view");
      if (f1.kind !== "view" || f2.kind !== "view") continue;
      const step = metricDistance(f1.view, f2.view, VIEWPORT.width);
      const expected =
        length *
        (smoothProgress(t2 / motion.duration) - smoothProgress(t1 / motion.duration));
      expect(Math.abs(step - expected), `step ${i}`).toBeLessThan(1e-7 * expected + 1e-12);
      peak = Math.max(peak, step / (t2 - t1));
    }
    // Never faster than one metric unit per second.
    expect(peak).toBeLessThanOrEqual(1 / 1000 + 1e-9);
    expect(peak).toBeGreaterThan(0.999 / 1000);
  });

  it("is the same flight backwards", () => {
    const b: CameraView = { space: null, cx: -800, cy: 1500, zoom: 0.4 };
    const forth = plan(A, b);
    const back = plan(b, A);
    expect(back.duration).toBe(forth.duration);
    for (let k = 0; k <= 40; k++) {
      const t = (forth.duration * k) / 40;
      const p = forth.frame(t);
      const q = back.frame(forth.duration - t);
      if (p.kind !== "view" || q.kind !== "view") throw new Error("not a view");
      expect(metricDistance(p.view, q.view, VIEWPORT.width)).toBeLessThan(1e-9);
    }
  });

  it("is a cut when start and goal are the same", () => {
    const motion = plan(A, { ...A });
    expect(motion.duration).toBe(0);
    expect(motion.frame(0)).toEqual({ kind: "view", view: A });
  });

  it("handles only a zoom, and only a pan", () => {
    const zoom = plan(A, { space: null, cx: 0, cy: 0, zoom: 1 / 30 });
    for (const frame of everyFrame(zoom)) {
      if (frame.kind !== "view") throw new Error("not a view");
      expect(frame.view.cx).toBe(0);
      expect(frame.view.cy).toBe(0);
      expect(frame.view.zoom).toBeLessThanOrEqual(1);
      expect(frame.view.zoom).toBeGreaterThanOrEqual(1 / 30);
    }
    const pan = plan(A, { space: null, cx: 0, cy: -2500, zoom: 1 });
    for (const frame of everyFrame(pan)) {
      if (frame.kind !== "view") throw new Error("not a view");
      expect(frame.view.cx).toBe(0);
      expect(frame.view.cy).toBeLessThanOrEqual(0);
      expect(frame.view.cy).toBeGreaterThanOrEqual(-2500);
      expect(frame.view.zoom).toBeLessThanOrEqual(1);
    }
  });

  it("flies a zoom ratio of 2^60 without NaN, infinity or jumps when allowed to", () => {
    const from: CameraView = { space: "deep", cx: 0.5, cy: 0.25, zoom: 2 ** -30 };
    const to: CameraView = { space: "deep", cx: 0.5 + 2 ** -25, cy: 0.25, zoom: 2 ** 30 };
    // By default this is far above the limits: a cross-fade.
    const calm = plan(from, to);
    expect(calm.frame(calm.duration / 2).kind).toBe("blend");
    const motion = plan(from, to, NO_LIMITS);
    const length = flightPath(from, to, VIEWPORT.width).length;
    expect(motion.duration).toBeCloseTo((length / 0.75) * 1000, 6);
    expect(motion.frame(motion.duration)).toEqual({ kind: "view", view: to });
    let last = 0;
    let previous: CameraView = from;
    const n = 4000;
    for (let i = 0; i <= n; i++) {
      const frame = motion.frame((motion.duration * i) / n);
      if (frame.kind !== "view") throw new Error("not a view");
      expect(isFinite(frame.view)).toBe(true);
      expect(frame.view.zoom).toBeGreaterThanOrEqual(last);
      last = frame.view.zoom;
      // No step is longer than the peak speed allows.
      expect(metricDistance(previous, frame.view, VIEWPORT.width)).toBeLessThanOrEqual(
        (motion.duration / n / 1000) * (1 + 1e-6),
      );
      previous = frame.view;
    }
  });
});

describe("the limits of a flight", () => {
  it("cross-fade above the zoom ratio", () => {
    const at64: CameraView = { space: null, cx: 0, cy: 0, zoom: 64 };
    const at65: CameraView = { space: null, cx: 0, cy: 0, zoom: 65 };
    expect(exceedsFlightLimits(A, at64, VIEWPORT, DEFAULT_COMFORT)).toBe(false);
    expect(exceedsFlightLimits(A, at65, VIEWPORT, DEFAULT_COMFORT)).toBe(true);
    // Zooming out counts the same.
    expect(exceedsFlightLimits(at65, A, VIEWPORT, DEFAULT_COMFORT)).toBe(true);
    const flight = plan(A, at64);
    expect(flight.duration).toBeCloseTo(3921.032573874188, 6);
    expect(flight.frame(flight.duration / 2).kind).toBe("view");
    const crossFade = plan(A, at65);
    expect(crossFade.duration).toBe(FADE_DURATION);
    expectNoMotion(crossFade, A, at65);
    expect(crossFade.frame(350)).toMatchObject({ kind: "blend", from: A, to: at65 });
    expect(mixOf(crossFade.frame(350))).toBeCloseTo(0.5, 15);
  });

  it("cross-fade above the distance, in widths of the wider view", () => {
    // At zoom 1 the view is 1000 units wide. Four widths take 3.95 seconds.
    const at4: CameraView = { space: null, cx: 4000, cy: 0, zoom: 1 };
    const beyond: CameraView = { space: null, cx: 2400, cy: 3210, zoom: 1 };
    expect(plan(A, at4).duration).toBeCloseTo(3949.827858146323, 6);
    expect(exceedsFlightLimits(A, at4, VIEWPORT, DEFAULT_COMFORT)).toBe(false);
    expect(exceedsFlightLimits(A, beyond, VIEWPORT, DEFAULT_COMFORT)).toBe(true);
    expect(plan(A, at4).frame(1000).kind).toBe("view");
    expectNoMotion(plan(A, beyond), A, beyond);
  });

  it("cross-fade when the flight would take too long", () => {
    // A zoom by 8 to a place two screen widths away: within the ratio and the
    // distance, but the flight would take about 4.6 seconds.
    const to: CameraView = { space: null, cx: 2000, cy: 0, zoom: 8 };
    expect(flightDuration(metricDistance(A, to, 1000), 1)).toBeCloseTo(4632.5107, 3);
    expect(exceedsFlightLimits(A, to, VIEWPORT, DEFAULT_COMFORT)).toBe(true);
    expectNoMotion(plan(A, to), A, to);
    // A longer limit lets it fly. The limit is on the duration at normal
    // speed, so slowing down does not turn a flight into a cross-fade.
    const patient = { ...DEFAULT_COMFORT, maxFlightDuration: 5000 };
    expect(plan(A, to, patient).frame(2000).kind).toBe("view");
    expect(
      exceedsFlightLimits(A, at(1000), VIEWPORT, { ...DEFAULT_COMFORT, durationScale: 4 }),
    ).toBe(false);
  });

  it("cross-fade between views in different spaces", () => {
    const to: CameraView = { space: "frame", cx: 10, cy: 0, zoom: 1 };
    expectNoMotion(plan(A, to), A, to);
  });

  it("cut when a view is not a view", () => {
    for (const zoom of [0, -1, Number.NaN, Infinity]) {
      const to: CameraView = { space: null, cx: 10, cy: 0, zoom };
      const motion = plan(A, to);
      expect(motion.duration).toBe(0);
      expect(motion.frame(0)).toEqual({ kind: "view", view: to });
    }
    const motion = plan({ space: null, cx: Number.NaN, cy: 0, zoom: 1 }, A);
    expect(motion.duration).toBe(0);
  });
});

function mixOf(frame: MotionFrame): number {
  if (frame.kind !== "blend") throw new Error("not a blend");
  return frame.mix;
}

function at(cx: number): CameraView {
  return { space: null, cx, cy: 0, zoom: 1 };
}

describe("reduced motion", () => {
  const comfort = { ...DEFAULT_COMFORT, reducedMotion: true };
  const cases: Array<[CameraView, CameraView]> = [
    [A, at(1000)],
    [A, { space: null, cx: 0, cy: 0, zoom: 4 }],
    [A, { space: null, cx: 5e5, cy: 0, zoom: 2 ** 20 }],
    [{ space: "f", cx: 1, cy: 1, zoom: 2 ** 30 }, { space: "f", cx: 1, cy: 1.5, zoom: 2 ** -30 }],
  ];

  it("shows nothing but the start and the goal, in every frame of every transition", () => {
    for (const transition of [fly, fade, cut]) {
      for (const [from, to] of cases) {
        const motion = transition.plan({
          from,
          to,
          options: transition.read(null),
          comfort,
          viewport: VIEWPORT,
        });
        expectNoMotion(motion, from, to);
        // The guard has nothing to change.
        const guarded = guardComfort(motion, from, to, comfort);
        expect(guarded.duration).toBe(motion.duration);
        const frames = everyFrame(motion);
        everyFrame(guarded).forEach((frame, i) => expect(frame).toEqual(frames[i]));
      }
    }
  });

  it("makes the flight a cross-fade", () => {
    const motion = plan(A, at(10), comfort);
    expect(motion.duration).toBe(FADE_DURATION);
    expect(motion.frame(0)).toEqual({ kind: "view", view: A });
    expect(motion.frame(FADE_DURATION / 2)).toMatchObject({
      kind: "blend",
      from: A,
      to: at(10),
    });
    expect(mixOf(motion.frame(FADE_DURATION / 2))).toBeCloseTo(0.5, 15);
    expect(motion.frame(FADE_DURATION)).toEqual({ kind: "view", view: at(10) });
  });
});

describe("the cross-fade and the cut", () => {
  it("cross-fade smoothly and scale with the duration setting", () => {
    const to = at(10);
    const motion = fade.plan({
      from: A,
      to,
      options: fade.read(null),
      comfort: DEFAULT_COMFORT,
      viewport: VIEWPORT,
    });
    expect(motion.duration).toBe(700);
    let last = 0;
    for (const frame of everyFrame(motion).slice(1, -1)) {
      if (frame.kind !== "blend") throw new Error("not a blend");
      expect(frame.mix).toBeGreaterThanOrEqual(last);
      last = frame.mix;
    }
    // Starts and ends slowly: the opacity follows a raised cosine.
    expect(motion.frame(70)).toMatchObject({ mix: (1 - Math.cos(Math.PI * 0.1)) / 2 });
    const slow = fade.plan({
      from: A,
      to,
      options: null,
      comfort: { ...DEFAULT_COMFORT, durationScale: 2 },
      viewport: VIEWPORT,
    });
    expect(slow.duration).toBe(1400);
    // The same view needs no cross-fade.
    expect(
      fade.plan({ from: A, to: { ...A }, options: null, comfort: DEFAULT_COMFORT, viewport: VIEWPORT })
        .duration,
    ).toBe(0);
  });

  it("cut at once", () => {
    const motion = cut.plan({
      from: A,
      to: at(10),
      options: cut.read(null),
      comfort: DEFAULT_COMFORT,
      viewport: VIEWPORT,
    });
    expect(motion.duration).toBe(0);
    expect(motion.frame(0)).toEqual({ kind: "view", view: at(10) });
  });
});

describe("breaking off a transition", () => {
  it("continues from the view on screen without a jump", () => {
    const b: CameraView = { space: null, cx: 2000, cy: 0, zoom: 2 };
    const c: CameraView = { space: null, cx: -500, cy: 800, zoom: 0.5 };
    const first = plan(A, b);
    for (const share of [0.01, 0.25, 0.5, 0.5001, 0.77, 0.999]) {
      const frame = first.frame(first.duration * share);
      const here = restingView(frame);
      expect(frame).toEqual({ kind: "view", view: here });
      const second = plan(here, c);
      expect(second.frame(0)).toEqual({ kind: "view", view: here });
      expect(second.frame(second.duration)).toEqual({ kind: "view", view: c });
      for (const next of everyFrame(second))
        for (const view of viewsOf(next)) expect(isFinite(view)).toBe(true);
      // Back to where it was going works too.
      expect(plan(here, b).frame(0)).toEqual({ kind: "view", view: here });
    }
  });

  it("continues a cross-fade from the view that dominates", () => {
    const far: CameraView = { space: null, cx: 0, cy: 0, zoom: 1000 };
    const crossFade = plan(A, far);
    expect(restingView(crossFade.frame(100))).toEqual(A);
    expect(restingView(crossFade.frame(600))).toEqual(far);
  });
});

describe("the extension", () => {
  it("loads into a viewing host with all its texts", () => {
    const host = new ViewHost();
    expect(host.load([transitionsExtension])).toEqual([]);
    expect(transitionsExtension.api).toBe(EXTENSION_API_VERSION);
    const value = readTransitionValue({ type: DEFAULT_TRANSITION, options: null });
    expect(value?.type).toBe("galatsa.transitions/fly");
    expect(host.transition(DEFAULT_TRANSITION)).toBe(fly);
    expect(host.transition("galatsa.transitions/fade")).toBe(fade);
    expect(host.transition("galatsa.transitions/cut")).toBe(cut);
    expect(host.transitions("quick").map((t) => t.definition.name)).toEqual([
      "fly",
      "fade",
      "cut",
    ]);
  });

  it("reads any stored options", () => {
    for (const options of [null, 3, "x", [1], { duration: 5 }]) {
      expect(() => fly.read(options)).not.toThrow();
      expect(() => fade.read(options)).not.toThrow();
      expect(() => cut.read(options)).not.toThrow();
    }
  });
});
