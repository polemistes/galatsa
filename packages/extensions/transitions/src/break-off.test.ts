// SPDX-License-Identifier: GPL-3.0-or-later

// Breaking off a running transition: neither the view nor its speed jumps,
// for flights and cross-fades, also when the result is broken off again; and
// reduced motion switched on midway shows nothing but what was on screen and
// the goal.

import type { CameraView } from "@galatsa/core";
import {
  DEFAULT_COMFORT,
  defineTransition,
  guardComfort,
  type AnyTransition,
  type CameraMotion,
  type ComfortSettings,
  type MotionFrame,
} from "@galatsa/extension-api";
import { describe, expect, it } from "vitest";
import { BRAKE_DURATION, breakOff, type NextTransition } from "./break-off.ts";
import { metricDistance } from "./flight.ts";
import { fade, FADE_DURATION, FLIGHT_PEAK_SPEED, fly } from "./transitions.ts";

const VIEWPORT = { width: 1000, height: 600 };
const NO_LIMITS: ComfortSettings = {
  ...DEFAULT_COMFORT,
  maxFlightZoomRatio: Infinity,
  maxFlightDistance: Infinity,
  maxFlightDuration: Infinity,
};
const REDUCED: ComfortSettings = { ...DEFAULT_COMFORT, reducedMotion: true };

const A: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
const B: CameraView = { space: null, cx: 2000, cy: 300, zoom: 2 };
const C: CameraView = { space: null, cx: -600, cy: 1400, zoom: 0.5 };
const D: CameraView = { space: null, cx: 900, cy: -900, zoom: 3 };

/** A flight that ignores the comfort settings, as a careless extension might. */
const careless = defineTransition<null>({
  name: "careless",
  label: "common:a",
  read: () => null,
  plan: ({ from, to }) => ({
    duration: 1000,
    frame(time) {
      const s = Math.min(1, Math.max(0, time / 1000));
      return {
        kind: "view",
        view: {
          space: from.space,
          cx: from.cx + (to.cx - from.cx) * s,
          cy: from.cy + (to.cy - from.cy) * s,
          zoom: from.zoom * (to.zoom / from.zoom) ** s,
        },
      };
    },
  }),
});

function planned(
  transition: AnyTransition,
  from: CameraView,
  to: CameraView,
  comfort: ComfortSettings,
): CameraMotion {
  return guardComfort(
    transition.plan({
      from,
      to,
      options: transition.read(null),
      comfort,
      viewport: VIEWPORT,
    }),
    from,
    to,
    comfort,
  );
}

function next(
  to: CameraView,
  transition: AnyTransition = fly as AnyTransition,
): NextTransition {
  return { transition, options: transition.read(null), to, viewport: VIEWPORT };
}

/**
 * The frames shown around a break-off, one per millisecond: the last few of
 * `before` up to `time`, then every one of `after` to its end.
 */
function timeline(
  before: CameraMotion,
  time: number,
  after: CameraMotion,
): MotionFrame[] {
  const frames: MotionFrame[] = [];
  for (let k = 20; k >= 1; k--) frames.push(before.frame(Math.max(0, time - k)));
  for (let t = 0; t < after.duration; t++) frames.push(after.frame(t));
  frames.push(after.frame(after.duration));
  return frames;
}

/** The share of the picture each view has in a frame. */
function weights(frame: MotionFrame): Map<string, number> {
  const key = (view: CameraView) => JSON.stringify(view);
  if (frame.kind === "view") return new Map([[key(frame.view), 1]]);
  const out = new Map<string, number>();
  out.set(key(frame.from), (out.get(key(frame.from)) ?? 0) + 1 - frame.mix);
  out.set(key(frame.to), (out.get(key(frame.to)) ?? 0) + frame.mix);
  return out;
}

/**
 * Checks frames that are all camera views: no jump in the view (each step
 * within the peak speed) and no jump in the speed (an acceleration below
 * `accel` metric units per second squared; stopping dead from the peak speed
 * between two frames a millisecond apart would be 850).
 */
function expectSmoothFlight(frames: MotionFrame[], accel = 15): void {
  const peak = FLIGHT_PEAK_SPEED / 1000;
  let speed: number | null = null;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i]!;
    const b = frames[i + 1]!;
    if (a.kind !== "view" || b.kind !== "view") throw new Error(`frame ${i} is a blend`);
    for (const v of [a.view, b.view]) {
      expect(Number.isFinite(v.cx) && Number.isFinite(v.cy) && v.zoom > 0).toBe(true);
    }
    const step = metricDistance(a.view, b.view, VIEWPORT.width);
    expect(step, `step ${i}`).toBeLessThanOrEqual(peak * (1 + 1e-6));
    if (speed !== null) {
      // Steps are per millisecond: units per second squared is 1e6 times.
      expect(Math.abs(step - speed) * 1e6, `acceleration at ${i}`).toBeLessThan(accel);
    }
    speed = step;
  }
}

/**
 * Checks frames of cross-fades: only the views in `allowed`, no jump in any
 * view's share of the picture, and no jump in how fast a share changes.
 */
function expectSmoothFade(frames: MotionFrame[], allowed: CameraView[]): void {
  const keys = allowed.map((v) => JSON.stringify(v));
  const shares = frames.map((frame) => {
    const w = weights(frame);
    for (const k of w.keys()) expect(keys, "a view that is not allowed").toContain(k);
    return keys.map((k) => w.get(k) ?? 0);
  });
  for (let i = 0; i + 1 < shares.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      const rate = shares[i + 1]![j]! - shares[i]![j]!;
      // A cross-fade changes a share by at most pi / (2 * 700) per millisecond.
      expect(Math.abs(rate), `share jump at ${i}`).toBeLessThan(0.004);
      if (i + 2 < shares.length) {
        const nextRate = shares[i + 2]![j]! - shares[i + 1]![j]!;
        expect(Math.abs(nextRate - rate), `rate jump at ${i}`).toBeLessThan(1e-4);
      }
    }
  }
}

describe("breaking off a flight", () => {
  it("goes on without a jump in the view or its speed, to any goal", () => {
    const first = planned(fly, A, B, NO_LIMITS);
    for (const share of [0.05, 0.25, 0.5, 0.75, 0.97]) {
      const time = first.duration * share;
      for (const goal of [C, A, B, D]) {
        const after = breakOff(first, time, NO_LIMITS, next(goal));
        expect(after.frame(0)).toEqual(first.frame(time));
        expect(after.frame(after.duration)).toEqual({ kind: "view", view: goal });
        expectSmoothFlight(timeline(first, time, after));
      }
    }
  });

  it("comes to rest smoothly when the presenter takes over", () => {
    const first = planned(fly, A, B, NO_LIMITS);
    const time = first.duration / 2;
    const after = breakOff(first, time, NO_LIMITS);
    expect(after.duration).toBe(BRAKE_DURATION);
    const frames = timeline(first, time, after);
    expectSmoothFlight(frames);
    // At rest at the end, a little further along the path.
    const last = after.frame(after.duration);
    const beforeLast = after.frame(after.duration - 1);
    if (last.kind !== "view" || beforeLast.kind !== "view") throw new Error("not a view");
    expect(metricDistance(beforeLast.view, last.view, VIEWPORT.width)).toBeLessThan(1e-7);
    // Slower braking when the viewer asks for slower transitions.
    expect(breakOff(first, time, { ...NO_LIMITS, durationScale: 2 }).duration).toBe(
      2 * BRAKE_DURATION,
    );
    // Near the end there is less room: it never passes the goal.
    const late = breakOff(first, first.duration - 100, NO_LIMITS);
    expect(late.duration).toBeCloseTo(200, 9);
    expect(late.frame(late.duration)).toEqual({ kind: "view", view: B });
  });

  it("can be broken off again and again", () => {
    const first = planned(fly, A, B, NO_LIMITS);
    const t1 = first.duration * 0.4;
    const second = breakOff(first, t1, NO_LIMITS, next(C));
    // During the braking.
    const t2 = 250;
    const third = breakOff(second, t2, NO_LIMITS, next(D));
    // Well into the new flight.
    const t3 = BRAKE_DURATION + 900;
    expect(third.duration).toBeGreaterThan(t3);
    const fourth = breakOff(third, t3, NO_LIMITS, next(A));
    expectSmoothFlight(timeline(first, t1, second).slice(0, 20 + t2));
    expectSmoothFlight(timeline(second, t2, third));
    expectSmoothFlight(timeline(third, t3, fourth));
    expect(fourth.frame(fourth.duration)).toEqual({ kind: "view", view: A });
  });

  it("starts at once from the start or the goal, where the flight is at rest", () => {
    const first = planned(fly, A, B, NO_LIMITS);
    for (const time of [0, -5, Number.NaN]) {
      const after = breakOff(first, time, NO_LIMITS, next(C));
      expect(after.frame(0)).toEqual({ kind: "view", view: A });
      expect(after.duration).toBe(planned(fly, A, C, NO_LIMITS).duration);
    }
    const after = breakOff(first, first.duration + 10, NO_LIMITS, next(C));
    expect(after.frame(0)).toEqual({ kind: "view", view: B });
    expect(after.duration).toBe(planned(fly, B, C, NO_LIMITS).duration);
  });
});

describe("breaking off a cross-fade", () => {
  it("goes on without a jump in the picture or in how fast it changes", () => {
    const first = planned(fade, A, B, DEFAULT_COMFORT);
    for (const share of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      const time = first.duration * share;
      for (const goal of [C, A, B]) {
        const after = breakOff(first, time, DEFAULT_COMFORT, next(goal, fade));
        expect(after.frame(0)).toEqual(first.frame(time));
        expect(after.frame(after.duration)).toEqual({ kind: "view", view: goal });
        expectSmoothFade(timeline(first, time, after), [A, B, C]);
      }
    }
  });

  it("turns back towards the start when the start is the new goal", () => {
    const first = planned(fade, A, B, DEFAULT_COMFORT);
    const time = first.duration * 0.6;
    const after = breakOff(first, time, DEFAULT_COMFORT, next(A, fade));
    // B is never shown alone: the fade turns back before it gets there.
    for (const frame of timeline(first, time, after))
      expect(frame).not.toEqual({ kind: "view", view: B });
    expect(after.duration).toBeLessThan(BRAKE_DURATION + FADE_DURATION);
  });

  it("settles on one of its views before a flight sets off", () => {
    const first = planned(fade, A, B, DEFAULT_COMFORT);
    const time = first.duration * 0.4;
    const after = breakOff(first, time, NO_LIMITS, next(C));
    const frames = timeline(first, time, after);
    // First a cross-fade between A and B only, then a flight from B (it was
    // heading there) that starts at rest.
    const flightStart = frames.findIndex((f, i) => i > 20 && f.kind === "view");
    expect(flightStart).toBeGreaterThan(20);
    expectSmoothFade(frames.slice(0, flightStart), [A, B]);
    const flight = [{ kind: "view", view: B } as const, ...frames.slice(flightStart)];
    expectSmoothFlight(flight);
    // It sets off from rest: the first millisecond barely moves.
    const firstStep = flight[1]!;
    if (firstStep.kind !== "view") throw new Error("not a view");
    expect(metricDistance(B, firstStep.view, VIEWPORT.width)).toBeLessThan(1e-6);
  });
});

describe("reduced motion switched on during a transition", () => {
  /** Every view shown in the frames. */
  function shown(motion: CameraMotion): CameraView[] {
    const out: CameraView[] = [];
    for (let t = 0; t < motion.duration; t += 0.5) {
      const f = motion.frame(t);
      out.push(...(f.kind === "view" ? [f.view] : [f.from, f.to]));
    }
    const f = motion.frame(motion.duration);
    out.push(...(f.kind === "view" ? [f.view] : [f.from, f.to]));
    return out;
  }

  it("shows nothing but the view on screen and the goal after the switch", () => {
    const first = planned(fly, A, B, NO_LIMITS);
    for (const share of [0.1, 0.5, 0.9]) {
      const time = first.duration * share;
      const onScreen = first.frame(time);
      if (onScreen.kind !== "view") throw new Error("not a view");
      for (const goal of [B, C]) {
        for (const transition of [fly, careless]) {
          const after = breakOff(first, time, REDUCED, next(goal, transition));
          expect(after.frame(0)).toEqual(onScreen);
          for (const view of shown(after))
            expect([onScreen.view, goal]).toContainEqual(view);
          expect(after.frame(after.duration)).toEqual({ kind: "view", view: goal });
        }
      }
      // The presenter takes over: the camera stays where it is.
      const rest = breakOff(first, time, REDUCED);
      expect(rest.duration).toBe(0);
      expect(rest.frame(0)).toEqual(onScreen);
    }
  });

  it("lets a cross-fade go on between its own two views", () => {
    const first = planned(fade, A, B, DEFAULT_COMFORT);
    for (const share of [0.2, 0.5, 0.8]) {
      const time = first.duration * share;
      for (const goal of [B, C]) {
        const after = breakOff(first, time, REDUCED, next(goal));
        for (const view of shown(after)) expect([A, B, goal]).toContainEqual(view);
        expectSmoothFade(timeline(first, time, after), [A, B, C]);
      }
    }
  });

  it("and switched off again, the cross-fade it became finishes smoothly", () => {
    const first = planned(fly, A, B, REDUCED);
    const time = first.duration * 0.5;
    const after = breakOff(first, time, NO_LIMITS, next(B));
    expect(after.frame(after.duration)).toEqual({ kind: "view", view: B });
    expectSmoothFade(timeline(first, time, after), [A, B]);
  });
});
