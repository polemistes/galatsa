// SPDX-License-Identifier: GPL-3.0-or-later

// Stops and routes: the sequence a route plays, the region each stop shows, and
// which elements are hidden at each position. Section 6 of
// docs/adr/0001-document-model-and-file-format.md.

import { compareOrdered } from "./order.ts";
import type { Point, Resolver } from "./resolve.ts";
import { revisionDigest } from "./digest.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  type DeleteMarks,
  type DocumentSnapshot,
  type ElementId,
  type Rect,
  type Revision,
  type RouteEntryId,
  type RouteId,
  type Stop,
  type StopId,
} from "./types.ts";

/** One step of a route as played: which entry, which stop. */
export interface RouteStep {
  entry: RouteEntryId;
  stop: StopId;
}

type StopsAndRoutes = Pick<DocumentSnapshot, "stops" | "routes">;

/**
 * A stop or route is removed while one of its delete marks lists its current
 * revision; work on the record that the remover did not see cancels the removal
 * (section 5.5).
 */
export function isRemoved(
  id: string,
  record: { readonly rev: Revision; readonly deleted: DeleteMarks },
): boolean {
  let digest: string | undefined;
  for (const action of Object.keys(record.deleted)) {
    const seen = record.deleted[action]!.seen;
    if (!Object.hasOwn(seen, id)) continue;
    digest ??= revisionDigest(record.rev);
    if (seen[id] === digest) return true;
  }
  return false;
}

function liveStop(doc: StopsAndRoutes, id: StopId): Stop | undefined {
  const stop = Object.hasOwn(doc.stops, id) ? doc.stops[id] : undefined;
  return stop && !isRemoved(id, stop) ? stop : undefined;
}

/**
 * The steps of a route in playing order: entries sorted by order key and id,
 * skipping entries whose stop is missing or removed. A removed route has no steps.
 */
export function routeSteps(doc: StopsAndRoutes, routeId: RouteId): RouteStep[] {
  const route = Object.hasOwn(doc.routes, routeId) ? doc.routes[routeId] : undefined;
  if (!route || isRemoved(routeId, route)) return [];
  return Object.entries(route.entries)
    .map(([id, entry]) => ({ id, order: entry.order, stop: entry.stop }))
    .sort(compareOrdered)
    .filter((entry) => liveStop(doc, entry.stop) !== undefined)
    .map((entry) => ({ entry: entry.id, stop: entry.stop }));
}

/** Routes that are not removed, in list order. */
export function liveRoutes(doc: StopsAndRoutes): RouteId[] {
  return Object.entries(doc.routes)
    .filter(([id, route]) => !isRemoved(id, route))
    .map(([id, route]) => ({ id, order: route.order }))
    .sort(compareOrdered)
    .map((route) => route.id);
}

/** A region in the local space of a container (null = root). */
export interface Region {
  space: ElementId | null;
  rect: Rect;
}

/**
 * The region a stop shows, in the most local space available, so the camera can
 * anchor there (section 7.3). A frame stop uses the frame's geometry even when the
 * frame is removed (its record is kept); null if the frame is missing entirely.
 * A rectangle whose space is missing or not a container is read in root space.
 */
export function stopRegion(
  doc: StopsAndRoutes,
  resolver: Resolver,
  stopId: StopId,
): Region | null {
  const stop = Object.hasOwn(doc.stops, stopId) ? doc.stops[stopId] : undefined;
  if (!stop) return null;
  const view = stop.view;
  if (view.kind === "frame") {
    const frame = resolver.get(view.frame);
    if (!frame || frame.type !== FRAME_TYPE || !frame.size) return null;
    const local = resolver.localPosition(view.frame);
    const margin = Math.max(frame.size.w, frame.size.h) * Math.max(0, view.padding);
    return {
      space: resolver.parentOf(view.frame),
      rect: {
        x: local.x - margin,
        y: local.y - margin,
        w: frame.size.w + 2 * margin,
        h: frame.size.h + 2 * margin,
      },
    };
  }
  let space = view.space;
  if (space !== null) {
    const element = resolver.get(space);
    if (!element || (element.type !== FRAME_TYPE && element.type !== GROUP_TYPE))
      space = null;
  }
  return { space, rect: { x: view.x, y: view.y, w: view.w, h: view.h } };
}

/** A region converted to world coordinates (loses precision far from the origin). */
export function regionToWorld(resolver: Resolver, region: Region): Rect {
  const origin: Point = resolver.spaceOrigin(region.space);
  return { ...region.rect, x: origin.x + region.rect.x, y: origin.y + region.rect.y };
}

/**
 * Elements hidden by stop visibility at `position` in a route (section 6.4).
 *
 * Each stop may show or hide elements on arrival. Along a route the changes add
 * up: an element whose first change in the route is "show" starts hidden, any
 * other mentioned element starts visible, and each step applies its changes in
 * route order. Elements no stop mentions are always visible. Hiding a container
 * hides its subtree (see `isHiddenBy`).
 *
 * `position` -1 gives the state before the first stop.
 */
export function hiddenAt(
  doc: StopsAndRoutes,
  routeId: RouteId,
  position: number,
): Set<ElementId> {
  const steps = routeSteps(doc, routeId);
  const first = new Map<ElementId, "show" | "hide">();
  for (const step of steps) {
    const stop = liveStop(doc, step.stop);
    if (!stop) continue;
    for (const [element, change] of Object.entries(stop.visibility)) {
      if (!first.has(element)) first.set(element, change.action);
    }
  }
  const hidden = new Set<ElementId>();
  for (const [element, action] of first) if (action === "show") hidden.add(element);
  const last = Math.min(position, steps.length - 1);
  for (let i = 0; i <= last; i++) {
    const step = steps[i];
    const stop = step ? liveStop(doc, step.stop) : undefined;
    if (!stop) continue;
    for (const [element, change] of Object.entries(stop.visibility)) {
      if (change.action === "show") hidden.delete(element);
      else hidden.add(element);
    }
  }
  return hidden;
}

/**
 * True if the element or one of the ancestors the user sees is in `hidden`. Gone
 * (deleted or dissolved) containers are skipped: their former children are no
 * longer inside them for the user.
 */
export function isHiddenBy(
  resolver: Resolver,
  hidden: ReadonlySet<ElementId>,
  id: ElementId,
): boolean {
  if (hidden.has(id)) return true;
  for (
    let at = resolver.logicalParentOf(id);
    at !== null;
    at = resolver.logicalParentOf(at)
  ) {
    if (hidden.has(at)) return true;
  }
  return false;
}
