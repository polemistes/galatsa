// SPDX-License-Identifier: GPL-3.0-or-later

// Conversions between the screen (CSS pixels of the drawing area) and the
// canvas (root space), and the few camera moves an editor needs before the
// real camera controls (zoom towards the pointer, panning): enough to reach
// an element and use a tool on it.

import {
  clampZoom,
  zoomToFit,
  type CameraView,
  type ElementId,
  type Point,
  type Rect,
} from "@galatsa/core";

/** Size of the drawing area in CSS pixels. */
export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

/** Offsets between spaces (the scene's `offset`). */
export type Offsets = (from: ElementId | null, to: ElementId | null) => Point;

/** The camera's centre in root space. */
function rootCentre(camera: CameraView, offsets: Offsets): Point {
  const o = offsets(camera.space, null);
  return { x: camera.cx + o.x, y: camera.cy + o.y };
}

/** A point on screen, in root space. */
export function screenToWorld(
  camera: CameraView,
  size: ScreenSize,
  offsets: Offsets,
  point: Point,
): Point {
  const c = rootCentre(camera, offsets);
  return {
    x: c.x + (point.x - size.width / 2) / camera.zoom,
    y: c.y + (point.y - size.height / 2) / camera.zoom,
  };
}

/** A point in root space, on screen. */
export function worldToScreen(
  camera: CameraView,
  size: ScreenSize,
  offsets: Offsets,
  point: Point,
): Point {
  const c = rootCentre(camera, offsets);
  return {
    x: (point.x - c.x) * camera.zoom + size.width / 2,
    y: (point.y - c.y) * camera.zoom + size.height / 2,
  };
}

/** The part of the canvas on screen, in root space. */
export function visibleWorld(
  camera: CameraView,
  size: ScreenSize,
  offsets: Offsets,
): Rect {
  const c = rootCentre(camera, offsets);
  const w = size.width / camera.zoom;
  const h = size.height / camera.zoom;
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** The camera that shows `rect` (in the space of `space`) filling the view, with a margin. */
export function fitCamera(
  rect: Rect,
  space: ElementId | null,
  size: ScreenSize,
  margin = 0.05,
): CameraView {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const zoom = zoomToFit(rect, size.width, size.height) * (1 - 2 * margin);
  return { space, cx, cy, zoom: clampZoom(zoom > 0 ? zoom : 1, cx, cy) };
}

/** The camera zoomed by `factor` about a point on screen, which stays where it is. */
export function zoomAbout(
  camera: CameraView,
  size: ScreenSize,
  at: Point,
  factor: number,
): CameraView {
  const dx = at.x - size.width / 2;
  const dy = at.y - size.height / 2;
  // The point under the pointer, in the camera's space.
  const px = camera.cx + dx / camera.zoom;
  const py = camera.cy + dy / camera.zoom;
  const zoom = clampZoom(camera.zoom * factor, px, py);
  return { space: camera.space, cx: px - dx / zoom, cy: py - dy / zoom, zoom };
}

/** The camera moved by a distance in screen pixels (the canvas follows the pointer). */
export function panBy(camera: CameraView, dx: number, dy: number): CameraView {
  return {
    ...camera,
    cx: camera.cx - dx / camera.zoom,
    cy: camera.cy - dy / camera.zoom,
  };
}
