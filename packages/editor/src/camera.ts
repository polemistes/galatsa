// SPDX-License-Identifier: GPL-3.0-or-later

// Camera arithmetic: conversions between the screen (CSS pixels of the
// drawing area), the camera's own space and root space, and the camera moves
// (zoom about a point on screen, panning, fitting a rectangle). See
// docs/adr/0008-camera.md.
//
// Everything that must stay exact at deep zoom is computed in the camera's
// own space (the frame it is anchored in), never through root coordinates.

import {
  MAX_ZOOM,
  MIN_ZOOM,
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

/** A point on screen, in the camera's own space (exact at any zoom). */
export function screenToCamera(
  camera: CameraView,
  size: ScreenSize,
  point: Point,
): Point {
  return {
    x: camera.cx + (point.x - size.width / 2) / camera.zoom,
    y: camera.cy + (point.y - size.height / 2) / camera.zoom,
  };
}

/** Anchors views (anchor.ts) and gives offsets between spaces. */
export interface Placement {
  /** The view anchored where it should be (not clamped). */
  anchor(view: CameraView): CameraView;
  offset(from: ElementId | null, to: ElementId | null): Point;
}

/**
 * The camera zoomed by `factor` about a point on screen, which stays where it
 * is. With `placement`, the result is anchored where its centre is and its
 * zoom clamped to the precision budget there; the point under the pointer is
 * carried into the new space through the old centre, so it stays exact. When
 * the zoom cannot change (at a limit) the camera is returned as it is, so
 * pushing against a limit does not make it drift.
 */
export function zoomAbout(
  camera: CameraView,
  size: ScreenSize,
  at: Point,
  factor: number,
  placement?: Placement,
): CameraView {
  if (!(factor > 0) || !Number.isFinite(factor)) return camera;
  const dx = at.x - size.width / 2;
  const dy = at.y - size.height / 2;
  // The point under the pointer, in the camera's space.
  let px = camera.cx + dx / camera.zoom;
  let py = camera.cy + dy / camera.zoom;
  const wanted = Math.min(Math.max(camera.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  let space = camera.space;
  let centre = { x: px - dx / wanted, y: py - dy / wanted };
  if (placement !== undefined) {
    const placed = placement.anchor({ space, cx: centre.x, cy: centre.y, zoom: wanted });
    if (placed.space !== space) {
      // Through the old centre: the offset between the two spaces is computed
      // through their lowest common ancestor, and the centre is near both.
      const o = placement.offset(space, placed.space);
      px = camera.cx + o.x + dx / camera.zoom;
      py = camera.cy + o.y + dy / camera.zoom;
      space = placed.space;
    }
    centre = { x: placed.cx, y: placed.cy };
  }
  const zoom = clampZoom(wanted, centre.x, centre.y);
  if (zoom === camera.zoom && space === camera.space) return camera;
  return { space, cx: px - dx / zoom, cy: py - dy / zoom, zoom };
}

/** The camera moved by a distance in screen pixels (the canvas follows the pointer). */
export function panBy(camera: CameraView, dx: number, dy: number): CameraView {
  return {
    ...camera,
    cx: camera.cx - dx / camera.zoom,
    cy: camera.cy - dy / camera.zoom,
  };
}
