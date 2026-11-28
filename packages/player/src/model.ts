// SPDX-License-Identifier: GPL-3.0-or-later

// What the player reads of a document: its routes, the steps of a route with
// their names and notes, and the camera that shows a stop. The document model
// is in @galatsa/core (docs/adr/0001, section 6); nothing here needs Yjs, so
// the same code plays the editor's live document and a file that was read
// into a snapshot. See docs/adr/0015-presentation.md.

import {
  clampZoom,
  liveRoutes,
  lookupFromRecord,
  Resolver,
  routeSteps,
  stopRegion,
  zoomToFit,
  type CameraView,
  type DocumentSnapshot,
  type ElementId,
  type Json,
  type Region,
  type RouteEntryId,
  type RouteId,
  type StopId,
  type YTextValue,
} from "@galatsa/core";

export type StopsAndRoutes = Pick<DocumentSnapshot, "stops" | "routes">;

/** The document as the player reads it. */
export interface PresentationSource {
  /** The stops and routes as they are now. */
  stopsAndRoutes(): StopsAndRoutes;
  /** The resolved elements of the same state: positions, containers, offsets. */
  readonly resolver: Resolver;
  /** An element's name ("" for none): a frame stop without a name is called by its frame's. */
  nameOf?(id: ElementId): string;
  /** A document-wide setting (docs/adr/0001, section 2), undefined when it is not set. */
  setting?(key: string): Json | undefined;
}

/** Size of the drawing area in CSS pixels. */
export interface Screen {
  readonly width: number;
  readonly height: number;
}

export interface RouteInfo {
  readonly id: RouteId;
  readonly name: string;
}

/** One step of a route as played. */
export interface Step {
  readonly entry: RouteEntryId;
  readonly stop: StopId;
  /** Its place among the route's steps as the model counts them (`hiddenAt`). */
  readonly place: number;
  /** The stop's name, else its frame's; "" when neither has one. */
  readonly name: string;
  /** The speaker notes, as plain text. */
  readonly notes: string;
}

/** A source over a document that was read into a snapshot (a file). */
export function sourceFromSnapshot(
  snapshot: Pick<DocumentSnapshot, "elements" | "stops" | "routes"> &
    Partial<Pick<DocumentSnapshot, "settings">>,
): PresentationSource {
  const elements = snapshot.elements;
  return {
    stopsAndRoutes: () => snapshot,
    resolver: new Resolver(lookupFromRecord(elements)),
    nameOf: (id) => (Object.hasOwn(elements, id) ? (elements[id]?.name ?? "") : ""),
    setting: (key) =>
      snapshot.settings !== undefined && Object.hasOwn(snapshot.settings, key)
        ? snapshot.settings[key]
        : undefined,
  };
}

/** The routes that can be played, in list order. */
export function readRoutes(sr: StopsAndRoutes): RouteInfo[] {
  return liveRoutes(sr).map((id) => ({ id, name: sr.routes[id]?.name ?? "" }));
}

/** Notes as plain text: the text runs joined, embedded objects left out. */
export function notesText(notes: YTextValue | undefined): string {
  let text = "";
  for (const run of notes?.delta ?? [])
    if (typeof run.insert === "string") text += run.insert;
  return text;
}

/**
 * The steps of a route in playing order. A stop that shows nothing (its
 * frame's record is missing entirely) is skipped (docs/adr/0001, section 6.2).
 */
export function readSteps(
  source: PresentationSource,
  sr: StopsAndRoutes,
  route: RouteId | null,
): Step[] {
  if (route === null) return [];
  const out: Step[] = [];
  for (const [place, step] of routeSteps(sr, route).entries()) {
    const stop = sr.stops[step.stop];
    if (!stop || stopRegion(sr, source.resolver, step.stop) === null) continue;
    let name = stop.name;
    if (name === "" && stop.view.kind === "frame")
      name = source.nameOf?.(stop.view.frame) ?? "";
    out.push({
      entry: step.entry,
      stop: step.stop,
      place,
      name,
      notes: notesText(stop.notes),
    });
  }
  return out;
}

/**
 * The camera that shows a region filling the screen, centred, keeping its
 * proportions (docs/adr/0001, section 6.2), within the zoom range and the
 * precision budget of the space it is in.
 */
export function viewOfRegion(region: Region, screen: Screen): CameraView {
  const { rect } = region;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const zoom = zoomToFit(rect, screen.width, screen.height);
  return {
    space: region.space,
    cx,
    cy,
    zoom: clampZoom(zoom > 0 && Number.isFinite(zoom) ? zoom : 1, cx, cy),
  };
}

export function sameView(a: CameraView, b: CameraView): boolean {
  return a.space === b.space && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}
