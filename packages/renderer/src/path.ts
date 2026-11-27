// SPDX-License-Identifier: GPL-3.0-or-later

// Paths as element types build them (in their local box), and how they reach the
// canvas. Every point is mapped to device pixels here, in float64, with the
// element's matrix; the canvas itself stays at the identity transform for paths.
//
// Fast path: a path whose device bounds lie within ±SAFE_COORD is handed to the
// canvas as it is (arcs as arcs, curves as curves). The canvas rasterises in
// 32-bit floats, which are exact to well under 1/64 pixel at that size.
//
// Slow path: geometry that reaches beyond that (deep zoom into a large shape) is
// flattened to line segments in float64, subdividing only the parts near the
// visible area, and then clipped to the visible area grown by a margin, so the
// canvas never sees a large coordinate. A fill is clipped polygon by polygon
// (Sutherland–Hodgman, which keeps the winding inside the clip rectangle); a
// stroke is clipped segment by segment (Liang–Barsky), and a dashed stroke keeps
// its dash phase. Joins and caps at the cuts lie outside the visible area.

import type { Path as PathInterface, StrokeStyle } from "@galatsa/extension-api";
import type { CanvasState } from "./canvas.ts";
import type { Matrix } from "./transform.ts";

/** Device coordinates up to this size go to the canvas unchanged. */
export const SAFE_COORD = 2 ** 15;
/** Largest distance, in device pixels, between a curve and its flattening. */
const FLATNESS = 0.25;
const MAX_DEPTH = 52;

const M = 0;
const L = 1;
const Q = 2;
const C = 3;
const A = 4;
const E = 5;
const R = 6;
const RR = 7;
const Z = 8;

const ARGS: readonly number[] = [2, 2, 4, 6, 6, 8, 4, 5, 0];

/** A path recorded in local coordinates. */
export class RecordedPath implements PathInterface {
  /** Opcode followed by its arguments, flat. */
  readonly ops: number[] = [];

  moveTo(x: number, y: number): void {
    this.ops.push(M, x, y);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(L, x, y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push(Q, cx, cy, x, y);
  }
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.ops.push(C, c1x, c1y, c2x, c2y, x, y);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    ccw = false,
  ): void {
    this.ops.push(A, x, y, Math.abs(radius), start, end, ccw ? 1 : 0);
  }
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw = false,
  ): void {
    this.ops.push(
      E,
      cx,
      cy,
      Math.abs(rx),
      Math.abs(ry),
      rotation,
      start,
      end,
      ccw ? 1 : 0,
    );
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(R, x, y, w, h);
  }
  roundRect(x: number, y: number, w: number, h: number, radius: number): void {
    this.ops.push(RR, x, y, w, h, Math.max(0, radius));
  }
  closePath(): void {
    this.ops.push(Z);
  }

  /** True if nothing was recorded. */
  get empty(): boolean {
    return this.ops.length === 0;
  }
}

/** Visits each command with its opcode and the offset of its arguments. */
function each(ops: readonly number[], visit: (op: number, at: number) => void): void {
  for (let i = 0; i < ops.length;) {
    const op = ops[i]!;
    visit(op, i + 1);
    i += 1 + ARGS[op]!;
  }
}

/** Normalised arc sweep, as Canvas 2D defines it. */
function sweep(start: number, end: number, ccw: boolean): number {
  const tau = 2 * Math.PI;
  let d = end - start;
  if (!ccw) {
    if (d >= tau) return tau;
    d %= tau;
    if (d < 0) d += tau;
    return d;
  }
  if (d <= -tau) return -tau;
  d %= tau;
  if (d > 0) d -= tau;
  return d;
}

/** Device bounds of a path under `m`, conservative for curves. */
export function deviceBounds(
  path: RecordedPath,
  m: Matrix,
): [number, number, number, number] {
  const k = Math.hypot(m.a, m.b);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number, r = 0): void => {
    const dx = m.a * x + m.c * y + m.e;
    const dy = m.b * x + m.d * y + m.f;
    if (dx - r < minX) minX = dx - r;
    if (dx + r > maxX) maxX = dx + r;
    if (dy - r < minY) minY = dy - r;
    if (dy + r > maxY) maxY = dy + r;
  };
  const o = path.ops;
  each(o, (op, i) => {
    switch (op) {
      case M:
      case L:
        add(o[i]!, o[i + 1]!);
        break;
      case Q:
        add(o[i]!, o[i + 1]!);
        add(o[i + 2]!, o[i + 3]!);
        break;
      case C:
        add(o[i]!, o[i + 1]!);
        add(o[i + 2]!, o[i + 3]!);
        add(o[i + 4]!, o[i + 5]!);
        break;
      case A:
        add(o[i]!, o[i + 1]!, o[i + 2]! * k);
        break;
      case E:
        add(o[i]!, o[i + 1]!, Math.max(o[i + 2]!, o[i + 3]!) * k);
        break;
      case R:
      case RR:
        add(o[i]!, o[i + 1]!);
        add(o[i]! + o[i + 2]!, o[i + 1]! + o[i + 3]!);
        add(o[i]! + o[i + 2]!, o[i + 1]!);
        add(o[i]!, o[i + 1]! + o[i + 3]!);
        break;
    }
  });
  return [minX, minY, maxX, maxY];
}

/** Hands the path to the canvas as it is, with points mapped to device pixels. */
function emitDirect(state: CanvasState, path: RecordedPath, m: Matrix): void {
  const ctx = state.ctx;
  const k = Math.hypot(m.a, m.b);
  const theta = Math.atan2(m.b, m.a);
  const o = path.ops;
  const X = (x: number, y: number): number => m.a * x + m.c * y + m.e;
  const Y = (x: number, y: number): number => m.b * x + m.d * y + m.f;
  ctx.beginPath();
  each(o, (op, i) => {
    switch (op) {
      case M: {
        const x = o[i]!;
        const y = o[i + 1]!;
        ctx.moveTo(X(x, y), Y(x, y));
        break;
      }
      case L: {
        const x = o[i]!;
        const y = o[i + 1]!;
        ctx.lineTo(X(x, y), Y(x, y));
        break;
      }
      case Q: {
        const [cx, cy, x, y] = [o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!];
        ctx.quadraticCurveTo(X(cx, cy), Y(cx, cy), X(x, y), Y(x, y));
        break;
      }
      case C: {
        const [ax, ay, bx, by, x, y] = [
          o[i]!,
          o[i + 1]!,
          o[i + 2]!,
          o[i + 3]!,
          o[i + 4]!,
          o[i + 5]!,
        ];
        ctx.bezierCurveTo(X(ax, ay), Y(ax, ay), X(bx, by), Y(bx, by), X(x, y), Y(x, y));
        break;
      }
      case A: {
        const [x, y, r, a0, a1, ccw] = [
          o[i]!,
          o[i + 1]!,
          o[i + 2]!,
          o[i + 3]!,
          o[i + 4]!,
          o[i + 5]!,
        ];
        ctx.arc(X(x, y), Y(x, y), r * k, a0 + theta, a1 + theta, ccw === 1);
        break;
      }
      case E: {
        const [x, y, rx, ry, rot, a0, a1, ccw] = [
          o[i]!,
          o[i + 1]!,
          o[i + 2]!,
          o[i + 3]!,
          o[i + 4]!,
          o[i + 5]!,
          o[i + 6]!,
          o[i + 7]!,
        ];
        ctx.ellipse(X(x, y), Y(x, y), rx * k, ry * k, rot + theta, a0, a1, ccw === 1);
        break;
      }
      case R: {
        const [x, y, w, h] = [o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!];
        ctx.moveTo(X(x, y), Y(x, y));
        ctx.lineTo(X(x + w, y), Y(x + w, y));
        ctx.lineTo(X(x + w, y + h), Y(x + w, y + h));
        ctx.lineTo(X(x, y + h), Y(x, y + h));
        ctx.closePath();
        break;
      }
      case RR: {
        const [x, y, w, h, r0] = [o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!, o[i + 4]!];
        const r = Math.min(r0, Math.abs(w) / 2, Math.abs(h) / 2);
        if (r <= 0) {
          ctx.moveTo(X(x, y), Y(x, y));
          ctx.lineTo(X(x + w, y), Y(x + w, y));
          ctx.lineTo(X(x + w, y + h), Y(x + w, y + h));
          ctx.lineTo(X(x, y + h), Y(x, y + h));
          ctx.closePath();
          break;
        }
        const rk = r * k;
        const h2 = Math.PI / 2;
        ctx.moveTo(X(x + r, y), Y(x + r, y));
        ctx.arc(X(x + w - r, y + r), Y(x + w - r, y + r), rk, -h2 + theta, theta);
        ctx.arc(X(x + w - r, y + h - r), Y(x + w - r, y + h - r), rk, theta, h2 + theta);
        ctx.arc(
          X(x + r, y + h - r),
          Y(x + r, y + h - r),
          rk,
          h2 + theta,
          Math.PI + theta,
        );
        ctx.arc(
          X(x + r, y + r),
          Y(x + r, y + r),
          rk,
          Math.PI + theta,
          Math.PI + h2 + theta,
        );
        ctx.closePath();
        break;
      }
      case Z:
        ctx.closePath();
        break;
    }
  });
}

/** A flattened subpath in device pixels. */
export interface Polyline {
  readonly points: number[];
  closed: boolean;
}

/** Flattens a path to device-pixel polylines, finely only near `clip` ([x0, y0, x1, y1]). */
export function flatten(
  path: RecordedPath,
  m: Matrix,
  clip: readonly number[],
): Polyline[] {
  const [cx0, cy0, cx1, cy1] = clip as [number, number, number, number];
  const k = Math.hypot(m.a, m.b);
  const out: Polyline[] = [];
  let current: Polyline | null = null;
  let startX = 0;
  let startY = 0;
  // After closePath (or rect) the current point is the subpath's start, and the
  // next segment starts a new subpath there, as in Canvas 2D.
  let afterClose = false;
  const X = (x: number, y: number): number => m.a * x + m.c * y + m.e;
  const Y = (x: number, y: number): number => m.b * x + m.d * y + m.f;
  const begin = (x: number, y: number): void => {
    current = { points: [x, y], closed: false };
    out.push(current);
    startX = x;
    startY = y;
    afterClose = false;
  };
  /** Makes sure there is a subpath; without a current point it starts at (x, y). */
  const ensure = (x: number, y: number): void => {
    if (current !== null) return;
    if (afterClose) begin(startX, startY);
    else begin(x, y);
  };
  const lineTo = (x: number, y: number): void => {
    if (current === null) {
      const fresh = !afterClose;
      ensure(x, y);
      if (fresh) return;
    }
    (current as Polyline | null)!.points.push(x, y);
  };
  const near = (x0: number, y0: number, x1: number, y1: number, grow: number): boolean =>
    Math.max(x0, x1) + grow >= cx0 &&
    Math.min(x0, x1) - grow <= cx1 &&
    Math.max(y0, y1) + grow >= cy0 &&
    Math.min(y0, y1) - grow <= cy1;

  // An elliptical arc in device space: centre (ex, ey), radii (rx, ry) rotated by phi.
  const arcPoint = (
    ex: number,
    ey: number,
    rx: number,
    ry: number,
    phi: number,
    t: number,
  ) => {
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    return [ex + px * cos - py * sin, ey + px * sin + py * cos] as const;
  };
  const flattenArc = (
    ex: number,
    ey: number,
    rx: number,
    ry: number,
    phi: number,
    t0: number,
    d: number,
  ): void => {
    const [sx, sy] = arcPoint(ex, ey, rx, ry, phi, t0);
    lineTo(sx, sy);
    if (d === 0) return;
    const maxR = Math.max(rx, ry);
    const pieces = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 4)));
    const step = d / pieces;
    const rec = (a: number, b: number, ax: number, ay: number, depth: number): void => {
      const [bx, by] = arcPoint(ex, ey, rx, ry, phi, b);
      const deviation = maxR * (1 - Math.cos((b - a) / 2));
      if (
        depth >= MAX_DEPTH ||
        deviation <= FLATNESS ||
        !near(ax, ay, bx, by, deviation)
      ) {
        lineTo(bx, by);
        return;
      }
      const mid = (a + b) / 2;
      rec(a, mid, ax, ay, depth + 1);
      const [mx, my] = arcPoint(ex, ey, rx, ry, phi, mid);
      rec(mid, b, mx, my, depth + 1);
    };
    let ax = sx;
    let ay = sy;
    for (let p = 0; p < pieces; p++) {
      const a = t0 + p * step;
      rec(a, a + step, ax, ay, 0);
      [ax, ay] = arcPoint(ex, ey, rx, ry, phi, a + step);
    }
  };
  const flattenCubic = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    depth: number,
  ): void => {
    const minX = Math.min(x0, x1, x2, x3);
    const maxX = Math.max(x0, x1, x2, x3);
    const minY = Math.min(y0, y1, y2, y3);
    const maxY = Math.max(y0, y1, y2, y3);
    const outside = maxX < cx0 || minX > cx1 || maxY < cy0 || minY > cy1;
    // Distance of the control points from the chord, a bound on the curve's.
    const dx = x3 - x0;
    const dy = y3 - y0;
    const len = Math.hypot(dx, dy);
    const dist = (px: number, py: number): number =>
      len === 0
        ? Math.hypot(px - x0, py - y0)
        : Math.abs((px - x0) * dy - (py - y0) * dx) / len;
    const flat = Math.max(dist(x1, y1), dist(x2, y2)) <= FLATNESS;
    if (outside || flat || depth >= MAX_DEPTH) {
      lineTo(x3, y3);
      return;
    }
    const ax = (x0 + x1) / 2;
    const ay = (y0 + y1) / 2;
    const bx = (x1 + x2) / 2;
    const by = (y1 + y2) / 2;
    const cx = (x2 + x3) / 2;
    const cy = (y2 + y3) / 2;
    const abx = (ax + bx) / 2;
    const aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2;
    const bcy = (by + cy) / 2;
    const mx = (abx + bcx) / 2;
    const my = (aby + bcy) / 2;
    flattenCubic(x0, y0, ax, ay, abx, aby, mx, my, depth + 1);
    flattenCubic(mx, my, bcx, bcy, cx, cy, x3, y3, depth + 1);
  };
  const lastPoint = (): [number, number] => {
    const p = current?.points;
    return p && p.length >= 2 ? [p[p.length - 2]!, p[p.length - 1]!] : [startX, startY];
  };
  const o = path.ops;
  const theta = Math.atan2(m.b, m.a);
  each(o, (op, i) => {
    switch (op) {
      case M:
        begin(X(o[i]!, o[i + 1]!), Y(o[i]!, o[i + 1]!));
        break;
      case L:
        lineTo(X(o[i]!, o[i + 1]!), Y(o[i]!, o[i + 1]!));
        break;
      case Q: {
        const qx = X(o[i]!, o[i + 1]!);
        const qy = Y(o[i]!, o[i + 1]!);
        const x = X(o[i + 2]!, o[i + 3]!);
        const y = Y(o[i + 2]!, o[i + 3]!);
        ensure(qx, qy);
        const [px, py] = lastPoint();
        flattenCubic(
          px,
          py,
          px + (2 / 3) * (qx - px),
          py + (2 / 3) * (qy - py),
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          x,
          y,
          0,
        );
        break;
      }
      case C: {
        ensure(X(o[i]!, o[i + 1]!), Y(o[i]!, o[i + 1]!));
        const [px, py] = lastPoint();
        flattenCubic(
          px,
          py,
          X(o[i]!, o[i + 1]!),
          Y(o[i]!, o[i + 1]!),
          X(o[i + 2]!, o[i + 3]!),
          Y(o[i + 2]!, o[i + 3]!),
          X(o[i + 4]!, o[i + 5]!),
          Y(o[i + 4]!, o[i + 5]!),
          0,
        );
        break;
      }
      case A: {
        const r = o[i + 2]! * k;
        flattenArc(
          X(o[i]!, o[i + 1]!),
          Y(o[i]!, o[i + 1]!),
          r,
          r,
          0,
          o[i + 3]! + theta,
          sweep(o[i + 3]!, o[i + 4]!, o[i + 5]! === 1),
        );
        break;
      }
      case E:
        flattenArc(
          X(o[i]!, o[i + 1]!),
          Y(o[i]!, o[i + 1]!),
          o[i + 2]! * k,
          o[i + 3]! * k,
          o[i + 4]! + theta,
          o[i + 5]!,
          sweep(o[i + 5]!, o[i + 6]!, o[i + 7]! === 1),
        );
        break;
      case R:
      case RR: {
        const [x, y, w, h] = [o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!];
        const r = op === RR ? Math.min(o[i + 4]!, Math.abs(w) / 2, Math.abs(h) / 2) : 0;
        if (r <= 0) {
          begin(X(x, y), Y(x, y));
          lineTo(X(x + w, y), Y(x + w, y));
          lineTo(X(x + w, y + h), Y(x + w, y + h));
          lineTo(X(x, y + h), Y(x, y + h));
        } else {
          const rk = r * k;
          const h2 = Math.PI / 2;
          begin(X(x + r, y), Y(x + r, y));
          flattenArc(
            X(x + w - r, y + r),
            Y(x + w - r, y + r),
            rk,
            rk,
            0,
            -h2 + theta,
            h2,
          );
          flattenArc(
            X(x + w - r, y + h - r),
            Y(x + w - r, y + h - r),
            rk,
            rk,
            0,
            theta,
            h2,
          );
          flattenArc(X(x + r, y + h - r), Y(x + r, y + h - r), rk, rk, 0, h2 + theta, h2);
          flattenArc(X(x + r, y + r), Y(x + r, y + r), rk, rk, 0, Math.PI + theta, h2);
        }
        const done = current as Polyline | null;
        if (done) done.closed = true;
        const [sx, sy] = [startX, startY];
        current = null;
        startX = sx;
        startY = sy;
        afterClose = true;
        break;
      }
      case Z: {
        const done = current as Polyline | null;
        if (done) done.closed = true;
        const [sx, sy] = [startX, startY];
        current = null;
        startX = sx;
        startY = sy;
        afterClose = true;
        break;
      }
    }
  });
  return out;
}

/** Sutherland–Hodgman: clips a closed polygon (flat x, y list) to a rectangle. */
export function clipPolygon(
  points: readonly number[],
  clip: readonly number[],
): number[] {
  const [x0, y0, x1, y1] = clip as [number, number, number, number];
  let input = points as number[];
  const edges: Array<
    [
      (x: number, y: number) => boolean,
      (ax: number, ay: number, bx: number, by: number) => [number, number],
    ]
  > = [
    [(x) => x >= x0, (ax, ay, bx, by) => [x0, ay + ((by - ay) * (x0 - ax)) / (bx - ax)]],
    [(x) => x <= x1, (ax, ay, bx, by) => [x1, ay + ((by - ay) * (x1 - ax)) / (bx - ax)]],
    [
      (_x, y) => y >= y0,
      (ax, ay, bx, by) => [ax + ((bx - ax) * (y0 - ay)) / (by - ay), y0],
    ],
    [
      (_x, y) => y <= y1,
      (ax, ay, bx, by) => [ax + ((bx - ax) * (y1 - ay)) / (by - ay), y1],
    ],
  ];
  for (const [inside, cut] of edges) {
    const n = input.length;
    if (n < 6) return [];
    const output: number[] = [];
    let px = input[n - 2]!;
    let py = input[n - 1]!;
    let pin = inside(px, py);
    for (let i = 0; i < n; i += 2) {
      const x = input[i]!;
      const y = input[i + 1]!;
      const cin = inside(x, y);
      if (cin) {
        if (!pin) output.push(...cut(px, py, x, y));
        output.push(x, y);
      } else if (pin) {
        output.push(...cut(px, py, x, y));
      }
      px = x;
      py = y;
      pin = cin;
    }
    input = output;
  }
  return input.length >= 6 ? input : [];
}

/** Liang–Barsky: the part of a segment inside a rectangle, as [t0, t1], or null. */
export function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  clip: readonly number[],
): [number, number] | null {
  const [x0, y0, x1, y1] = clip as [number, number, number, number];
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return null;
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

function inside(points: readonly number[], clip: readonly number[]): boolean {
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < clip[0]! || x > clip[2]! || y < clip[1]! || y > clip[3]!) return false;
  }
  return true;
}

/** How a path is drawn. */
export type PathPaint =
  | { readonly kind: "fill"; readonly color: string }
  | { readonly kind: "stroke"; readonly style: StrokeStyle }
  | { readonly kind: "clip" };

/**
 * Strokes wider than this many device pixels are drawn as filled outlines,
 * clipped to the view, so the canvas never gets a line width (or the clip
 * margin it needs) far beyond the size of the screen.
 */
export const THICK_STROKE_PX = 2 ** 11;
/** The canvas default; the renderer does not change it. */
const MITER_LIMIT = 10;

/** How far a stroke can reach beyond its path, in device pixels. */
function strokeReach(
  lineWidth: number,
  join: CanvasLineJoin,
  cap: CanvasLineCap,
): number {
  const half = lineWidth / 2;
  const joinReach = join === "miter" ? half * MITER_LIMIT : half;
  const capReach = cap === "square" ? half * Math.SQRT2 : half;
  return Math.max(joinReach, capReach);
}

/**
 * The dash pattern as the canvas uses it (an odd list is repeated once), or
 * null for a solid line or a pattern with nothing but zero lengths.
 */
export function dashPattern(dash: readonly number[] | null): number[] | null {
  if (!dash || dash.length === 0) return null;
  if (dash.some((d) => !(d >= 0) || !Number.isFinite(d))) return null;
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
  return pattern.reduce((a, b) => a + b, 0) > 0 ? pattern : null;
}

/**
 * Draws (or clips to) a path mapped through `m`. `view` is the visible device
 * rectangle [x0, y0, x1, y1]. Returns false if nothing reached the canvas
 * because the path is entirely outside the view (a clip then clips everything).
 */
export function paintPath(
  state: CanvasState,
  path: RecordedPath,
  m: Matrix,
  paint: PathPaint,
  view: readonly number[],
): boolean {
  if (path.empty) return false;
  const k = Math.hypot(m.a, m.b);
  const stroke = paint.kind === "stroke" ? paint.style : null;
  const lineWidth = stroke ? stroke.width * k : 0;
  const join = stroke?.join ?? "miter";
  const cap = stroke?.cap ?? "butt";
  // Room for the stroke (width, miter joins, caps) and anti-aliasing.
  const pad = 2 + (stroke ? strokeReach(lineWidth, join, cap) : 0);
  const [minX, minY, maxX, maxY] = deviceBounds(path, m);
  if (
    maxX < view[0]! - pad ||
    minX > view[2]! + pad ||
    maxY < view[1]! - pad ||
    minY > view[3]! + pad
  ) {
    return false;
  }
  const ctx = state.ctx;
  const thick = lineWidth > THICK_STROKE_PX;
  const direct =
    !thick &&
    minX - pad >= -SAFE_COORD &&
    maxX + pad <= SAFE_COORD &&
    minY - pad >= -SAFE_COORD &&
    maxY + pad <= SAFE_COORD;
  state.identity();
  const pattern = stroke?.dash ? dashPattern(stroke.dash.map((d) => d * k)) : null;
  if (stroke && thick) {
    // Grow the view only as far as the visible part of the band can come from.
    const clip = [view[0]! - pad, view[1]! - pad, view[2]! + pad, view[3]! + pad];
    const polys = flatten(path, m, clip);
    state.fill(stroke.color);
    strokeAsFill(state, polys, view, lineWidth, join, cap, pattern);
    return true;
  }
  if (stroke) {
    state.stroke(stroke.color);
    state.lineWidth(lineWidth);
    ctx.lineJoin = join;
    ctx.lineCap = cap;
  }
  if (pattern) ctx.setLineDash(pattern);
  if (direct) {
    emitDirect(state, path, m);
    finish(state, paint);
  } else {
    const clip = [view[0]! - pad, view[1]! - pad, view[2]! + pad, view[3]! + pad];
    const polys = flatten(path, m, clip);
    if (!stroke) {
      ctx.beginPath();
      for (const poly of polys) {
        const pts = clipPolygon(poly.points, clip);
        if (pts.length < 6) continue;
        ctx.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
        ctx.closePath();
      }
      finish(state, paint);
    } else {
      strokeClipped(state, polys, clip, pattern);
    }
  }
  if (pattern) ctx.setLineDash([]);
  return true;
}

function finish(state: CanvasState, paint: PathPaint): void {
  if (paint.kind === "fill") {
    state.fill(paint.color);
    state.ctx.fill();
  } else if (paint.kind === "stroke") state.ctx.stroke();
  else state.ctx.clip();
}

/**
 * The points of a closed polyline rotated to start at a vertex outside `clip`,
 * with the length of the path before that vertex (for the dash phase). Null if
 * every vertex is inside.
 */
function startOutside(
  pts: readonly number[],
  clip: readonly number[],
): { points: number[]; before: number } | null {
  const n = pts.length / 2;
  for (let j = 0; j < n; j++) {
    const x = pts[2 * j]!;
    const y = pts[2 * j + 1]!;
    if (x >= clip[0]! && x <= clip[2]! && y >= clip[1]! && y <= clip[3]!) continue;
    let before = 0;
    for (let s = 0; s < j; s++)
      before += Math.hypot(
        pts[2 * s + 2]! - pts[2 * s]!,
        pts[2 * s + 3]! - pts[2 * s + 1]!,
      );
    return { points: [...pts.slice(2 * j), ...pts.slice(0, 2 * j)], before };
  }
  return null;
}

/** `value` modulo `period`, in [0, period). */
function modulo(value: number, period: number): number {
  const r = value % period;
  return r < 0 ? r + period : r;
}

/**
 * Strokes polylines clipped to `clip`. A closed polyline that is cut is walked
 * from a vertex outside the clip, so every corner inside keeps its join; a
 * dashed one restarts each visible run with the dash phase it has there,
 * reduced to one pattern length.
 */
function strokeClipped(
  state: CanvasState,
  polys: readonly Polyline[],
  clip: readonly number[],
  pattern: readonly number[] | null,
): void {
  const ctx = state.ctx;
  const period = pattern ? pattern.reduce((a, b) => a + b, 0) : 0;
  ctx.beginPath();
  for (const poly of polys) {
    let pts = poly.points;
    if (inside(pts, clip)) {
      ctx.moveTo(pts[0]!, pts[1]!);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
      if (poly.closed) ctx.closePath();
      continue;
    }
    let distance = 0;
    let segments = pts.length / 2 - 1;
    if (poly.closed) {
      const rotated = startOutside(pts, clip);
      if (rotated) {
        // Walk once around, back to the starting vertex.
        pts = [...rotated.points, rotated.points[0]!, rotated.points[1]!];
        distance = rotated.before;
        segments = pts.length / 2 - 1;
      }
    }
    let open = false;
    for (let s = 0; s < segments; s++) {
      const ax = pts[2 * s]!;
      const ay = pts[2 * s + 1]!;
      const bx = pts[2 * s + 2]!;
      const by = pts[2 * s + 3]!;
      const length = Math.hypot(bx - ax, by - ay);
      const part = clipSegment(ax, ay, bx, by, clip);
      if (part === null) {
        open = false;
      } else {
        const [t0, t1] = part;
        if (!open || t0 > 0) {
          if (pattern) {
            ctx.stroke();
            ctx.beginPath();
            ctx.lineDashOffset = modulo(distance + length * t0, period);
          }
          ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        }
        ctx.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
        open = t1 === 1;
      }
      distance += length;
    }
  }
  ctx.stroke();
  if (pattern) ctx.lineDashOffset = 0;
}

/** Signed area (positive: clockwise on screen, y down). */
function area(points: readonly number[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!;
  }
  return sum / 2;
}

/** The same polygon, wound clockwise on screen. */
function clockwise(points: number[]): number[] {
  if (area(points) >= 0) return points;
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i]!, points[i + 1]!);
  return out;
}

/** A circle as a polygon, finely only near `clip`. */
function disc(x: number, y: number, r: number, clip: readonly number[]): number[] {
  const p = new RecordedPath();
  p.arc(x, y, r, 0, 2 * Math.PI);
  return flatten(p, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, clip)[0]?.points ?? [];
}

/**
 * Draws a stroke wider than the screen can take as filled polygons: a rectangle
 * per segment, a polygon per join and cap, each wound the same way and clipped
 * to the view, filled together with the non-zero rule (the overlaps add up and
 * never cancel). Dashes split the polylines into open runs first.
 */
function strokeAsFill(
  state: CanvasState,
  polys: readonly Polyline[],
  view: readonly number[],
  lineWidth: number,
  join: CanvasLineJoin,
  cap: CanvasLineCap,
  pattern: readonly number[] | null,
): void {
  const ctx = state.ctx;
  const half = lineWidth / 2;
  const clip = [view[0]! - 2, view[1]! - 2, view[2]! + 2, view[3]! + 2];
  const reach = [clip[0]! - half, clip[1]! - half, clip[2]! + half, clip[3]! + half];
  const pieces: number[][] = [];
  const add = (points: number[]): void => {
    if (points.length < 6) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]!);
      maxX = Math.max(maxX, points[i]!);
      minY = Math.min(minY, points[i + 1]!);
      maxY = Math.max(maxY, points[i + 1]!);
    }
    if (maxX < clip[0]! || minX > clip[2]! || maxY < clip[1]! || minY > clip[3]!) return;
    const clipped = clipPolygon(clockwise(points), clip);
    if (clipped.length >= 6) pieces.push(clipped);
  };
  const nearVertex = (x: number, y: number): boolean =>
    x >= reach[0]! - half * MITER_LIMIT &&
    x <= reach[2]! + half * MITER_LIMIT &&
    y >= reach[1]! - half * MITER_LIMIT &&
    y <= reach[3]! + half * MITER_LIMIT;

  // One run: an open or closed list of points without repeats.
  const run = (pts: number[], closed: boolean): void => {
    const n = pts.length / 2;
    if (n < 2) {
      if (n === 1 && cap === "round") add(disc(pts[0]!, pts[1]!, half, clip));
      return;
    }
    const segs = closed ? n : n - 1;
    const dir: Array<[number, number]> = [];
    for (let s = 0; s < segs; s++) {
      const ax = pts[2 * s]!;
      const ay = pts[2 * s + 1]!;
      const bx = pts[(2 * s + 2) % pts.length]!;
      const by = pts[(2 * s + 3) % pts.length]!;
      const len = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      dir.push([ux, uy]);
      if (clipSegment(ax, ay, bx, by, reach) === null) continue;
      const nx = -uy * half;
      const ny = ux * half;
      let [sx, sy, ex, ey] = [ax, ay, bx, by];
      if (!closed && cap === "square") {
        if (s === 0) [sx, sy] = [ax - ux * half, ay - uy * half];
        if (s === segs - 1) [ex, ey] = [bx + ux * half, by + uy * half];
      }
      add([sx + nx, sy + ny, ex + nx, ey + ny, ex - nx, ey - ny, sx - nx, sy - ny]);
    }
    // Joins at the vertices where two segments meet.
    const first = closed ? 0 : 1;
    for (let v = first; v < (closed ? n : n - 1); v++) {
      const x = pts[2 * v]!;
      const y = pts[2 * v + 1]!;
      if (!nearVertex(x, y)) continue;
      const [ux0, uy0] = dir[(v - 1 + segs) % segs]!;
      const [ux1, uy1] = dir[v % segs]!;
      const turn = ux0 * uy1 - uy0 * ux1;
      if (Math.abs(turn) < 1e-12 && ux0 * ux1 + uy0 * uy1 > 0) continue;
      if (join === "round") {
        add(disc(x, y, half, clip));
        continue;
      }
      // The outer side is opposite the turn.
      const side = turn > 0 ? -1 : 1;
      const o0x = -uy0 * half * side;
      const o0y = ux0 * half * side;
      const o1x = -uy1 * half * side;
      const o1y = ux1 * half * side;
      const cosHalf = Math.sqrt(Math.max(0, (1 + ux0 * ux1 + uy0 * uy1) / 2));
      if (join === "miter" && cosHalf > 0 && 1 / cosHalf <= MITER_LIMIT) {
        const mx = o0x + o1x;
        const my = o0y + o1y;
        const ml = Math.hypot(mx, my);
        const dist = half / cosHalf;
        add([
          x,
          y,
          x + o0x,
          y + o0y,
          x + (mx / ml) * dist,
          y + (my / ml) * dist,
          x + o1x,
          y + o1y,
        ]);
      } else {
        add([x, y, x + o0x, y + o0y, x + o1x, y + o1y]);
      }
    }
    if (!closed && cap === "round") {
      add(disc(pts[0]!, pts[1]!, half, clip));
      add(disc(pts[pts.length - 2]!, pts[pts.length - 1]!, half, clip));
    }
  };

  const period = pattern ? pattern.reduce((a, b) => a + b, 0) : 0;
  for (const poly of polys) {
    // Drop repeated points, which have no direction.
    const pts: number[] = [];
    for (let i = 0; i < poly.points.length; i += 2) {
      const x = poly.points[i]!;
      const y = poly.points[i + 1]!;
      if (pts.length >= 2 && pts[pts.length - 2] === x && pts[pts.length - 1] === y)
        continue;
      pts.push(x, y);
    }
    if (
      poly.closed &&
      pts.length >= 4 &&
      pts[0] === pts[pts.length - 2] &&
      pts[1] === pts[pts.length - 1]
    )
      pts.length -= 2;
    // Sub-pixel dash patterns look like a lighter solid line; draw them solid.
    if (!pattern || period < 1) {
      run(pts, poly.closed);
      continue;
    }
    // Dashes: an open run for each visible "on" interval, segment by segment.
    const closedPts = poly.closed ? [...pts, pts[0]!, pts[1]!] : pts;
    let distance = 0;
    for (let s = 0; s + 3 < closedPts.length; s += 2) {
      const ax = closedPts[s]!;
      const ay = closedPts[s + 1]!;
      const bx = closedPts[s + 2]!;
      const by = closedPts[s + 3]!;
      const len = Math.hypot(bx - ax, by - ay);
      const part = clipSegment(ax, ay, bx, by, reach);
      if (part && len > 0) {
        const d0 = distance + len * part[0];
        const d1 = distance + len * part[1];
        let index = 0;
        let at = d0 - modulo(d0, period);
        while (at < d1) {
          const length = pattern[index]!;
          const on = index % 2 === 0;
          const a = Math.max(at, d0);
          const b = Math.min(at + length, d1);
          if (on && b > a) {
            const ta = (a - distance) / len;
            const tb = (b - distance) / len;
            run(
              [
                ax + (bx - ax) * ta,
                ay + (by - ay) * ta,
                ax + (bx - ax) * tb,
                ay + (by - ay) * tb,
              ],
              false,
            );
          }
          at += length;
          index = (index + 1) % pattern.length;
        }
      }
      distance += len;
    }
  }
  ctx.beginPath();
  for (const pts of pieces) {
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.closePath();
  }
  ctx.fill("nonzero");
}
