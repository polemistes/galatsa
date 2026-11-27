// SPDX-License-Identifier: GPL-3.0-or-later

// The camera path of J. J. van Wijk and W. A. A. Nuij, "Smooth and efficient
// zooming and panning" (IEEE InfoVis 2003, https://vanwijk.win.tue.nl/zoompan.pdf).
//
// The paper measures a camera motion by how fast the image seems to move: with
// u the position along the line between the two centres and w the width of the
// view in world units,
//
//   ds^2 = (rho^2 du^2 + dw^2 / rho^2) / w^2                  (its equation 7)
//
// and the optimal path from one view to another is the shortest path in this
// metric. rho trades zooming for panning: a larger rho zooms out further.
//
// The paper gives the path in closed form (its equations 9). Those formulas
// divide by the distance between the centres and subtract nearly equal
// numbers when one view is much smaller than the other, so they break down
// for a pure zoom and lose all precision at the zoom ratios this program
// allows (up to 2^64). This file uses the same path written differently. With
// x = rho^2 u and y = w, the metric is the hyperbolic metric of the upper half
// plane divided by rho, so the path is a hyperbolic geodesic (a half circle
// centred on y = 0, or a vertical line) and:
//
// - Its length is 2 asinh(|P1 - P0| / (2 sqrt(y0 y1))) / rho, which has no
//   cancellation and no division by the distance.
// - The point at hyperbolic distance sigma from P0, leaving in the direction
//   (cos phi, sin phi), is
//     x = x0 + y0 sinh(sigma) cos(phi) / D,   y = y0 / D,
//     D = cosh(sigma) - sinh(sigma) sin(phi).
//   D is computed as a sum of positive terms (see `side`), so it keeps its
//   relative precision even when D is about 2^-64, and the zoom along the way
//   is simply the start's zoom times D.
// - The first half of the path is computed from the start and the second half
//   from the goal, so each end is reached with the precision of that end, and
//   the path from B to A is the path from A to B backwards.
//
// The inputs are scaled so that the largest of the two widths and the distance
// is 1 (the path is the same at every scale), so no square overflows.

import type { CameraView } from "@galatsa/core";

/**
 * The trade-off between zooming and panning. The 26 users in the paper's
 * experiment chose 1.42 on average (standard deviation 0.47), and the authors
 * suggest sqrt(2).
 */
export const RHO: number = Math.SQRT2;

/**
 * A flight from one view to another. The views must be in the same space,
 * with finite centres and positive, finite zooms.
 */
export interface FlightPath {
  /** Length in the metric of van Wijk and Nuij; 0 when the views are the same. */
  readonly length: number;
  /** The view at metric distance `s` from the start along the path. */
  at(s: number): CameraView;
  /** The view at metric distance `s` before the goal along the path. */
  atFromEnd(s: number): CameraView;
}

interface Geometry {
  /** Hyperbolic length (rho times the metric length). */
  readonly sigma: number;
  /** Widths and the distance times rho^2, scaled so the largest is 1. */
  readonly y0: number;
  readonly y1: number;
  readonly x: number;
}

function geometry(
  from: CameraView,
  to: CameraView,
  viewportWidth: number,
  rho: number,
): Geometry {
  const w0 = viewportWidth / from.zoom;
  const w1 = viewportWidth / to.zoom;
  const d = rho * rho * Math.hypot(to.cx - from.cx, to.cy - from.cy);
  const scale = Math.max(w0, w1, d);
  const y0 = w0 / scale;
  const y1 = w1 / scale;
  const x = d / scale;
  const sigma = 2 * Math.asinh(Math.hypot(x, y1 - y0) / (2 * Math.sqrt(y0 * y1)));
  return { sigma, y0, y1, x };
}

/**
 * The length of the optimal path between two views, in the metric of van Wijk
 * and Nuij, for a screen `viewportWidth` pixels wide.
 */
export function metricDistance(
  from: CameraView,
  to: CameraView,
  viewportWidth: number,
  rho: number = RHO,
): number {
  return geometry(from, to, viewportWidth, rho).sigma / rho;
}

/**
 * One end's view of the path: for hyperbolic distance sigma from this end,
 * the share of the way between the centres (0 here, 1 at the other end) and
 * the factor by which the zoom has changed.
 */
interface Side {
  share(sigma: number): number;
  zoomFactor(sigma: number): number;
}

/** The path as seen from the end of width ys, towards the end of width ye. */
function side(ys: number, ye: number, x: number): Side {
  // Direction of departure, (cos phi, sin phi) = (a, b) / h, without dividing
  // by x: for x = 0 it is straight up or down (a pure zoom).
  const a = 2 * ys * x;
  const b = ye * ye - ys * ys + x * x;
  const h = Math.hypot(a, b);
  // D(sigma) = cosh(sigma) - sinh(sigma) sin(phi). When sin(phi) is close to 1
  // (zooming out from a much deeper view), cosh - sinh * sin(phi) cancels, so
  // it is written as exp(-sigma) + sinh(sigma) (1 - sin(phi)), with
  // 1 - sin(phi) = a^2 / (h (h + b)).
  const oneMinusSin = b > 0 ? (a / h) * (a / (h + b)) : 0;
  const minusSin = b > 0 ? 0 : -b / h;
  const big = (sigma: number) =>
    b > 0
      ? Math.exp(-sigma) + Math.sinh(sigma) * oneMinusSin
      : Math.cosh(sigma) + Math.sinh(sigma) * minusSin;
  // The share of the way: (x(sigma) - x0) / x = 2 ys^2 sinh(sigma) / (h D).
  const k = 2 * ys * (ys / h);
  return {
    share: (sigma) => Math.min(1, Math.max(0, (k * Math.sinh(sigma)) / big(sigma))),
    zoomFactor: big,
  };
}

function copy(view: CameraView): CameraView {
  return { space: view.space, cx: view.cx, cy: view.cy, zoom: view.zoom };
}

/**
 * The optimal path of van Wijk and Nuij from `from` to `to`, for a screen
 * `viewportWidth` pixels wide. The views it returns are in `from`'s space.
 */
export function flightPath(
  from: CameraView,
  to: CameraView,
  viewportWidth: number,
  rho: number = RHO,
): FlightPath {
  const g = geometry(from, to, viewportWidth, rho);
  const length = g.sigma / rho;
  if (!(length > 0)) {
    return { length: 0, at: () => copy(to), atFromEnd: () => copy(to) };
  }
  const forward = side(g.y0, g.y1, g.x);
  const backward = side(g.y1, g.y0, g.x);
  const fromStart = (s: number): CameraView => {
    const sigma = rho * s;
    const share = forward.share(sigma);
    return {
      space: from.space,
      cx: from.cx + (to.cx - from.cx) * share,
      cy: from.cy + (to.cy - from.cy) * share,
      zoom: from.zoom * forward.zoomFactor(sigma),
    };
  };
  const fromEnd = (s: number): CameraView => {
    const sigma = rho * s;
    const share = backward.share(sigma);
    return {
      space: from.space,
      cx: to.cx + (from.cx - to.cx) * share,
      cy: to.cy + (from.cy - to.cy) * share,
      zoom: to.zoom * backward.zoomFactor(sigma),
    };
  };
  const half = length / 2;
  return {
    length,
    at(s) {
      if (!(s > 0)) return copy(from);
      if (s >= length) return copy(to);
      return s <= half ? fromStart(s) : fromEnd(length - s);
    },
    atFromEnd(s) {
      if (!(s > 0)) return copy(to);
      if (s >= length) return copy(from);
      return s <= half ? fromEnd(s) : fromStart(length - s);
    },
  };
}
