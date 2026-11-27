// SPDX-License-Identifier: GPL-3.0-or-later

// Purging for exports for sharing: the pure function from a snapshot to an
// equivalent one without deleted or dissolved elements, removed stops and
// routes, and anything only they referred to. The result is for a file without
// merge identity. (Tidy up of a live document is a different operation: it
// leaves place markers and rewrites nothing; see ydoc/document-ops.ts.)
// Section 5.8 of docs/adr/0001-document-model-and-file-format.md.

import { compareCodeUnits, keysBetween } from "./order.ts";
import { Resolver, lookupFromRecord } from "./resolve.ts";
import { isRemoved, stopRegion } from "./route.ts";
import {
  setOwn,
  type AssetId,
  type DocumentSnapshot,
  type Element,
  type ElementId,
  type Route,
  type Stop,
} from "./types.ts";
import { referencedAssets } from "./walk.ts";

/**
 * The snapshot after purging. What the user sees is unchanged: surviving children
 * of gone containers are moved into the container the user sees them in, at the
 * same place on the canvas and in the same stacking order; frame stops whose
 * frame is gone become rectangle stops showing the same region. Positions are
 * normalized (no rebases), and revisions and delete marks are cleared: the
 * result is for a file without merge identity (section 5.8).
 */
export function purgeSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  const r = new Resolver(lookupFromRecord(snapshot.elements));
  const live = (id: ElementId) => Object.hasOwn(snapshot.elements, id) && !r.isGone(id);
  const liveSpace = (space: ElementId | null): ElementId | null => {
    let at = space;
    while (at !== null && Object.hasOwn(snapshot.elements, at) && r.isGone(at))
      at = r.parentOf(at);
    return at !== null && Object.hasOwn(snapshot.elements, at) ? at : null;
  };

  const elements: { [id: ElementId]: Element } = {};
  for (const id of Object.keys(snapshot.elements)) {
    if (!live(id)) continue;
    const element = snapshot.elements[id]!;
    const parent = r.logicalParentOf(id);
    const pos = r.positionIn(id, parent);
    setOwn(elements, id, {
      ...element,
      parent,
      pos: { x: pos.x, y: pos.y, space: parent },
      rebase: null,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
    });
  }

  // Re-key children that moved out of gone containers, in visible order.
  for (const container of [null, ...Object.keys(elements)]) {
    if (container !== null && !r.isContainer(container)) continue;
    const visible = r.logicalChildren(container);
    let i = 0;
    while (i < visible.length) {
      if (r.parentOf(visible[i]!) === container) {
        i++;
        continue;
      }
      let j = i;
      while (j < visible.length && r.parentOf(visible[j]!) !== container) j++;
      const low = i > 0 ? elements[visible[i - 1]!]!.order : null;
      const high = j < visible.length ? elements[visible[j]!]!.order : null;
      const keys = keysBetween(low, high, j - i);
      for (let k = i; k < j; k++) elements[visible[k]!]!.order = keys[k - i]!;
      i = j;
    }
  }

  const stops: { [id: string]: Stop } = {};
  for (const id of Object.keys(snapshot.stops)) {
    const stop = snapshot.stops[id]!;
    if (isRemoved(id, stop)) continue;
    let view = stop.view;
    if (view.kind === "frame" && !live(view.frame)) {
      const region = stopRegion(snapshot, r, id);
      if (!region) continue;
      const space = liveSpace(region.space);
      const d = r.offset(region.space, space);
      view = {
        kind: "rect",
        space,
        ...region.rect,
        x: region.rect.x + d.x,
        y: region.rect.y + d.y,
      };
    } else if (view.kind === "rect" && view.space !== null && !live(view.space)) {
      const space = liveSpace(view.space);
      const d = Object.hasOwn(snapshot.elements, view.space)
        ? r.offset(view.space, space)
        : { x: 0, y: 0 };
      view = { ...view, space, x: view.x + d.x, y: view.y + d.y };
    }
    const visibility: Stop["visibility"] = {};
    for (const element of Object.keys(stop.visibility)) {
      if (live(element)) setOwn(visibility, element, stop.visibility[element]!);
    }
    setOwn(stops, id, { ...stop, view, visibility, rev: {}, deleted: {} });
  }

  const routes: { [id: string]: Route } = {};
  for (const id of Object.keys(snapshot.routes)) {
    const route = snapshot.routes[id]!;
    if (isRemoved(id, route)) continue;
    const entries: Route["entries"] = {};
    for (const entry of Object.keys(route.entries)) {
      if (Object.hasOwn(stops, route.entries[entry]!.stop))
        setOwn(entries, entry, route.entries[entry]!);
    }
    setOwn(routes, id, { ...route, entries, rev: {}, deleted: {} });
  }

  for (const element of Object.values(elements)) {
    element.refs = element.refs.filter(
      (ref) => Object.hasOwn(elements, ref) || Object.hasOwn(stops, ref),
    );
  }

  const result: DocumentSnapshot = { ...snapshot, elements, stops, routes, assets: {} };
  const used = referencedAssets(result);
  for (const id of Object.keys(snapshot.assets).sort(compareCodeUnits)) {
    if (used.has(id as AssetId))
      setOwn(result.assets, id, snapshot.assets[id as AssetId]!);
  }
  return result;
}

/** Ids removed by purging, for a tidy-up summary. */
export function purgeSummary(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): {
  elements: number;
  stops: number;
  routes: number;
  assets: number;
} {
  const count = (a: object, b: object) => Object.keys(a).length - Object.keys(b).length;
  return {
    elements: count(before.elements, after.elements),
    stops: count(before.stops, after.stops),
    routes: count(before.routes, after.routes),
    assets: count(before.assets, after.assets),
  };
}
