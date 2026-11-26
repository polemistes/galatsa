// SPDX-License-Identifier: GPL-3.0-or-later

// Operations on a whole Y.Doc: tidy up (purge removed content) and paste a
// fragment with new ids. Sections 3.5 and 5.8 of
// docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import type { Fragment } from "../model/fragment.ts";
import { newId } from "../model/ids.ts";
import { keysBetween } from "../model/order.ts";
import { purgeSnapshot, purgeSummary } from "../model/purge.ts";
import { Resolver } from "../model/resolve.ts";
import {
  setOwn,
  type AssetId,
  type Element,
  type ElementId,
  type Stop,
  type StopId,
} from "../model/types.ts";
import { remapStrings } from "../model/walk.ts";
import { cloneJson } from "./encode.ts";
import { addAsset, type OpOptions } from "./ops.ts";
import { ORIGIN, roots } from "./schema.ts";
import { toSnapshot, writeElement, writeStop, yLookup } from "./snapshot.ts";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Tidy up (section 5.8): permanently removes deleted and dissolved elements,
 * removed stops and routes, and unused asset descriptions, keeping what the user
 * sees unchanged. It cannot be undone, and edits that long-offline copies made to
 * purged records are lost when they merge, which is why it only runs on request.
 */
export function tidyUp(doc: Y.Doc): ReturnType<typeof purgeSummary> {
  const before = toSnapshot(doc);
  const after = purgeSnapshot(before);
  const r = roots(doc);
  doc.transact(() => {
    for (const id of [...r.elements.keys()]) {
      const next = Object.hasOwn(after.elements, id) ? after.elements[id] : undefined;
      if (!next) {
        r.elements.delete(id);
        continue;
      }
      const map = r.elements.get(id)!;
      const prev = before.elements[id]!;
      for (const key of [
        "parent",
        "order",
        "pos",
        "rebase",
        "deleted",
        "dissolved",
        "refs",
      ] as const) {
        if (!same(prev[key], next[key])) map.set(key, cloneJson(next[key]));
      }
    }
    for (const id of [...r.stops.keys()]) {
      const next = Object.hasOwn(after.stops, id) ? after.stops[id] : undefined;
      if (!next) {
        r.stops.delete(id);
        continue;
      }
      const map = r.stops.get(id)!;
      const prev = before.stops[id]!;
      if (!same(prev.view, next.view)) map.set("view", cloneJson(next.view));
      if (prev.removed !== null) map.set("removed", null);
      const visibility = map.get("visibility");
      if (visibility instanceof Y.Map) {
        for (const element of [...visibility.keys()]) {
          if (!Object.hasOwn(next.visibility, element)) visibility.delete(element);
        }
      }
    }
    for (const id of [...r.routes.keys()]) {
      const next = Object.hasOwn(after.routes, id) ? after.routes[id] : undefined;
      if (!next) {
        r.routes.delete(id);
        continue;
      }
      const map = r.routes.get(id)!;
      if (before.routes[id]!.removed !== null) map.set("removed", null);
      const entries = map.get("entries");
      if (entries instanceof Y.Map) {
        for (const entry of [...entries.keys()]) {
          if (!Object.hasOwn(next.entries, entry)) entries.delete(entry);
        }
      }
    }
    for (const id of [...r.assets.keys()]) {
      if (!Object.hasOwn(after.assets, id)) r.assets.delete(id);
    }
  }, ORIGIN.tidy);
  return purgeSummary(before, after);
}

export interface PasteResult {
  /** Old id -> new id, for elements and stops. */
  ids: Map<string, string>;
  /** Assets the pasted content refers to; copy their bytes into this document's store. */
  assets: AssetId[];
}

/**
 * Pastes a fragment with new ids (section 3.5). Roots go into `parent` (default:
 * the root), moved by (dx, dy), in front of what is there. Inside each element,
 * strings equal to an id the element lists in `refs` are remapped if that id was
 * pasted too; so are parents, position spaces, frame stops, stop spaces and
 * visibility entries. Undo removes the pasted records softly.
 */
export function pasteFragment(
  doc: Y.Doc,
  fragment: Fragment,
  target: { parent?: ElementId | null; dx?: number; dy?: number } = {},
  options?: OpOptions,
): PasteResult {
  const parent = target.parent ?? null;
  const dx = target.dx ?? 0;
  const dy = target.dy ?? 0;
  const ids = new Map<string, string>();
  for (const id of [...Object.keys(fragment.elements), ...Object.keys(fragment.stops)]) {
    ids.set(id, newId(options?.randomBytes));
  }
  const mapId = (id: string | null) => (id === null ? null : (ids.get(id) ?? id));

  const r = new Resolver(yLookup(doc));
  const front = r
    .children(parent)
    .filter((id) => !r.isGone(id))
    .map((id) => r.get(id)!.order)
    .pop();
  const rootKeys = keysBetween(front ?? null, null, fragment.roots.length);
  const rootSet = new Set(fragment.roots);
  const action = newId(options?.randomBytes);

  const elements: [ElementId, Element][] = [];
  for (const [oldId, element] of Object.entries(fragment.elements)) {
    const id = ids.get(oldId)!;
    const own = new Map([...ids].filter(([from]) => element.refs.includes(from)));
    const isRoot = rootSet.has(oldId);
    const rev = newId(options?.randomBytes);
    const next: Element = {
      ...element,
      parent: isRoot ? parent : mapId(element.parent),
      order: isRoot ? rootKeys[fragment.roots.indexOf(oldId)]! : element.order,
      pos: isRoot
        ? { x: element.pos.x + dx, y: element.pos.y + dy, space: parent }
        : { ...element.pos, space: mapId(element.pos.space) },
      rebase: null,
      rev,
      deleted: { action, root: id, rev },
      dissolved: false,
      refs: element.refs.map((ref) => ids.get(ref) ?? ref),
      ext: remapStrings(element.ext, own),
      data: remapStrings(element.data, own),
    };
    elements.push([id, next]);
  }
  const stops: [StopId, Stop][] = [];
  for (const [oldId, stop] of Object.entries(fragment.stops)) {
    const rev = newId(options?.randomBytes);
    const view =
      stop.view.kind === "frame"
        ? { ...stop.view, frame: mapId(stop.view.frame)! }
        : { ...stop.view, space: mapId(stop.view.space) };
    const visibility: Stop["visibility"] = {};
    for (const element of Object.keys(stop.visibility)) {
      if (ids.has(element))
        setOwn(visibility, ids.get(element)!, stop.visibility[element]!);
    }
    stops.push([ids.get(oldId)!, { ...stop, view, visibility, rev, removed: { rev } }]);
  }

  for (const [id, info] of Object.entries(fragment.assets))
    addAsset(doc, id as AssetId, info);
  const r0 = roots(doc);
  doc.transact(() => {
    for (const [id, element] of elements) {
      const map = new Y.Map<unknown>();
      r0.elements.set(id, map);
      writeElement(map, element);
    }
    for (const [id, stop] of stops) {
      const map = new Y.Map<unknown>();
      r0.stops.set(id, map);
      writeStop(map, stop);
    }
  }, ORIGIN.create);
  doc.transact(() => {
    for (const [id] of elements) r0.elements.get(id)!.set("deleted", null);
    for (const [id] of stops) r0.stops.get(id)!.set("removed", null);
  }, options?.origin ?? ORIGIN.local);
  return { ids, assets: Object.keys(fragment.assets) as AssetId[] };
}
