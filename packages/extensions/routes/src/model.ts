// SPDX-License-Identifier: GPL-3.0-or-later

// Reading routes and stops for the editor: which routes there are and what
// they visit, which routes use a stop, the rectangle the camera shows, and the
// camera that shows a stop. The document model is in @galatsa/core
// (docs/adr/0001, section 6); this is the editor's view of it
// (docs/adr/0013-routes-and-stops.md).

import {
  FRAME_TYPE,
  MAX_ZOOM,
  MIN_ZOOM,
  Resolver,
  compareOrdered,
  isRemoved,
  liveRoutes,
  routeSteps,
  stopRegion,
  zoomToFit,
  type CameraView,
  type DocumentSnapshot,
  type ElementId,
  type RectView,
  type Region,
  type RouteEntryId,
  type RouteId,
  type RouteStep,
  type StopId,
} from "@galatsa/core";
import { stopsAndRoutesOf, yLookup } from "@galatsa/core/ydoc";
import type { EditorServices } from "@galatsa/extension-api/editing";
import type * as Y from "yjs";

export type StopsAndRoutes = Pick<DocumentSnapshot, "stops" | "routes">;
export type { RouteStep };

/** The stops and routes of a document, read now. */
export function readRoutes(doc: Y.Doc): StopsAndRoutes {
  return stopsAndRoutesOf(doc);
}

/** A stop that exists and is not removed. */
export function isLiveStop(sr: StopsAndRoutes, id: unknown): id is StopId {
  if (typeof id !== "string" || !Object.hasOwn(sr.stops, id)) return false;
  return !isRemoved(id, sr.stops[id]!);
}

/** A route that exists and is not removed. */
export function isLiveRoute(sr: StopsAndRoutes, id: unknown): id is RouteId {
  if (typeof id !== "string" || !Object.hasOwn(sr.routes, id)) return false;
  return !isRemoved(id, sr.routes[id]!);
}

export { liveRoutes, routeSteps };

/** The routes that visit a stop now, in list order. */
export function routesUsing(sr: StopsAndRoutes, stop: StopId): RouteId[] {
  return liveRoutes(sr).filter((route) =>
    routeSteps(sr, route).some((step) => step.stop === stop),
  );
}

/**
 * Every stop that is not removed: first those the routes visit, in the order
 * of the routes and their steps, then the others by id.
 */
export function liveStops(sr: StopsAndRoutes): StopId[] {
  const out: StopId[] = [];
  const seen = new Set<StopId>();
  for (const route of liveRoutes(sr)) {
    for (const step of routeSteps(sr, route)) {
      if (seen.has(step.stop)) continue;
      seen.add(step.stop);
      out.push(step.stop);
    }
  }
  for (const id of Object.keys(sr.stops).sort()) {
    if (!seen.has(id) && isLiveStop(sr, id)) out.push(id);
  }
  return out;
}

/** Each stop's first place in any route (1 for the first step), in list order of the routes. */
export function firstPlaces(sr: StopsAndRoutes): Map<StopId, number> {
  const out = new Map<StopId, number>();
  for (const route of liveRoutes(sr))
    routeSteps(sr, route).forEach((step, i) => {
      if (!out.has(step.stop)) out.set(step.stop, i + 1);
    });
  return out;
}

/** All entries of a route (also those whose stop is removed), in order. */
export function entryOrder(sr: StopsAndRoutes, route: RouteId): RouteEntryId[] {
  const record = Object.hasOwn(sr.routes, route) ? sr.routes[route] : undefined;
  if (!record) return [];
  return Object.entries(record.entries)
    .map(([id, entry]) => ({ id, order: entry.order }))
    .sort(compareOrdered)
    .map((entry) => entry.id);
}

/**
 * Where to insert a visit so that it comes right after the step of `after`
 * (an entry of the route), or at the end: an index among all the route's
 * entries, as `insertRouteEntry` takes it.
 */
export function indexAfter(
  sr: StopsAndRoutes,
  route: RouteId,
  after: RouteEntryId | null | undefined,
): number {
  const all = entryOrder(sr, route);
  const at = after == null ? -1 : all.indexOf(after);
  return at < 0 ? all.length : at + 1;
}

/**
 * Where `moveRouteEntry` puts an entry so that it becomes step `index` of the
 * route as played (entries of removed stops are not steps): an index among
 * the route's other entries.
 */
export function moveIndex(
  sr: StopsAndRoutes,
  route: RouteId,
  entry: RouteEntryId,
  index: number,
): number {
  const others = entryOrder(sr, route).filter((id) => id !== entry);
  const steps = routeSteps(sr, route).filter((step) => step.entry !== entry);
  if (index >= steps.length) return others.length;
  return others.indexOf(steps[Math.max(0, index)]!.entry);
}

/** The size of the drawing area in CSS pixels, from the camera service. */
export function screenOf(services: EditorServices): { width: number; height: number } {
  const view = services.camera.viewport();
  const zoom = services.camera.get().zoom;
  return { width: view.w * zoom, height: view.h * zoom };
}

/**
 * The rectangle the camera shows now, as a stop view: in the camera's own
 * space, carried up to the innermost container whose box holds all of it
 * (docs/adr/0001, section 6.2: the innermost frame that contains the whole
 * rectangle). Exact wherever the camera is anchored: every step adds the
 * offset between neighbouring spaces.
 */
export function viewOfCamera(doc: Y.Doc, services: EditorServices): RectView {
  const camera = services.camera.get();
  const shown = services.camera.viewport();
  const w = shown.w;
  const h = shown.h;
  let space: ElementId | null = camera.space;
  let x = camera.cx - w / 2;
  let y = camera.cy - h / 2;
  const r = new Resolver(yLookup(doc));
  const seen = new Set<ElementId>();
  while (space !== null && !seen.has(space)) {
    seen.add(space);
    const element = r.get(space);
    const size = element?.type === FRAME_TYPE ? element.size : undefined;
    if (size && x >= 0 && y >= 0 && x + w <= size.w && y + h <= size.h) break;
    const parent: ElementId | null = r.parentOf(space);
    const o = services.scene.offset(space, parent);
    x += o.x;
    y += o.y;
    space = parent;
  }
  return { kind: "rect", space, x, y, w, h };
}

/** The region a stop shows now, or null if it shows nothing (its frame is missing). */
export function regionOf(doc: Y.Doc, sr: StopsAndRoutes, stop: StopId): Region | null {
  if (!Object.hasOwn(sr.stops, stop)) return null;
  return stopRegion(sr, new Resolver(yLookup(doc)), stop);
}

/**
 * The camera that shows a region filling the screen, centred, keeping its
 * proportions (docs/adr/0001, section 6.2), within the zoom range.
 */
export function cameraForRegion(
  region: Region,
  screen: { readonly width: number; readonly height: number },
): CameraView {
  const { rect } = region;
  const zoom = zoomToFit(rect, screen.width, screen.height);
  return {
    space: region.space,
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    zoom: Math.min(Math.max(zoom > 0 ? zoom : 1, MIN_ZOOM), MAX_ZOOM),
  };
}
