// SPDX-License-Identifier: GPL-3.0-or-later

// The flight path of van Wijk and Nuij, "Smooth and efficient zooming and
// panning" (2003): known values, a check against the paper's own equations, and
// the extreme cases (no motion, only zoom, only panning, a zoom ratio of 2^60,
// coordinates far from the origin).

import type { CameraView } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { flightPath, metricDistance, RHO } from "./flight.ts";

const W = 1000;

/**
 * The metric distance between two views, written out independently of the
 * code under test: with x = rho^2 * u and y = w, the metric of the paper,
 * ds^2 = (rho^2 du^2 + dw^2 / rho^2) / w^2, is the hyperbolic half-plane metric
 * divided by rho, whose distance is 2 asinh(|P - Q| / (2 sqrt(y_P y_Q))).
 */
function distance(a: CameraView, b: CameraView, width = W, rho = RHO): number {
  const wa = width / a.zoom;
  const wb = width / b.zoom;
  const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  return (
    (2 * Math.asinh(Math.hypot(rho * rho * d, wb - wa) / (2 * Math.sqrt(wa * wb)))) / rho
  );
}

/**
 * Equations (9) of the paper, as printed: the optimal path between (u0, w0)
 * and (u1, w1) for u0 != u1, at path length s. Fine for moderate values.
 */
function paperPath(u0: number, w0: number, u1: number, w1: number, rho: number) {
  const b = (i: 0 | 1) =>
    (w1 * w1 - w0 * w0 + (i === 0 ? 1 : -1) * rho ** 4 * (u1 - u0) ** 2) /
    (2 * (i === 0 ? w0 : w1) * rho * rho * (u1 - u0));
  const r = (i: 0 | 1) => Math.log(-b(i) + Math.sqrt(b(i) ** 2 + 1));
  const r0 = r(0);
  const r1 = r(1);
  return {
    S: (r1 - r0) / rho,
    u: (s: number) =>
      (w0 / rho ** 2) * Math.cosh(r0) * Math.tanh(rho * s + r0) -
      (w0 / rho ** 2) * Math.sinh(r0) +
      u0,
    w: (s: number) => (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0),
  };
}

function finite(view: CameraView): boolean {
  return (
    Number.isFinite(view.cx) && Number.isFinite(view.cy) && Number.isFinite(view.zoom)
  );
}

/**
 * Samples the path at n + 1 evenly spaced lengths and checks that consecutive
 * views are as far apart in the metric as the lengths say: no jumps, no stalls.
 * `slack` is an absolute tolerance in metric units, for cameras whose rounding
 * (the precision budget of the model, 1/64 pixel) is larger than 1e-6 of a step.
 */
function checkSteps(
  from: CameraView,
  to: CameraView,
  n = 2000,
  slack = 1e-12,
  width = W,
): CameraView[] {
  const path = flightPath(from, to, width);
  const views: CameraView[] = [];
  for (let i = 0; i <= n; i++) views.push(path.at((path.length * i) / n));
  for (let i = 0; i < n; i++) {
    const a = views[i]!;
    const b = views[i + 1]!;
    expect(finite(a), `view ${i}`).toBe(true);
    expect(a.zoom).toBeGreaterThan(0);
    const step = distance(a, b, width);
    expect(Math.abs(step - path.length / n), `step ${i}`).toBeLessThan(
      1e-6 * (path.length / n) + slack,
    );
  }
  return views;
}

describe("flight path", () => {
  it("uses rho = sqrt(2), the value the paper's user test points to", () => {
    expect(RHO).toBe(Math.SQRT2);
  });

  it("has known values for a pan of one screen width", () => {
    const from: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
    const to: CameraView = { space: null, cx: 1000, cy: 0, zoom: 1 };
    const path = flightPath(from, to, W);
    // 2 asinh(rho^2 * d / (2 w)) / rho with rho^2 d = 2 w: 2 asinh(1) / sqrt(2).
    expect(path.length).toBeCloseTo(1.246450480280461, 14);
    expect(metricDistance(from, to, W)).toBeCloseTo(1.246450480280461, 14);
    // Halfway: over the middle, at the top of the arc. With x = rho^2 u the
    // path is a half circle around the middle with radius
    // sqrt((rho^2 d / 2)^2 + w^2) = sqrt(2) w, so the view is sqrt(2) times wider.
    const mid = path.at(path.length / 2);
    expect(mid.cx).toBeCloseTo(500, 9);
    expect(mid.cy).toBe(0);
    expect(mid.zoom).toBeCloseTo(Math.SQRT1_2, 14);
    expect(mid.space).toBeNull();
  });

  it("has known values for a zoom by four", () => {
    const from: CameraView = { space: "f1", cx: 10, cy: 20, zoom: 1 };
    const to: CameraView = { space: "f1", cx: 10, cy: 20, zoom: 4 };
    const path = flightPath(from, to, W);
    // |ln(w1 / w0)| / rho.
    expect(path.length).toBeCloseTo(Math.log(4) / Math.SQRT2, 14);
    expect(path.length).toBeCloseTo(0.9802581434685471, 14);
    const quarter = path.at(path.length / 4);
    const mid = path.at(path.length / 2);
    // The zoom changes at a constant rate: sqrt(2) halfway, sqrt(sqrt(2)) at a
    // quarter. The centre does not move at all.
    expect(mid.zoom).toBeCloseTo(2, 14);
    expect(quarter.zoom).toBeCloseTo(Math.SQRT2, 14);
    expect(mid).toMatchObject({ space: "f1", cx: 10, cy: 20 });
    expect(quarter).toMatchObject({ space: "f1", cx: 10, cy: 20 });
  });

  it("follows the paper's equations", () => {
    const cases: Array<[CameraView, CameraView, number]> = [
      [
        { space: null, cx: 0, cy: 0, zoom: 1 },
        { space: null, cx: 3000, cy: 4000, zoom: 0.5 },
        1000,
      ],
      [
        { space: null, cx: 100, cy: -50, zoom: 2 },
        { space: null, cx: -400, cy: 1150, zoom: 16 },
        1280,
      ],
      [
        { space: null, cx: 0, cy: 0, zoom: 3 },
        { space: null, cx: 0, cy: 90, zoom: 3 },
        800,
      ],
    ];
    for (const [from, to, width] of cases) {
      const d = Math.hypot(to.cx - from.cx, to.cy - from.cy);
      const paper = paperPath(0, width / from.zoom, d, width / to.zoom, RHO);
      const path = flightPath(from, to, width);
      expect(path.length).toBeCloseTo(paper.S, 12);
      expect(distance(from, to, width)).toBeCloseTo(paper.S, 12);
      for (let k = 0; k <= 16; k++) {
        const s = (paper.S * k) / 16;
        const view = path.at(s);
        const u = paper.u(s);
        const zoom = width / paper.w(s);
        expect(view.cx).toBeCloseTo(from.cx + ((to.cx - from.cx) * u) / d, 8);
        expect(view.cy).toBeCloseTo(from.cy + ((to.cy - from.cy) * u) / d, 8);
        expect(Math.abs(view.zoom / zoom - 1)).toBeLessThan(1e-11);
      }
    }
  });

  it("hits the start and the goal exactly", () => {
    const from: CameraView = { space: "a", cx: 0.1, cy: 0.7, zoom: 3.3 };
    const to: CameraView = { space: "a", cx: -123.456, cy: 78.9, zoom: 0.017 };
    const path = flightPath(from, to, 1366);
    expect(path.at(0)).toEqual(from);
    expect(path.at(path.length)).toEqual(to);
    expect(path.atFromEnd(0)).toEqual(to);
    expect(path.atFromEnd(path.length)).toEqual(from);
    // Outside the path it stays at the ends.
    expect(path.at(-1)).toEqual(from);
    expect(path.at(path.length + 1)).toEqual(to);
    // The two halves meet without a gap.
    const a = path.at(path.length / 2 - 1e-9);
    const b = path.at(path.length / 2 + 1e-9);
    expect(distance(a, b, 1366)).toBeLessThan(1e-8);
  });

  it("is the same path backwards", () => {
    const a: CameraView = { space: null, cx: 5, cy: -7, zoom: 0.25 };
    const b: CameraView = { space: null, cx: 2500, cy: 600, zoom: 12 };
    const forth = flightPath(a, b, W);
    const back = flightPath(b, a, W);
    expect(back.length).toBe(forth.length);
    for (let k = 0; k <= 20; k++) {
      const s = (forth.length * k) / 20;
      const p = forth.at(s);
      const q = back.at(forth.length - s);
      expect(distance(p, q)).toBeLessThan(1e-9);
      // at() and atFromEnd() of the reversed path agree too.
      expect(distance(forth.atFromEnd(s), back.at(s))).toBeLessThan(1e-12);
    }
  });

  it("is mirror symmetric for a pan between equal zooms", () => {
    const from: CameraView = { space: null, cx: -300, cy: 40, zoom: 2 };
    const to: CameraView = { space: null, cx: 900, cy: 40, zoom: 2 };
    const path = flightPath(from, to, W);
    for (let k = 0; k <= 10; k++) {
      const s = (path.length * k) / 20;
      const p = path.at(s);
      const q = path.at(path.length - s);
      expect(p.zoom).toBeCloseTo(q.zoom, 12);
      expect(p.cx - -300).toBeCloseTo(900 - q.cx, 9);
      expect(p.cy).toBe(40);
      expect(q.cy).toBe(40);
    }
    // The view zooms out on the way and back in, never beyond the ends.
    expect(path.at(path.length / 2).zoom).toBeLessThan(2);
  });

  it("moves at a constant metric speed", () => {
    checkSteps(
      { space: null, cx: 0, cy: 0, zoom: 1 },
      { space: null, cx: 5000, cy: -2000, zoom: 6 },
    );
  });

  it("stands still when start and goal are the same", () => {
    const view: CameraView = { space: "x", cx: 3, cy: 4, zoom: 5 };
    const path = flightPath(view, { ...view }, W);
    expect(path.length).toBe(0);
    expect(path.at(0)).toEqual(view);
    expect(path.atFromEnd(0)).toEqual(view);
    expect(metricDistance(view, view, W)).toBe(0);
  });

  it("only zooms when the centres are the same", () => {
    const from: CameraView = { space: null, cx: 12.5, cy: -8, zoom: 40 };
    const to: CameraView = { space: null, cx: 12.5, cy: -8, zoom: 0.3 };
    const views = checkSteps(from, to, 400);
    for (let i = 1; i < views.length; i++) {
      expect(views[i]!.cx).toBe(12.5);
      expect(views[i]!.cy).toBe(-8);
      expect(views[i]!.zoom).toBeLessThan(views[i - 1]!.zoom);
    }
  });

  it("only pans along the line between the centres at equal zooms", () => {
    const from: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
    const to: CameraView = { space: null, cx: 30, cy: 40, zoom: 1 };
    const views = checkSteps(from, to, 400);
    for (const view of views) {
      // On the segment: cy / cx = 4 / 3, between the ends.
      expect(view.cy * 3).toBeCloseTo(view.cx * 4, 9);
      expect(view.cx).toBeGreaterThanOrEqual(0);
      expect(view.cx).toBeLessThanOrEqual(30);
      expect(view.zoom).toBeLessThanOrEqual(1);
    }
  });

  it("handles a zoom ratio of 2^60 without NaN, infinity or jumps", () => {
    const length = (60 * Math.LN2) / Math.SQRT2;
    // Only zoom.
    {
      const from: CameraView = { space: null, cx: 0, cy: 0, zoom: 2 ** -30 };
      const to: CameraView = { space: null, cx: 0, cy: 0, zoom: 2 ** 30 };
      const path = flightPath(from, to, W);
      expect(path.length).toBeCloseTo(length, 12);
      expect(Math.abs(path.at(path.length / 2).zoom - 1)).toBeLessThan(1e-12);
      const views = checkSteps(from, to, 3000);
      for (let i = 1; i < views.length; i++)
        expect(views[i]!.zoom).toBeGreaterThan(views[i - 1]!.zoom);
    }
    // Zoom and a small move, in both directions, near the deep end.
    for (const [from, to] of [
      [
        { space: "f", cx: 5, cy: -3, zoom: 2 ** -30 },
        { space: "f", cx: 5 + 2 ** -20, cy: -3 - 2 ** -21, zoom: 2 ** 30 },
      ],
      [
        { space: "f", cx: 5 + 2 ** -20, cy: -3 - 2 ** -21, zoom: 2 ** 30 },
        { space: "f", cx: 5, cy: -3, zoom: 2 ** -30 },
      ],
    ] as Array<[CameraView, CameraView]>) {
      const views = checkSteps(from, to, 3000);
      const path = flightPath(from, to, W);
      expect(path.at(path.length)).toEqual(to);
      for (const view of views) {
        expect(view.cx).toBeGreaterThanOrEqual(5);
        expect(view.cx).toBeLessThanOrEqual(5 + 2 ** -20);
      }
      // Near the deep end, on screen, the centre moves no faster than the
      // metric allows (du / w <= ds / rho): the deep end is as smooth as the
      // rest, whatever the magnitude of the numbers.
      const deep = from.zoom > to.zoom ? views.slice(0, 50) : views.slice(-50);
      for (let i = 1; i < deep.length; i++) {
        const pixels =
          Math.hypot(deep[i]!.cx - deep[i - 1]!.cx, deep[i]!.cy - deep[i - 1]!.cy) *
          Math.max(deep[i]!.zoom, deep[i - 1]!.zoom);
        expect(pixels).toBeLessThanOrEqual(((path.length / 3000) * W * 1.05) / RHO);
      }
    }
    // A wide move from the smallest zoom of the model to the largest zoom the
    // precision budget allows a million units from the origin (2^46 / 10^6).
    // One pixel on screen is about rho / 1000 in the metric, so a slack of
    // 5e-5 is well within 1/64 pixel.
    checkSteps(
      { space: null, cx: -1e6, cy: 0, zoom: 2 ** -32 },
      { space: null, cx: 1e6, cy: 1, zoom: 2 ** 26 },
      3000,
      5e-5,
    );
  });

  it("stays precise far from the origin of its space", () => {
    const from: CameraView = { space: null, cx: 2 ** 40, cy: 0, zoom: 32 };
    const to: CameraView = { space: null, cx: 2 ** 40 + 100, cy: 50, zoom: 16 };
    // Within the precision budget (2^40 * 32 = 2^45), rounding is up to 1/128
    // pixel per coordinate.
    const views = checkSteps(from, to, 1000, 5e-5);
    for (const view of views) {
      expect(view.cx).toBeGreaterThanOrEqual(2 ** 40);
      expect(view.cx).toBeLessThanOrEqual(2 ** 40 + 100);
    }
  });

  it("depends on the screen width the way the metric says", () => {
    const from: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
    const to: CameraView = { space: null, cx: 1000, cy: 0, zoom: 1 };
    // Twice the width: the same move is half a screen width.
    expect(metricDistance(from, to, 2000)).toBeCloseTo(
      (2 * Math.asinh(0.5)) / Math.SQRT2,
      14,
    );
  });
});

/** A small seeded generator (mulberry32), so the random cases repeat. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_ZOOM = 2 ** -32;
const MAX_ZOOM = 2 ** 32;
/** Coordinate times zoom stays below this, the model's precision budget. */
const BUDGET = 2 ** 46;

/**
 * A random pair of views and a screen width: zooms from 2^-32 to what the
 * precision budget allows, coordinates from 1e-3 to 1e9 from the origin,
 * distances from 1e-12 to 1e6 widths of the wider view, zoom ratios that are
 * exactly or nearly 1, and screens from 320 to 3840 pixels wide.
 */
function randomCase(r: () => number): [CameraView, CameraView, number] {
  const width = [320, 400, 1000, 1920, 3840][Math.floor(r() * 5)]!;
  const cx = 10 ** (r() * 12 - 3) * (r() < 0.5 ? -1 : 1);
  const cy = cx * (r() - 0.5);
  const maxZ = Math.min(MAX_ZOOM, BUDGET / Math.max(Math.abs(cx), Math.abs(cy), 1));
  const lz = () => Math.log2(MIN_ZOOM) + r() * (Math.log2(maxZ) - Math.log2(MIN_ZOOM));
  const z0 = 2 ** lz();
  let z1 = 2 ** lz();
  if (r() < 0.25) z1 = z0 * (1 + (r() - 0.5) * 1e-9);
  if (r() < 0.1) z1 = z0;
  const widths = 10 ** (r() * 18 - 12);
  const dist = (widths * width) / Math.min(z0, z1);
  const angle = r() * 2 * Math.PI;
  const tx = cx + dist * Math.cos(angle);
  const ty = cy + dist * Math.sin(angle);
  const toMax = Math.min(MAX_ZOOM, BUDGET / Math.max(Math.abs(tx), Math.abs(ty), 1));
  return [
    { space: null, cx, cy, zoom: z0 },
    { space: null, cx: tx, cy: ty, zoom: Math.min(z1, toMax) },
    width,
  ];
}

describe("flight path, random extreme cases", () => {
  it("has no jump where the start's half meets the goal's half", () => {
    const r = rng(13);
    let worst = 0;
    let worstCase = "";
    for (let i = 0; i < 20000; i++) {
      const [from, to, width] = randomCase(r);
      const path = flightPath(from, to, width);
      if (!(path.length > 0)) continue;
      const half = path.length / 2;
      const a = path.at(half);
      const b = path.at(half + half * 2 ** -50);
      const pixels = Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.max(a.zoom, b.zoom);
      const zoomJump = Math.abs(Math.log(b.zoom / a.zoom)) * width;
      const jump = Math.max(pixels, zoomJump);
      if (jump > worst) {
        worst = jump;
        worstCase = JSON.stringify({ from, to, width, a, b });
      }
    }
    // More than 1/64 pixel at the midpoint would be a loss of precision.
    expect(worst, worstCase).toBeLessThan(1 / 64);
  });

  it("never goes back or overshoots, turns its zoom at most once, and steps as the metric says", () => {
    const r = rng(7);
    const failures: string[] = [];
    for (let i = 0; i < 20000 && failures.length < 5; i++) {
      const [from, to, width] = randomCase(r);
      const path = flightPath(from, to, width);
      if (!(path.length > 0)) continue;
      const n = 400;
      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const dd = dx * dx + dy * dy;
      let prevShare = -Infinity;
      let prev: CameraView | null = null;
      let turns = 0;
      let dir = 0;
      const where = () => JSON.stringify({ from, to, width });
      for (let k = 0; k <= n; k++) {
        const v = path.at((path.length * k) / n);
        if (!finite(v) || !(v.zoom > 0)) {
          failures.push(`not a view at ${k}: ${where()}`);
          break;
        }
        if (dd > 0) {
          const share = ((v.cx - from.cx) * dx + (v.cy - from.cy) * dy) / dd;
          // In pixels at this view's zoom; 1/64 pixel is the model's budget.
          const px = (x: number) => x * Math.sqrt(dd) * v.zoom;
          if (
            px(prevShare - share) > 1 / 64 ||
            px(-share) > 1 / 64 ||
            px(share - 1) > 1 / 64
          ) {
            failures.push(`share ${share} after ${prevShare} at ${k}: ${where()}`);
            break;
          }
          prevShare = Math.max(prevShare, share);
        }
        if (prev) {
          const d = Math.sign(Math.round(Math.log2(v.zoom / prev.zoom) * 1e9));
          if (d !== 0 && dir !== 0 && d !== dir) turns++;
          if (d !== 0) dir = d;
          const step = distance(prev, v, width);
          const want = path.length / n;
          // 1/64 pixel of slack, in metric units.
          if (Math.abs(step - want) > 1e-6 * want + (RHO / width) * (1 / 64) * 4) {
            failures.push(`step ${step} instead of ${want} at ${k}: ${where()}`);
            break;
          }
        }
        prev = v;
      }
      if (turns > 1) failures.push(`zoom turned ${turns} times: ${where()}`);
    }
    expect(failures).toEqual([]);
    // Its own time limit: 8 million path evaluations, slower in a busy run.
  }, 60_000);
});
