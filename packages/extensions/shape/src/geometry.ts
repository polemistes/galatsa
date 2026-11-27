// SPDX-License-Identifier: GPL-3.0-or-later

// Geometry of outlines, so that a shape kind only has to draw its outline and
// gets hit testing and bounds for free: a path that records what a kind
// draws, flattening of the recorded path into polylines (with the same rules
// as a Canvas 2D path), the distance from a point to an outline, the nonzero
// fill rule, and a path that rotates and moves what is drawn into it, for
// previews in a drawing context that only translates.

import type { Path } from "@galatsa/extension-api";

/** One recorded path call, as a tuple of its name and arguments. */
export type PathOp =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["Q", number, number, number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["A", number, number, number, number, number, boolean]
  | readonly ["E", number, number, number, number, number, number, number, boolean]
  | readonly ["R", number, number, number, number]
  | readonly ["RR", number, number, number, number, number]
  | readonly ["Z"];

/** A path that records the calls made on it. */
export class RecordingPath implements Path {
  readonly ops: PathOp[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(["M", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(["L", x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push(["Q", cx, cy, x, y]);
  }
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ) {
    this.ops.push(["C", c1x, c1y, c2x, c2y, x, y]);
  }
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
    this.ops.push(["A", x, y, r, start, end, ccw]);
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
    this.ops.push(["E", cx, cy, rx, ry, rotation, start, end, ccw]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["R", x, y, w, h]);
  }
  roundRect(x: number, y: number, w: number, h: number, radius: number): void {
    this.ops.push(["RR", x, y, w, h, radius]);
  }
  closePath(): void {
    this.ops.push(["Z"]);
  }
}

/** A run of connected points; `closed` when the run ends with a closePath. */
export interface Polyline {
  /** x and y of each point, one after the other. */
  readonly points: number[];
  closed: boolean;
}

/** Polylines of a recorded path, and how far they may be from the true curves. */
export interface Flattened {
  readonly lines: readonly Polyline[];
  /** The largest distance between a curve and the chords that replace it. */
  readonly error: number;
}

const TAU = 2 * Math.PI;
/** Upper limit on the chords one curve is split into. */
const MAX_CHORDS = 1024;

/**
 * The signed angle an arc from `start` to `end` sweeps, by the Canvas 2D
 * rules: positive is clockwise on screen; a sweep of a full turn or more in
 * the arc's direction is a full circle; otherwise the angles are taken modulo
 * a full turn.
 */
export function arcSweep(start: number, end: number, ccw: boolean): number {
  if (!ccw && end - start >= TAU) return TAU;
  if (ccw && start - end >= TAU) return -TAU;
  const mod = (a: number): number => ((a % TAU) + TAU) % TAU;
  return ccw ? -mod(start - end) : mod(end - start);
}

/** Chords for an arc of `radius` sweeping `sweep`, with a chord error of at most `tolerance` if possible. */
function chordCount(radius: number, sweep: number, tolerance: number): number {
  const a = Math.abs(sweep);
  if (a === 0 || !(radius > 0)) return 1;
  const ratio = tolerance / radius;
  const step = ratio >= 2 ? Math.PI : 2 * Math.acos(1 - ratio);
  return Math.min(MAX_CHORDS, Math.max(1, Math.ceil(a / step)));
}

/**
 * Flattens recorded path calls into polylines, following Canvas 2D: lineTo
 * and curves without a current point start one; arc and ellipse join the
 * current point with a line; rect and roundRect add a closed run and start a
 * new one at their corner; closePath closes the run and starts a new one at
 * its first point. `tolerance` is the largest chord error wanted, in the
 * path's units.
 */
export function flatten(ops: readonly PathOp[], tolerance: number): Flattened {
  const lines: Polyline[] = [];
  let current: Polyline | null = null;
  let error = 0;
  const tol = tolerance > 0 ? tolerance : Number.MIN_VALUE;

  const start = (x: number, y: number): Polyline => {
    current = { points: [x, y], closed: false };
    lines.push(current);
    return current;
  };
  const to = (x: number, y: number): void => {
    if (current === null) start(x, y);
    else current.points.push(x, y);
  };
  const last = (): [number, number] => {
    const p = (current as Polyline | null)?.points;
    return p ? [p[p.length - 2]!, p[p.length - 1]!] : [0, 0];
  };
  const ellipse = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
    ccw: boolean,
  ): void => {
    const sweep = arcSweep(a0, a1, ccw);
    const r = Math.max(Math.abs(rx), Math.abs(ry));
    const n = chordCount(r, sweep, tol);
    if (sweep !== 0)
      error = Math.max(error, r * (1 - Math.cos(Math.abs(sweep) / (2 * n))));
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const at = (t: number): [number, number] => {
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      return [cx + ex * cos - ey * sin, cy + ex * sin + ey * cos];
    };
    const [sx, sy] = at(a0);
    to(sx, sy);
    for (let i = 1; i <= n; i += 1) {
      const [x, y] = at(a0 + (sweep * i) / n);
      current!.points.push(x, y);
    }
  };
  const closeRun = (): void => {
    const run = current as Polyline | null;
    if (run === null) return;
    run.closed = true;
    start(run.points[0]!, run.points[1]!);
  };

  for (const op of ops) {
    switch (op[0]) {
      case "M":
        start(op[1], op[2]);
        break;
      case "L":
        to(op[1], op[2]);
        break;
      case "Q": {
        const [, cx, cy, x, y] = op;
        if (current === null) start(cx, cy);
        const [x0, y0] = last();
        const dd = 2 * Math.hypot(x0 - 2 * cx + x, y0 - 2 * cy + y);
        const n = Math.min(MAX_CHORDS, Math.max(1, Math.ceil(Math.sqrt(dd / (8 * tol)))));
        error = Math.max(error, dd / (8 * n * n));
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          current!.points.push(
            u * u * x0 + 2 * u * t * cx + t * t * x,
            u * u * y0 + 2 * u * t * cy + t * t * y,
          );
        }
        break;
      }
      case "C": {
        const [, c1x, c1y, c2x, c2y, x, y] = op;
        if (current === null) start(c1x, c1y);
        const [x0, y0] = last();
        const dd =
          6 *
          Math.max(
            Math.hypot(x0 - 2 * c1x + c2x, y0 - 2 * c1y + c2y),
            Math.hypot(c1x - 2 * c2x + x, c1y - 2 * c2y + y),
          );
        const n = Math.min(MAX_CHORDS, Math.max(1, Math.ceil(Math.sqrt(dd / (8 * tol)))));
        error = Math.max(error, dd / (8 * n * n));
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          current!.points.push(
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
          );
        }
        break;
      }
      case "A":
        ellipse(op[1], op[2], op[3], op[3], 0, op[4], op[5], op[6]);
        break;
      case "E":
        ellipse(op[1], op[2], op[3], op[4], op[5], op[6], op[7], op[8]);
        break;
      case "R": {
        const [, x, y, w, h] = op;
        lines.push({ points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true });
        start(x, y);
        break;
      }
      case "RR": {
        const [, x, y, w, h, radius] = op;
        const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
        current = null;
        roundedRect(
          {
            moveTo: start,
            lineTo: to,
            arc: (cx, cy, rr, a0, a1) => ellipse(cx, cy, rr, rr, 0, a0, a1, false),
          },
          x,
          y,
          w,
          h,
          r,
        );
        closeRun();
        start(x, y);
        break;
      }
      case "Z":
        closeRun();
        break;
    }
  }
  return { lines: lines.filter((l) => l.points.length >= 4), error };
}

/**
 * Draws a rectangle with rounded corners as lines and quarter arcs, clockwise
 * from the top edge, without closing it: the same outline as Canvas 2D's
 * roundRect with one radius, for a box with a positive or negative size.
 */
export function roundedRect(
  path: {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    arc(cx: number, cy: number, r: number, a0: number, a1: number): void;
  },
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const x0 = Math.min(x, x + w);
  const y0 = Math.min(y, y + h);
  const x1 = Math.max(x, x + w);
  const y1 = Math.max(y, y + h);
  path.moveTo(x0 + r, y0);
  path.lineTo(x1 - r, y0);
  path.arc(x1 - r, y0 + r, r, -Math.PI / 2, 0);
  path.lineTo(x1, y1 - r);
  path.arc(x1 - r, y1 - r, r, 0, Math.PI / 2);
  path.lineTo(x0 + r, y1);
  path.arc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI);
  path.lineTo(x0, y0 + r);
  path.arc(x0 + r, y0 + r, r, Math.PI, (3 * Math.PI) / 2);
}

/** Distance from (px, py) to the segment from (ax, ay) to (bx, by). */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance from a point to the stroked outline: every run, with the closing
 * segment of closed runs. Infinity when there is no outline.
 */
export function outlineDistance(
  lines: readonly Polyline[],
  x: number,
  y: number,
): number {
  let best = Infinity;
  for (const line of lines) {
    const p = line.points;
    const n = p.length / 2;
    for (let i = 0; i + 1 < n; i += 1)
      best = Math.min(
        best,
        segmentDistance(x, y, p[2 * i]!, p[2 * i + 1]!, p[2 * i + 2]!, p[2 * i + 3]!),
      );
    if (line.closed && n > 2)
      best = Math.min(
        best,
        segmentDistance(x, y, p[2 * n - 2]!, p[2 * n - 1]!, p[0]!, p[1]!),
      );
  }
  return best;
}

/**
 * True if a point is inside the filled area, by the nonzero rule that Canvas
 * 2D fills with. Every run counts as closed, as it does when filled.
 */
export function insideFill(lines: readonly Polyline[], x: number, y: number): boolean {
  let winding = 0;
  for (const line of lines) {
    const p = line.points;
    const n = p.length / 2;
    for (let i = 0; i < n; i += 1) {
      const ax = p[2 * i]!;
      const ay = p[2 * i + 1]!;
      const j = (i + 1) % n;
      const bx = p[2 * j]!;
      const by = p[2 * j + 1]!;
      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding += 1;
      } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) winding -= 1;
    }
  }
  return winding !== 0;
}

/** Smallest rectangle around every point, or null when there are none. */
export function extent(
  lines: readonly Polyline[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    const p = line.points;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]!);
      maxX = Math.max(maxX, p[i]!);
      minY = Math.min(minY, p[i + 1]!);
      maxY = Math.max(maxY, p[i + 1]!);
    }
  }
  return minX <= maxX ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/**
 * A rotation by `rot` (radians, clockwise on screen) about the origin followed
 * by a move by (dx, dy). Rigid, so circles stay circles.
 */
export interface Placement {
  readonly rot: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * A path that places everything drawn into it with `placement` and passes it
 * on to `target`. Arcs stay arcs and ellipses ellipses; rectangles become
 * four lines and rounded rectangles lines and arcs, with the same outline.
 */
export class PlacedPath implements Path {
  readonly target: Path;
  readonly placement: Placement;
  readonly #cos: number;
  readonly #sin: number;
  constructor(target: Path, placement: Placement) {
    this.target = target;
    this.placement = placement;
    this.#cos = Math.cos(placement.rot);
    this.#sin = Math.sin(placement.rot);
  }
  #x(x: number, y: number): number {
    return x * this.#cos - y * this.#sin + this.placement.dx;
  }
  #y(x: number, y: number): number {
    return x * this.#sin + y * this.#cos + this.placement.dy;
  }
  moveTo(x: number, y: number): void {
    this.target.moveTo(this.#x(x, y), this.#y(x, y));
  }
  lineTo(x: number, y: number): void {
    this.target.lineTo(this.#x(x, y), this.#y(x, y));
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.target.quadraticCurveTo(
      this.#x(cx, cy),
      this.#y(cx, cy),
      this.#x(x, y),
      this.#y(x, y),
    );
  }
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ) {
    this.target.bezierCurveTo(
      this.#x(c1x, c1y),
      this.#y(c1x, c1y),
      this.#x(c2x, c2y),
      this.#y(c2x, c2y),
      this.#x(x, y),
      this.#y(x, y),
    );
  }
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
    const rot = this.placement.rot;
    this.target.arc(this.#x(x, y), this.#y(x, y), r, start + rot, end + rot, ccw);
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
    const rot = this.placement.rot;
    this.target.ellipse(
      this.#x(cx, cy),
      this.#y(cx, cy),
      rx,
      ry,
      rotation + rot,
      start,
      end,
      ccw,
    );
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
    this.moveTo(x, y);
  }
  roundRect(x: number, y: number, w: number, h: number, radius: number): void {
    const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
    roundedRect(this, x, y, w, h, r);
    this.closePath();
    this.moveTo(x, y);
  }
  closePath(): void {
    this.target.closePath();
  }
}

/**
 * Canvas 2D's default miter limit: a miter longer than this many line widths
 * is drawn beveled. The renderer does not change it.
 */
export const MITER_LIMIT = 10;

/**
 * How far a stroke of the polylines reaches outside them, in line widths:
 * half a width along the line and at round or bevel joins and round or butt
 * caps; √2/2 at square caps; and at each miter join, half the miter length,
 * 1/(2 sin(θ/2)) for the angle θ between the two segments, unless the miter
 * is longer than MITER_LIMIT widths and drawn beveled.
 */
export function strokeReach(
  lines: readonly Polyline[],
  join: "miter" | "round" | "bevel",
  cap: "butt" | "round" | "square",
): number {
  let reach = 0.5;
  for (const line of lines) {
    const p = line.points;
    const n = p.length / 2;
    if (n < 2) continue;
    if (cap === "square" && !line.closed) reach = Math.max(reach, Math.SQRT1_2);
    if (join !== "miter") continue;
    const at = (k: number): readonly [number, number] => {
      const j = ((k % n) + n) % n;
      return [p[2 * j]!, p[2 * j + 1]!];
    };
    for (let i = 0; i < n; i += 1) {
      if (!line.closed && (i === 0 || i === n - 1)) continue;
      // The nearest points before and after that are not on top of this one.
      const [x, y] = at(i);
      let back = i - 1;
      let ahead = i + 1;
      while (back > i - n && at(back)[0] === x && at(back)[1] === y) back -= 1;
      while (ahead < i + n && at(ahead)[0] === x && at(ahead)[1] === y) ahead += 1;
      if (!line.closed && (back < 0 || ahead > n - 1)) continue;
      const [ax, ay] = at(back);
      const [bx, by] = at(ahead);
      const la = Math.hypot(ax - x, ay - y);
      const lb = Math.hypot(bx - x, by - y);
      if (la === 0 || lb === 0) continue;
      const cos = ((ax - x) * (bx - x) + (ay - y) * (by - y)) / (la * lb);
      const sinHalf = Math.sqrt(Math.max(0, (1 - Math.max(-1, Math.min(1, cos))) / 2));
      const ratio = sinHalf > 0 ? 1 / sinHalf : Infinity;
      if (ratio <= MITER_LIMIT) reach = Math.max(reach, ratio / 2);
    }
  }
  return reach;
}
