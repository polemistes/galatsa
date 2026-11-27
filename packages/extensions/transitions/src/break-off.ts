// SPDX-License-Identifier: GPL-3.0-or-later

// Breaking off a running camera motion without a jump: the presenter chooses
// another stop, goes back, takes over the camera, or switches reduced motion
// on or off while a transition is playing. A flight slows down along its own
// path and comes to rest; a cross-fade goes on, or turns back, between the two
// views it shows until one of them fills the screen. The next transition is
// planned from there. Neither the view nor the speed jumps, so the transitions
// need not report their state, and any transition can be broken off.

import type { CameraView } from "@galatsa/core";
import {
  guardComfort,
  type AnyTransition,
  type CameraMotion,
  type ComfortSettings,
  type MotionFrame,
} from "@galatsa/extension-api";
import { FADE_DURATION } from "./transitions.ts";

/**
 * Longest time in milliseconds a broken-off flight takes to come to rest, at
 * normal speed. From the peak speed this brakes about as hard as the end of a
 * flight of a little over two seconds.
 */
export const BRAKE_DURATION = 600;

/** The transition to play once the broken-off motion has come to rest. */
export interface NextTransition {
  readonly transition: AnyTransition;
  /** The stop's options, as read by the transition's `read`. */
  readonly options: unknown;
  /** The goal; in the same space as the running motion's views. */
  readonly to: CameraView;
  /** Size of the screen in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/** A piece of a motion, and the view it ends in, at rest. */
interface Lead {
  readonly duration: number;
  frame(time: number): MotionFrame;
  readonly rest: CameraView;
}

function scaleOf(durationScale: number): number {
  return Number.isFinite(durationScale) && durationScale > 0 ? durationScale : 1;
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.space === b.space && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}

function still(view: CameraView): Lead {
  return { duration: 0, frame: () => ({ kind: "view", view }), rest: view };
}

/**
 * Time warp of a smooth stop over `duration`: its rate falls from 1 to 0 along
 * a raised cosine, so both the speed and the acceleration of whatever it warps
 * are continuous where the stop begins. It advances by duration / 2.
 */
function brakeWarp(time: number, duration: number): number {
  if (!(time > 0)) return 0;
  if (time >= duration) return duration / 2;
  return time / 2 + (duration / (2 * Math.PI)) * Math.sin((Math.PI * time) / duration);
}

/** A cross-fade frame between `from` and `to`, or one of them at the ends. */
function blendFrame(from: CameraView, to: CameraView, mix: number): MotionFrame {
  if (!(mix > 0)) return { kind: "view", view: from };
  if (mix >= 1) return { kind: "view", view: to };
  return { kind: "blend", from, to, mix };
}

/**
 * The mix of `frame` as a cross-fade from `from` to `to`, or undefined when it
 * shows anything else.
 */
function mixOf(frame: MotionFrame, from: CameraView, to: CameraView): number | undefined {
  if (frame.kind === "view") {
    if (sameView(frame.view, from)) return 0;
    if (sameView(frame.view, to)) return 1;
    return undefined;
  }
  if (sameView(frame.from, from) && sameView(frame.to, to)) return frame.mix;
  if (sameView(frame.from, to) && sameView(frame.to, from)) return 1 - frame.mix;
  return undefined;
}

/** The rate of change of a cross-fade's mix at `time`, per millisecond. */
function mixRate(
  motion: CameraMotion,
  time: number,
  duration: number,
  from: CameraView,
  to: CameraView,
  mix: number,
): number {
  const step = 0.5;
  const before =
    time - step >= 0 ? mixOf(motion.frame(time - step), from, to) : undefined;
  const after =
    time + step <= duration ? mixOf(motion.frame(time + step), from, to) : undefined;
  if (before !== undefined && after !== undefined) return (after - before) / (2 * step);
  if (after !== undefined) return (after - mix) / step;
  if (before !== undefined) return (mix - before) / step;
  return 0;
}

/**
 * A flight broken off at `time`: it goes on along its own path while its speed
 * falls smoothly to zero, within BRAKE_DURATION (less if the flight would end
 * sooner, so it never passes the goal).
 */
function brake(
  motion: CameraMotion,
  time: number,
  duration: number,
  scale: number,
): Lead {
  const length = Math.min(BRAKE_DURATION * scale, 2 * (duration - time));
  return {
    duration: length,
    frame: (t) => motion.frame(time + brakeWarp(t, length)),
    rest: restOf(motion.frame(time + length / 2)),
  };
}

function restOf(frame: MotionFrame): CameraView {
  if (frame.kind === "view") return frame.view;
  return frame.mix < 0.5 ? frame.from : frame.to;
}

/**
 * A cross-fade between `from` and `to`, at `mix` and changing by `rate` per
 * millisecond, brought smoothly to the end where one of the two views fills
 * the screen: the end `toward` points at (the next goal) if it is one of the
 * two, otherwise the one that dominates once the fade has slowed down. It
 * never shows another view.
 */
function settleBlend(
  from: CameraView,
  to: CameraView,
  mix: number,
  rate: number,
  toward: CameraView | undefined,
  scale: number,
): Lead {
  const stop = (FADE_DURATION * scale) / 4;
  const end =
    toward && sameView(toward, to)
      ? 1
      : toward && sameView(toward, from)
        ? 0
        : // The view that dominates once the fade has slowed down.
          mix + rate * (stop / 2) >= 0.5
          ? 1
          : 0;
  const rest = end === 1 ? to : from;
  if (!(Math.abs(end - mix) > 0)) return still(rest);
  if (rate * (end - mix) >= 0) {
    // Heading for the end already (or at rest): one cubic from the current
    // mix and rate to the end at rest. Its duration grows with the square
    // root of the distance, so a short one is not abrupt, and is short enough
    // that the cubic never passes the end.
    const distance = end - mix;
    let length = FADE_DURATION * scale * Math.sqrt(Math.abs(distance));
    if (Math.abs(rate) * length > 3 * Math.abs(distance))
      length = (3 * Math.abs(distance)) / Math.abs(rate);
    const slope = rate * length;
    return {
      duration: length,
      frame(t) {
        if (!(t > 0)) return blendFrame(from, to, mix);
        if (t >= length) return blendFrame(from, to, end);
        const s = t / length;
        const u = 1 - s;
        // Cubic Hermite: from (mix, slope) at s = 0 to (end, 0) at s = 1.
        const value = mix + distance * s * s * (3 - 2 * s) + slope * s * u * u;
        return blendFrame(from, to, Math.min(1, Math.max(0, value)));
      },
      rest,
    };
  }
  // Heading away from the end: slow down smoothly (in a quarter of a
  // cross-fade, or sooner if the other end is near, so it never gets there),
  // then go to the end from rest.
  const room = rate > 0 ? 1 - mix : mix;
  const turn = Math.min(stop, room / Math.abs(rate));
  const turned = Math.min(1, Math.max(0, mix + rate * (turn / 2)));
  const back = settleBlend(from, to, turned, 0, toward, scale);
  return {
    duration: turn + back.duration,
    frame(t) {
      if (t < turn) {
        const value = mix + rate * brakeWarp(t, turn);
        return blendFrame(from, to, Math.min(1, Math.max(0, value)));
      }
      return back.frame(t - turn);
    },
    rest,
  };
}

/**
 * Breaks off `running` (a motion as the player plays it, guarded) at `time`
 * milliseconds after its start, without a jump in the view or its speed, and
 * returns the motion to play from then on, starting at its time 0:
 *
 * - On a flight, the camera goes on along the path and slows down smoothly to
 *   rest (BRAKE_DURATION at most, times `durationScale`).
 * - On a cross-fade, the fade goes on, or turns back smoothly, between the two
 *   views it shows, until one of them fills the screen: the one that is the
 *   next goal, if either is, otherwise the one that dominates once the fade
 *   has slowed down.
 * - Then `next` is planned from the view it came to rest at, with `comfort`,
 *   and guarded with guardComfort, so the result must not be guarded again.
 *   Without `next` the motion ends at rest (the presenter takes over).
 * - With `comfort.reducedMotion` (also when it has just been switched on), a
 *   flight stops where it is instead, and the next transition starts from the
 *   view on screen. No frame of the result then shows a view other than what
 *   was on screen when it was broken off and the goal.
 *
 * The result can itself be broken off the same way.
 */
export function breakOff(
  running: CameraMotion,
  time: number,
  comfort: ComfortSettings,
  next?: NextTransition,
): CameraMotion {
  const scale = scaleOf(comfort.durationScale);
  const duration = Number.isFinite(running.duration) ? Math.max(0, running.duration) : 0;
  const at = time > 0 ? Math.min(time, duration) : 0;
  const frame = running.frame(at);
  let lead: Lead;
  if (frame.kind === "view") {
    lead =
      comfort.reducedMotion || at <= 0 || at >= duration
        ? still(frame.view)
        : brake(running, at, duration, scale);
  } else {
    const rate = mixRate(running, at, duration, frame.from, frame.to, frame.mix);
    lead = settleBlend(frame.from, frame.to, frame.mix, rate, next?.to, scale);
  }
  // A flight that comes to rest in a cross-fade (only a transition that mixes
  // the two would) settles that cross-fade too.
  const restFrame = lead.frame(lead.duration);
  if (restFrame.kind === "blend") {
    const settle = settleBlend(
      restFrame.from,
      restFrame.to,
      restFrame.mix,
      0,
      next?.to,
      scale,
    );
    lead = then(lead, settle, settle.rest);
  }
  if (next) {
    const from = lead.rest;
    const planned = next.transition.plan({
      from,
      to: next.to,
      options: next.options,
      comfort,
      viewport: next.viewport,
    });
    lead = then(lead, guardComfort(planned, from, next.to, comfort), next.to);
  }
  const result = lead;
  return { duration: result.duration, frame: (t) => result.frame(t) };
}

/** `first`, then `second`. */
function then(first: Lead, second: CameraMotion, rest: CameraView): Lead {
  const secondDuration = Number.isFinite(second.duration)
    ? Math.max(0, second.duration)
    : 0;
  const duration = first.duration + secondDuration;
  return {
    duration,
    frame(t) {
      if (!(t >= first.duration)) return first.frame(t);
      // Exactly the end of `second` at the end, whatever the rounding of the sum.
      return second.frame(t >= duration ? secondDuration : t - first.duration);
    },
    rest,
  };
}
