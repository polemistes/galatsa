// SPDX-License-Identifier: GPL-3.0-or-later

// Steering a running transition onto a goal that moved a little: the screen
// changed size (the stop is fitted again), or the document changed the stop
// slightly. Instead of braking and planning anew, which is a visible stop in
// the middle of the motion, a correction is laid over the motion: it grows
// from what it was to the whole move of the goal by the end of the motion,
// along a cubic curve that starts with the correction's own speed and ends at
// rest. So neither the picture nor its speed jumps, and the camera arrives at
// the new goal when the motion would have arrived at the old one (or a little
// later, when little time was left). See docs/adr/0015-presentation.md.

import type { CameraView } from "@galatsa/core";

/** A change of a view: its centre moved by (x, y) in its space, its zoom scaled by e^z. */
export interface Shift {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const NO_SHIFT: Shift = { x: 0, y: 0, z: 0 };

/** One change of course, and the one before it (for times before it began). */
export interface Steer {
  /** When it began and when it is complete, in the motion's own time. */
  readonly start: number;
  readonly end: number;
  /** The correction when it began, and its speed then (per millisecond). */
  readonly from: Shift;
  readonly speed: Shift;
  /** The whole correction, from `end` on. */
  readonly to: Shift;
  readonly before: Steer | null;
}

/** The shortest time a correction is spread over, in milliseconds. */
export const MIN_STEER_MS = 400;

/** At most this many changes of course are kept for times before the last one. */
const KEEP = 8;

function find(steer: Steer | null, time: number): Steer | null {
  let s = steer;
  while (s !== null && time < s.start) s = s.before;
  return s;
}

function mix(a: Shift, b: Shift, c: Shift, wa: number, wb: number, wc: number): Shift {
  return {
    x: a.x * wa + b.x * wb + c.x * wc,
    y: a.y * wa + b.y * wb + c.y * wc,
    z: a.z * wa + b.z * wb + c.z * wc,
  };
}

/** The correction at `time` (in the motion's own time). */
export function shiftAt(steer: Steer | null, time: number): Shift {
  const s = find(steer, time);
  if (s === null) return NO_SHIFT;
  const span = s.end - s.start;
  if (!(span > 0) || time >= s.end) return s.to;
  const u = (time - s.start) / span;
  const u2 = u * u;
  const u3 = u2 * u;
  // Cubic Hermite from (from, speed) to (to, at rest).
  return mix(
    s.from,
    s.speed,
    s.to,
    2 * u3 - 3 * u2 + 1,
    (u3 - 2 * u2 + u) * span,
    3 * u2 - 2 * u3,
  );
}

/** How fast the correction changes at `time`, per millisecond. */
export function shiftSpeed(steer: Steer | null, time: number): Shift {
  const s = find(steer, time);
  if (s === null) return NO_SHIFT;
  const span = s.end - s.start;
  if (!(span > 0) || time >= s.end) return NO_SHIFT;
  const u = (time - s.start) / span;
  const u2 = u * u;
  return mix(
    s.from,
    s.speed,
    s.to,
    (6 * u2 - 6 * u) / span,
    3 * u2 - 4 * u + 1,
    (6 * u - 6 * u2) / span,
  );
}

/**
 * A new change of course at `time`: the whole correction is to be `to` by
 * `end`, starting from where the correction is now, at its present speed.
 */
export function steer(old: Steer | null, time: number, end: number, to: Shift): Steer {
  // Only the last few are kept for times before `time`: nothing looks far back.
  let before = old;
  let kept = 0;
  for (let s = old; s !== null && kept < KEEP; s = s.before) kept++;
  if (kept >= KEEP) before = trim(old, KEEP - 1);
  return {
    start: time,
    end,
    from: shiftAt(old, time),
    speed: shiftSpeed(old, time),
    to,
    before,
  };
}

function trim(steer: Steer | null, keep: number): Steer | null {
  if (steer === null || keep <= 0) return null;
  return { ...steer, before: trim(steer.before, keep - 1) };
}

/** `view` changed by `shift`. */
export function shiftView(view: CameraView, shift: Shift): CameraView {
  if (shift === NO_SHIFT) return view;
  return {
    space: view.space,
    cx: view.cx + shift.x,
    cy: view.cy + shift.y,
    zoom: view.zoom * Math.exp(shift.z),
  };
}

/** The change that takes view `a` to view `b` (both in the same space). */
export function shiftBetween(a: CameraView, b: CameraView): Shift {
  return { x: b.cx - a.cx, y: b.cy - a.cy, z: Math.log(b.zoom / a.zoom) };
}
