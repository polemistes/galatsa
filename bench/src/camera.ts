// SPDX-License-Identifier: GPL-3.0-or-later

// The fixed camera run: a list of camera poses, one per frame. Every engine renders
// exactly the same poses in the same order; a slow engine makes the run take longer
// instead of skipping poses. Frame counts assume a nominal 60 frames per second.
//
// The run, in order:
//   1. zoom in from 0.02 to 20 on a text box near the middle of the scene, hold;
//   2. zoom back out to 0.02, hold;
//   3. a short flight to the left edge, then a pan across the top row of clusters, hold;
//   4. a route flight between ten stops, holding at each stop.
//
// Poses use Math.exp, Math.log and the hyperbolic functions, which JavaScript
// engines may round differently in the last bits. The poses are identical within one
// engine; between engines they may differ by about 1e-15 relative.

import {
  CLUSTER_HEIGHT,
  type ImageElement,
  type Rect,
  type Scene,
  type SceneElement,
  type TextElement,
} from "./scene.ts";

/**
 * What the camera looks at. (x, y) is the world point at the centre of the viewport;
 * zoom is CSS pixels per world unit. A world point (wx, wy) appears on screen at
 *   sx = (wx - x) * zoom + viewportWidth / 2
 *   sy = (wy - y) * zoom + viewportHeight / 2
 */
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** The viewport size the run is framed for (CSS pixels). Other sizes see more or less. */
export const REFERENCE_VIEWPORT = { width: 1280, height: 720 } as const;
export const NOMINAL_FPS = 60;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 20;
export const PAN_ZOOM = 0.15;

export const ZOOM_FRAMES = 360;
export const PAN_FRAMES = 480;
export const FLIGHT_FRAMES = 90;
/** Frames the camera stands still after each movement (750 ms at 60 fps). */
export const HOLD_FRAMES = 45;
export const STOP_COUNT = 10;

export type SegmentKind = "zoom-in" | "zoom-out" | "pan" | "flight" | "hold";

export interface Segment {
  readonly kind: SegmentKind;
  readonly label: string;
  /** First frame of the segment. */
  readonly start: number;
  /** One past the last frame. */
  readonly end: number;
}

export interface CameraRun {
  /** One pose per frame. */
  readonly poses: readonly CameraPose[];
  /** Consecutive, covering every frame. */
  readonly segments: readonly Segment[];
  /** The ten route stops, in visiting order. */
  readonly stops: readonly CameraPose[];
}

/** Smooth start and stop: 3t^2 - 2t^3. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function zoomToFit(rect: Rect, fill: number): number {
  return (
    fill *
    Math.min(
      REFERENCE_VIEWPORT.width / rect.width,
      REFERENCE_VIEWPORT.height / rect.height,
    )
  );
}

function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The camera path between two poses that zooms out, moves and zooms in again, so
 * that the movement looks even on screen. After J. J. van Wijk and W. A. A. Nuij,
 * "Smooth and efficient zooming and panning", IEEE InfoVis 2003. `w` is the width of
 * the view in world units (reference viewport width / zoom). Returns a function of
 * s in [0, 1].
 */
export function flightPath(
  from: CameraPose,
  to: CameraPose,
  rho: number = Math.SQRT2,
): (s: number) => CameraPose {
  const w0 = REFERENCE_VIEWPORT.width / from.zoom;
  const w1 = REFERENCE_VIEWPORT.width / to.zoom;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  const rho2 = rho * rho;
  const rho4 = rho2 * rho2;

  if (d < 1e-9) {
    // No movement: zoom only, evenly in log scale.
    const total = Math.log(w1 / w0);
    return (s) => ({
      x: from.x + s * dx,
      y: from.y + s * dy,
      zoom: REFERENCE_VIEWPORT.width / (w0 * Math.exp(s * total)),
    });
  }

  const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const length = (r1 - r0) / rho;
  const coshR0 = Math.cosh(r0);
  const sinhR0 = Math.sinh(r0);

  return (s) => {
    if (s <= 0) return from;
    if (s >= 1) return to;
    const arc = s * length;
    // Distance travelled along the straight line from `from` to `to`.
    const u = (w0 / rho2) * (coshR0 * Math.tanh(rho * arc + r0) - sinhR0);
    const w = (w0 * coshR0) / Math.cosh(rho * arc + r0);
    const f = u / d;
    return { x: from.x + f * dx, y: from.y + f * dy, zoom: REFERENCE_VIEWPORT.width / w };
  };
}

/** Zoom between two levels around a fixed centre, evenly in log scale. */
function zoomPath(centre: { x: number; y: number }, z0: number, z1: number) {
  const l0 = Math.log(z0);
  const l1 = Math.log(z1);
  return (s: number): CameraPose => ({
    x: centre.x,
    y: centre.y,
    zoom: s >= 1 ? z1 : s <= 0 ? z0 : Math.exp(l0 + (l1 - l0) * s),
  });
}

/** The text box nearest the centre of the scene, among normal-sized body text. */
function zoomTarget(scene: Scene): TextElement {
  const cx = scene.bounds.x + scene.bounds.width / 2;
  const cy = scene.bounds.y + scene.bounds.height / 2;
  let best: TextElement | undefined;
  let bestDistance = Infinity;
  for (const e of scene.elements) {
    if (e.kind !== "text" || e.rotation !== 0 || e.fontSize < 12 || e.fontSize > 40)
      continue;
    const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
    if (d < bestDistance) {
      best = e;
      bestDistance = d;
    }
  }
  if (best === undefined) throw new Error("The scene has no text box to zoom in on");
  return best;
}

function largestIn<T extends SceneElement>(
  scene: Scene,
  cluster: Rect,
  match: (e: SceneElement) => e is T,
): T {
  let best: T | undefined;
  for (const e of scene.elements) {
    if (!match(e) || e.rotation !== 0) continue;
    const inside =
      e.x >= cluster.x &&
      e.y >= cluster.y &&
      e.x + e.width <= cluster.x + cluster.width &&
      e.y + e.height <= cluster.y + cluster.height;
    if (inside && (best === undefined || e.width * e.height > best.width * best.height)) {
      best = e;
    }
  }
  if (best === undefined) throw new Error("A cluster has no element for a stop");
  return best;
}

/**
 * The ten stops of the route, alternating between the two rows of clusters so that
 * flights are both long and short. Stops look at a whole cluster, at a text box, or
 * at an image.
 */
export function routeStops(scene: Scene): CameraPose[] {
  const order = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9];
  const isText = (e: SceneElement): e is TextElement => e.kind === "text";
  const isImage = (e: SceneElement): e is ImageElement => e.kind === "image";
  return order.slice(0, STOP_COUNT).map((clusterIndex, i) => {
    const cluster = scene.clusters[clusterIndex];
    if (cluster === undefined)
      throw new Error(`The scene has no cluster ${clusterIndex}`);
    const target: Rect =
      i % 3 === 0
        ? cluster
        : i % 3 === 1
          ? largestIn(scene, cluster, isText)
          : largestIn(scene, cluster, isImage);
    return { ...centreOf(target), zoom: zoomToFit(target, 0.9) };
  });
}

/** Builds the camera run for a scene. The same scene always gives the same run. */
export function createCameraRun(scene: Scene): CameraRun {
  const poses: CameraPose[] = [];
  const segments: Segment[] = [];
  let current: CameraPose;

  const move = (
    kind: SegmentKind,
    label: string,
    frames: number,
    path: (s: number) => CameraPose,
  ) => {
    const start = poses.length;
    for (let i = 1; i <= frames; i++) poses.push(path(smoothstep(i / frames)));
    current = path(1);
    segments.push({ kind, label, start, end: poses.length });
  };
  const hold = (label: string) => {
    const start = poses.length;
    for (let i = 0; i < HOLD_FRAMES; i++) poses.push(current);
    segments.push({ kind: "hold", label, start, end: poses.length });
  };

  // At zoom 20 the view's top-left corner is the text box's top-left corner.
  const text = zoomTarget(scene);
  const anchor = {
    x: text.x + REFERENCE_VIEWPORT.width / 2 / MAX_ZOOM,
    y: text.y + REFERENCE_VIEWPORT.height / 2 / MAX_ZOOM,
  };
  current = { ...anchor, zoom: MIN_ZOOM };

  move(
    "zoom-in",
    `zoom in on ${text.id}`,
    ZOOM_FRAMES,
    zoomPath(anchor, MIN_ZOOM, MAX_ZOOM),
  );
  hold("after zoom in");
  move("zoom-out", "zoom out", ZOOM_FRAMES, zoomPath(anchor, MAX_ZOOM, MIN_ZOOM));
  hold("after zoom out");

  const rowCentre = scene.bounds.y + CLUSTER_HEIGHT / 2;
  const panStart: CameraPose = { x: scene.bounds.x, y: rowCentre, zoom: PAN_ZOOM };
  const panEnd: CameraPose = {
    x: scene.bounds.x + scene.bounds.width,
    y: rowCentre,
    zoom: PAN_ZOOM,
  };
  move("flight", "to pan start", FLIGHT_FRAMES, flightPath(current, panStart));
  move("pan", "pan across", PAN_FRAMES, (s) => ({
    x: panStart.x + (panEnd.x - panStart.x) * s,
    y: rowCentre,
    zoom: PAN_ZOOM,
  }));
  hold("after pan");

  const stops = routeStops(scene);
  stops.forEach((stop, i) => {
    move("flight", `to stop ${i + 1}`, FLIGHT_FRAMES, flightPath(current, stop));
    hold(`at stop ${i + 1}`);
  });

  return { poses, segments, stops };
}

/** Total frames of a run and its length in seconds at the nominal frame rate. */
export function runLength(run: CameraRun): { frames: number; seconds: number } {
  return { frames: run.poses.length, seconds: run.poses.length / NOMINAL_FPS };
}
