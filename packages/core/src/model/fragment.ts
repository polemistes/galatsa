// SPDX-License-Identifier: GPL-3.0-or-later

// Copying part of a document (copy, duplicate, export of a selection) as a
// self-contained fragment that can be pasted with new ids, into the same or
// another document. Section 3.5 of docs/adr/0001-document-model-and-file-format.md.

import { keysBetween } from "./order.ts";
import { Resolver, lookupFromRecord } from "./resolve.ts";
import { isRemoved } from "./route.ts";
import {
  setOwn,
  type AssetId,
  type AssetInfo,
  type DocumentSnapshot,
  type Element,
  type ElementId,
  type Route,
  type RouteId,
  type Stop,
  type StopId,
} from "./types.ts";
import { referencedAssets } from "./walk.ts";

export interface Fragment {
  /**
   * Normalized copies: no rebases, revisions or delete marks; roots have parent
   * null.
   */
  elements: { [id: ElementId]: Element };
  /** Top-level elements, back to front. Their positions are in a common space. */
  roots: ElementId[];
  /**
   * Stops. A rectangle view whose space is null is in the same space as the
   * roots' positions.
   */
  stops: { [id: StopId]: Stop };
  /** Routes, with all their entries (also those whose stop is not in the fragment). */
  routes: { [id: RouteId]: Route };
  /** Descriptions of the assets the fragment refers to; the bytes travel separately. */
  assets: { [id: AssetId]: AssetInfo };
}

/**
 * Copies the given elements (with everything visible inside them), stops and
 * routes. Elements inside a selected element are not separate roots. Root
 * positions are expressed in the space the first root is seen in.
 */
export function copyFragment(
  snapshot: DocumentSnapshot,
  elementIds: readonly ElementId[],
  stopIds: readonly StopId[] = [],
  routeIds: readonly RouteId[] = [],
): Fragment {
  const r = new Resolver(lookupFromRecord(snapshot.elements));
  const selected = elementIds.filter(
    (id) => Object.hasOwn(snapshot.elements, id) && !r.isGone(id),
  );
  const chosen = new Set(selected);
  const insideAnother = (id: ElementId): boolean => {
    for (let at = r.parentOf(id); at !== null; at = r.parentOf(at)) {
      if (chosen.has(at)) return true;
    }
    return false;
  };
  const position = new Map(r.drawOrder().map((id, i) => [id, i]));
  const roots = [...chosen]
    .filter((id) => !insideAnother(id))
    .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  const space = roots.length > 0 ? r.logicalParentOf(roots[0]!) : null;

  const elements: { [id: ElementId]: Element } = {};
  // Copies one element; its visible children follow, with fresh order keys.
  const pending: Array<[ElementId, ElementId | null, ElementId | null, string]> = [];
  const rootKeys = keysBetween(null, null, roots.length);
  roots.forEach((id, i) => pending.push([id, null, space, rootKeys[i]!]));
  while (pending.length > 0) {
    const [id, parent, posSpace, order] = pending.pop()!;
    const pos = r.positionIn(id, posSpace);
    setOwn(elements, id, {
      ...structuredJson(snapshot.elements[id]!),
      parent,
      order,
      pos: { x: pos.x, y: pos.y, space: parent },
      rebase: null,
      rev: {},
      deleted: {},
      dissolved: false,
    });
    const children = r.logicalChildren(id);
    const keys = keysBetween(null, null, children.length);
    children.forEach((child, i) => pending.push([child, id, id, keys[i]!]));
  }

  const stops: { [id: StopId]: Stop } = {};
  for (const id of stopIds) {
    const stop = Object.hasOwn(snapshot.stops, id) ? snapshot.stops[id] : undefined;
    if (!stop || isRemoved(id, stop)) continue;
    const copy: Stop = { ...structuredJson(stop), rev: {}, deleted: {} };
    const view = copy.view;
    if (
      view.kind === "rect" &&
      !(view.space !== null && Object.hasOwn(elements, view.space))
    ) {
      // A rectangle outside the copied elements is expressed in the roots' space.
      const from = view.space !== null && r.isContainer(view.space) ? view.space : null;
      const d = r.offset(from, space);
      copy.view = { ...view, space: null, x: view.x + d.x, y: view.y + d.y };
    }
    setOwn(stops, id, copy);
  }
  const routes: { [id: RouteId]: Route } = {};
  for (const id of routeIds) {
    const route = Object.hasOwn(snapshot.routes, id) ? snapshot.routes[id] : undefined;
    if (route && !isRemoved(id, route))
      setOwn(routes, id, { ...structuredJson(route), rev: {}, deleted: {} });
  }

  const fragment: Fragment = { elements, roots, stops, routes, assets: {} };
  const used = referencedAssets({
    ...snapshot,
    elements,
    stops,
    routes,
    settings: {},
  });
  for (const id of used) {
    if (Object.hasOwn(snapshot.assets, id))
      setOwn(fragment.assets, id, snapshot.assets[id]!);
  }
  return fragment;
}

/** Deep copy of plain JSON-form data ("__proto__" keys included). */
function structuredJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
