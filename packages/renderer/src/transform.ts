// SPDX-License-Identifier: GPL-3.0-or-later

// Camera arithmetic in float64. A container's space is a pure translation of its
// parent's (frames and groups do not rotate or scale), so every space maps to
// device pixels by one scale and one offset. Elements add a rotation about their
// centre: the full map from an element's local box to device pixels is a
// similarity (rotation, uniform scale, translation), kept here as the six numbers
// of a canvas matrix, all computed in float64 relative to the camera. Only the
// results, which are about the size of the screen, reach the canvas.

import type { CameraView, ElementId, Rect } from "@galatsa/core";

/** Size of the drawing area. */
export interface Viewport {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per CSS pixel. May change while the program runs. */
  readonly devicePixelRatio: number;
}

/**
 * Device pixels of a point p in a space: p * scale + (ox, oy). The same scale for
 * every space; the offset differs.
 */
export interface SpaceMap {
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

/** A similarity in canvas matrix form: x' = a x + c y + e, y' = b x + d y + f. */
export interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * How a space maps to device pixels. `offset` is the offset from the camera's
 * space to `space` (Resolver.offset(space, camera.space)): a point p in `space`
 * is at p + offset in the camera's space.
 */
export function spaceMap(
  camera: CameraView,
  viewport: Viewport,
  offset: { readonly x: number; readonly y: number },
): SpaceMap {
  const scale = camera.zoom * viewport.devicePixelRatio;
  // Subtract the camera centre from the offset first: both are in the camera's
  // space, and their difference is small when the space is near the view.
  const dx = offset.x - camera.cx;
  const dy = offset.y - camera.cy;
  return {
    scale,
    ox: dx * scale + (viewport.width * viewport.devicePixelRatio) / 2,
    oy: dy * scale + (viewport.height * viewport.devicePixelRatio) / 2,
  };
}

/** The rectangle of a space that the device rectangle (0, 0, w, h) shows, grown by `margin` device pixels. */
export function visibleRect(
  map: SpaceMap,
  widthPx: number,
  heightPx: number,
  margin = 0,
): Rect {
  const s = map.scale;
  return {
    x: (-margin - map.ox) / s,
    y: (-margin - map.oy) / s,
    w: (widthPx + 2 * margin) / s,
    h: (heightPx + 2 * margin) / s,
  };
}

/**
 * The matrix from an element's local box to device pixels: the element's origin
 * (top-left corner before rotation) is at (x, y) in its parent's space, it has
 * size (w, h) and is rotated by `rot` radians about its centre.
 */
export function elementMatrix(
  map: SpaceMap,
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
): Matrix {
  const s = map.scale;
  if (rot === 0) return { a: s, b: 0, c: 0, d: s, e: x * s + map.ox, f: y * s + map.oy };
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const hw = w / 2;
  const hh = h / 2;
  // Device position of the centre, then back to the rotated corner.
  const cx = (x + hw) * s + map.ox;
  const cy = (y + hh) * s + map.oy;
  const a = cos * s;
  const b = sin * s;
  return { a, b, c: -b, d: a, e: cx - a * hw + b * hh, f: cy - b * hw - a * hh };
}

/** A container's space as a matrix (translation and scale only). */
export function spaceMatrix(map: SpaceMap, x = 0, y = 0): Matrix {
  return {
    a: map.scale,
    b: 0,
    c: 0,
    d: map.scale,
    e: x * map.scale + map.ox,
    f: y * map.scale + map.oy,
  };
}

/** The matrix moved by (tx, ty) in its own coordinates. */
export function translate(m: Matrix, tx: number, ty: number): Matrix {
  return {
    a: m.a,
    b: m.b,
    c: m.c,
    d: m.d,
    e: m.e + m.a * tx + m.c * ty,
    f: m.f + m.b * tx + m.d * ty,
  };
}

/** Uniform scale of a similarity. */
export function matrixScale(m: Matrix): number {
  return Math.hypot(m.a, m.b);
}

/** Rotation of a similarity, in radians. */
export function matrixRotation(m: Matrix): number {
  return Math.atan2(m.b, m.a);
}

/** Maps a point. */
export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** Maps a device point back into the matrix's local coordinates. */
export function invert(m: Matrix, x: number, y: number): { x: number; y: number } {
  const det = m.a * m.d - m.b * m.c;
  const dx = x - m.e;
  const dy = y - m.f;
  return { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det };
}

/** Bounding box, in local coordinates, of a device rectangle mapped back through `m`. */
export function localBoundsOf(m: Matrix, rect: Rect): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ] as const) {
    const p = invert(m, px, py);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Bounding box, in device pixels, of a local rectangle mapped through `m`. */
export function deviceBoundsOf(m: Matrix, rect: Rect): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ] as const) {
    const x = m.a * px + m.c * py + m.e;
    const y = m.b * px + m.d * py + m.f;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** True if two rectangles overlap (touching counts). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** The overlap of two rectangles, or null. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  if (r < x || btm < y) return null;
  return { x, y, w: r - x, h: btm - y };
}

/** The anchor space and offset helper: Resolver.offset with a per-frame cache. */
export type OffsetFn = (
  from: ElementId | null,
  to: ElementId | null,
) => { x: number; y: number };
