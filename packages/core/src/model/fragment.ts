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
  type Stop,
  type StopId,
} from "./types.ts";
import { referencedAssets } from "./walk.ts";

export interface Fragment {
  /** Normalized copies: no rebases or removal marks; roots have parent null. */
  elements: { [id: ElementId]: Element };
  /** Top-level elements, back to front. Their positions are in a common space. */
  roots: ElementId[];
  stops: { [id: StopId]: Stop };
  /** Descriptions of the assets the fragment refers to; the bytes travel separately. */
  assets: { [id: AssetId]: AssetInfo };
}

/**
 * Copies the given elements (with everything visible inside them) and stops.
 * Elements inside a selected element are not separate roots. Root positions are
 * expressed in the space the first root is seen in.
 */
export function copyFragment(
  snapshot: DocumentSnapshot,
  elementIds: readonly ElementId[],
  stopIds: readonly StopId[] = [],
): Fragment {
  const r = new Resolver(lookupFromRecord(snapshot.elements));
  const selected = elementIds.filter(
    (id) => Object.hasOwn(snapshot.elements, id) && !r.isGone(id),
  );
  const roots = selected.filter(
    (id) => !selected.some((other) => other !== id && r.isWithin(id, other)),
  );
  const order = r.drawOrder();
  roots.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const space = roots.length > 0 ? r.logicalParentOf(roots[0]!) : null;

  const elements: { [id: ElementId]: Element } = {};
  const copy = (id: ElementId, parent: ElementId | null, posSpace: ElementId | null) => {
    const element = snapshot.elements[id]!;
    const pos = r.positionIn(id, posSpace);
    setOwn(elements, id, {
      ...structuredJson(element),
      parent,
      pos: { x: pos.x, y: pos.y, space: parent },
      rebase: null,
      deleted: null,
      dissolved: false,
    });
    const children = r.logicalChildren(id);
    const keys = keysBetween(null, null, children.length);
    children.forEach((child, i) => {
      copy(child, id, id);
      elements[child]!.order = keys[i]!;
    });
  };
  const rootKeys = keysBetween(null, null, roots.length);
  roots.forEach((id, i) => {
    copy(id, null, space);
    elements[id]!.order = rootKeys[i]!;
  });

  const stops: { [id: StopId]: Stop } = {};
  for (const id of stopIds) {
    const stop = Object.hasOwn(snapshot.stops, id) ? snapshot.stops[id] : undefined;
    if (stop && !isRemoved(stop))
      setOwn(stops, id, { ...structuredJson(stop), removed: null });
  }

  const fragment: Fragment = { elements, roots, stops, assets: {} };
  const used = referencedAssets({
    ...snapshot,
    elements,
    stops,
    routes: {},
    settings: {},
  });
  for (const id of used) {
    if (Object.hasOwn(snapshot.assets, id))
      setOwn(fragment.assets, id, snapshot.assets[id]!);
  }
  return fragment;
}

/** Deep copy of plain JSON-form data. */
function structuredJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
