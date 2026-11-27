// SPDX-License-Identifier: GPL-3.0-or-later

// Zoom range and numeric precision. Section 7 of
// docs/adr/0001-document-model-and-file-format.md.
//
// World unit: one CSS pixel at zoom 1. The y axis points down. Zoom is screen
// pixels per world unit. All model and camera arithmetic is float64; only small,
// camera-relative screen coordinates are handed to a drawing backend.

import type { ElementId, Rect } from "./types.ts";

/** Smallest zoom the camera allows: 2^-32 screen pixels per world unit. */
export const MIN_ZOOM = 2 ** -32;
/** Largest zoom the camera allows: 2^32 screen pixels per world unit. */
export const MAX_ZOOM = 2 ** 32;

/**
 * Precision budget. A float64 coordinate of magnitude m has a spacing of about
 * m * 2^-52, so at zoom z its error on screen is about m * z * 2^-52 pixels.
 * Keeping m * z <= 2^46 keeps that error at or below 2^-6 = 1/64 pixel.
 */
export const PRECISION_BUDGET = 2 ** 46;

/**
 * The camera, as the renderer and player see it. It is anchored in the local
 * space of a container (or the root) so that zooming deep into a frame stays
 * precise however far the frame is from the world origin. The camera is not part
 * of the document; stops store regions (see StopView), not camera poses, so a
 * different camera model (for example 3D) can show the same stops.
 */
export interface CameraView {
  /** Container whose local space the centre is in; null for the root. */
  space: ElementId | null;
  /** Centre of the screen, in the space's local coordinates. */
  cx: number;
  cy: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

/**
 * The largest zoom that keeps the precision budget for a camera centred at
 * (cx, cy) in its anchor space. Cameras clamp to this, so precision runs out as
 * a zoom limit, never as jitter.
 */
export function maxPreciseZoom(cx: number, cy: number): number {
  const magnitude = Math.max(Math.abs(cx), Math.abs(cy), 1);
  return Math.min(MAX_ZOOM, PRECISION_BUDGET / magnitude);
}

/** Clamps a zoom value to the allowed range for a camera centre. */
export function clampZoom(zoom: number, cx: number, cy: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), maxPreciseZoom(cx, cy));
}

/** Zoom that fits `rect` inside a viewport of the given pixel size. */
export function zoomToFit(
  rect: Rect,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const zx = rect.w > 0 ? viewportWidth / rect.w : Infinity;
  const zy = rect.h > 0 ? viewportHeight / rect.h : Infinity;
  const zoom = Math.min(zx, zy);
  return Number.isFinite(zoom) ? zoom : MAX_ZOOM;
}

/** Smallest rectangle containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Axis-aligned bounds of a w x h box at (x, y) rotated by `rot` about its centre. */
export function rotatedBounds(rect: Rect, rot: number): Rect {
  if (rot === 0) return rect;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const w = rect.w * cos + rect.h * sin;
  const h = rect.w * sin + rect.h * cos;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
