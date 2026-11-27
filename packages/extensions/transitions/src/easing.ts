// SPDX-License-Identifier: GPL-3.0-or-later

// The speed profile of a flight: the camera speeds up smoothly, moves at a
// steady speed, and slows down smoothly, with the stop mirroring the start.
// The ramps follow a raised cosine, so the acceleration is continuous and zero
// at both ends of each ramp: no jolt when the camera sets off, reaches cruising
// speed, starts to brake or stops.

/** Share of the time spent speeding up (and the same share slowing down). */
export const RAMP = 0.25;

function clampRamp(ramp: number): number {
  return Number.isFinite(ramp) ? Math.min(0.5, Math.max(0, ramp)) : RAMP;
}

/**
 * Share of the distance covered after a share `p` of the time, from 0 to 1.
 * With `ramp` = a, the speed rises along a raised cosine for a share a of the
 * time, stays at its peak of 1 / (1 - a) times the mean, and falls the same
 * way. Outside [0, 1] it stays at the ends; NaN counts as the start.
 */
export function smoothProgress(p: number, ramp: number = RAMP): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  const a = clampRamp(ramp);
  if (a === 0) return p;
  // The second half mirrors the first, which makes the profile exactly
  // symmetric and keeps precision near the end.
  if (p > 0.5) return 1 - smoothProgress(1 - p, a);
  const peak = 1 / (1 - a);
  if (p < a) return peak * (p / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * p) / a));
  return peak * (a / 2 + (p - a));
}

/**
 * The speed of smoothProgress, relative to the mean speed: the derivative of
 * smoothProgress with respect to `p`. 0 at both ends (unless `ramp` is 0).
 */
export function smoothSpeed(p: number, ramp: number = RAMP): number {
  const a = clampRamp(ramp);
  if (a === 0) return p > 0 && p < 1 ? 1 : 0;
  if (!(p > 0) || p >= 1) return 0;
  const q = Math.min(p, 1 - p);
  const peak = 1 / (1 - a);
  return q < a ? (peak * (1 - Math.cos((Math.PI * q) / a))) / 2 : peak;
}

/**
 * Opacity of the goal in a cross-fade after a share `p` of the time: a raised
 * cosine, (1 - cos(pi p)) / 2, so the fade starts and ends gently.
 */
export function fadeMix(p: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  return (1 - Math.cos(Math.PI * p)) / 2;
}
