// SPDX-License-Identifier: GPL-3.0-or-later

// The geometry of the selection's handles: a box (centre, size, rotation) in
// root space, where its handles are, which one a point is on, and what
// dragging a handle does (the factor of a scaling, the new box of a resize,
// the angle of a rotation). Plain functions, so they are tested alone.

import type { Point, Rect } from "@galatsa/core";

/** A box in root space: its centre, its size, and its rotation (radians, clockwise). */
export interface Box {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
}

/**
 * A handle, named by its place on the box: u and v are -1, 0 or 1 along the
 * box's own x and y axes (u = -1 is the left edge, v = -1 the top edge), so a
 * corner has neither 0, a side handle one. The rotation handle stands above
 * the top edge.
 */
export type Handle =
  | { readonly kind: "corner"; readonly u: -1 | 1; readonly v: -1 | 1 }
  | { readonly kind: "side"; readonly u: -1 | 0 | 1; readonly v: -1 | 0 | 1 }
  | { readonly kind: "rotate" };

export const CORNERS: readonly Handle[] = [
  { kind: "corner", u: -1, v: -1 },
  { kind: "corner", u: 1, v: -1 },
  { kind: "corner", u: 1, v: 1 },
  { kind: "corner", u: -1, v: 1 },
];

export const SIDES: readonly Handle[] = [
  { kind: "side", u: 0, v: -1 },
  { kind: "side", u: 1, v: 0 },
  { kind: "side", u: 0, v: 1 },
  { kind: "side", u: -1, v: 0 },
];

export function boxFromRect(r: Rect): Box {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, rot: 0 };
}

/** The union of rectangles, or null for none. */
export function union(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return { x, y, w: right - x, h: bottom - y };
}

/** A point given in the box's own frame (origin at its centre) in root space. */
export function fromBox(box: Box, local: Point): Point {
  const cos = Math.cos(box.rot);
  const sin = Math.sin(box.rot);
  return {
    x: box.cx + local.x * cos - local.y * sin,
    y: box.cy + local.x * sin + local.y * cos,
  };
}

/** A point in root space in the box's own frame (origin at its centre). */
export function toBox(box: Box, p: Point): Point {
  const cos = Math.cos(box.rot);
  const sin = Math.sin(box.rot);
  const dx = p.x - box.cx;
  const dy = p.y - box.cy;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Where a handle is, in root space; `lift` is how far the rotation handle stands above the box. */
export function handlePoint(box: Box, handle: Handle, lift: number): Point {
  if (handle.kind === "rotate") return fromBox(box, { x: 0, y: -box.h / 2 - lift });
  return fromBox(box, { x: (handle.u * box.w) / 2, y: (handle.v * box.h) / 2 });
}

/** The handle within `tolerance` of `p` (root units), the nearest first; null if none. */
export function handleAt(
  box: Box,
  handles: readonly Handle[],
  p: Point,
  tolerance: number,
  lift: number,
): Handle | null {
  let best: Handle | null = null;
  let bestDistance = Infinity;
  for (const handle of handles) {
    const at = handlePoint(box, handle, lift);
    const distance = Math.max(Math.abs(at.x - p.x), Math.abs(at.y - p.y));
    if (distance <= tolerance && distance < bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  return best;
}

/** True if `p` lies inside the box. */
export function insideBox(box: Box, p: Point): boolean {
  const local = toBox(box, p);
  return Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2;
}

/**
 * The factor of a scaling about `anchor` that takes the dragged corner from
 * `from` towards `to`: the pointer projected on the line from the anchor
 * through the corner, so the proportions stay. Never below `min`.
 */
export function scaleFactor(anchor: Point, from: Point, to: Point, min: number): number {
  const dx = from.x - anchor.x;
  const dy = from.y - anchor.y;
  const length = dx * dx + dy * dy;
  if (!(length > 0)) return 1;
  const factor = ((to.x - anchor.x) * dx + (to.y - anchor.y) * dy) / length;
  return Math.max(min, factor);
}

/**
 * The box a resize gives when the edges named by `u` and `v` follow the
 * pointer `p` and the opposite edges stay (or, `fromCentre`, the centre
 * stays). Sizes never go below `min`.
 */
export function resizedBox(
  box: Box,
  u: -1 | 0 | 1,
  v: -1 | 0 | 1,
  p: Point,
  min: number,
  fromCentre: boolean,
): Box {
  const local = toBox(box, p);
  let w = box.w;
  let h = box.h;
  let sx = 0;
  let sy = 0;
  if (u !== 0) {
    if (fromCentre) w = Math.max(min, 2 * local.x * u);
    else {
      w = Math.max(min, box.w / 2 + local.x * u);
      sx = (u * (w - box.w)) / 2;
    }
  }
  if (v !== 0) {
    if (fromCentre) h = Math.max(min, 2 * local.y * v);
    else {
      h = Math.max(min, box.h / 2 + local.y * v);
      sy = (v * (h - box.h)) / 2;
    }
  }
  const centre = fromBox(box, { x: sx, y: sy });
  return { cx: centre.x, cy: centre.y, w, h, rot: box.rot };
}

/** The angle of `p` about `centre`, clockwise from the x axis (y points down). */
export function angleAbout(centre: Point, p: Point): number {
  return Math.atan2(p.y - centre.y, p.x - centre.x);
}

/** `angle` rounded to the nearest multiple of `step`. */
export function snapAngle(angle: number, step: number): number {
  return Math.round(angle / step) * step;
}

/** An angle brought into (-π, π]. */
export function normalizeAngle(angle: number): number {
  const turn = 2 * Math.PI;
  let a = angle % turn;
  if (a <= -Math.PI) a += turn;
  if (a > Math.PI) a -= turn;
  return a;
}

/** The resize cursor for a handle on a box turned by `rot`: the one nearest its direction. */
export function resizeCursor(
  handle: { readonly u: number; readonly v: number },
  rot: number,
): "nwse-resize" | "nesw-resize" | "ns-resize" | "ew-resize" {
  // The handle's direction from the centre, turned with the box, in eighths of a turn.
  const angle = Math.atan2(handle.v, handle.u) + rot;
  const eighth = ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
  return (["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const)[eighth]!;
}
