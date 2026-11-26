// SPDX-License-Identifier: GPL-3.0-or-later

// Reference operations on a Galatsa Y.Doc: the writes each user action makes, as
// specified in section 5 of docs/adr/0001-document-model-and-file-format.md. The
// command layer (with undo) is built on top of these. Every operation runs in one
// transaction, so remote replicas see it whole.
//
// The operations do not check locking: locking is an editor rule (section 5.6).

import * as Y from "yjs";
import { newId, type RandomBytes } from "../model/ids.ts";
import { keyAt, sortOrdered, type Ordered, type RandomSource } from "../model/order.ts";
import { Resolver } from "../model/resolve.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DataValue,
  type Element,
  type ElementData,
  type ElementId,
  type ElementTypeId,
  type Json,
  type RouteEntryId,
  type RouteId,
  type StopId,
  type StopView,
  type TextRun,
} from "../model/types.ts";
import { cloneJson, dataValueToY } from "./encode.ts";
import { ORIGIN, roots } from "./schema.ts";
import { writeElement, writeRoute, writeStop, yLookup } from "./snapshot.ts";

/** Options shared by all operations. */
export interface OpOptions {
  /** Transaction origin; defaults to ORIGIN.local. */
  origin?: unknown;
  /** Random numbers for order-key jitter (tests pass a seeded source). */
  random?: RandomSource;
  /** Random bytes for new ids. */
  randomBytes?: RandomBytes;
}

function transact<T>(doc: Y.Doc, options: OpOptions | undefined, fn: () => T): T {
  let result!: T;
  doc.transact(() => {
    result = fn();
  }, options?.origin ?? ORIGIN.local);
  return result;
}

function elementMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const map = roots(doc).elements.get(id);
  if (!map) throw new Error(`No element ${id}`);
  return map;
}

function resolver(doc: Y.Doc): Resolver {
  return new Resolver(yLookup(doc));
}

/** Live (not deleted) children of a container in the effective tree, back to front. */
function liveSiblings(
  r: Resolver,
  parent: ElementId | null,
  except?: ElementId,
): Ordered[] {
  return r
    .children(parent)
    .filter((id) => id !== except && r.get(id)?.removed !== "delete")
    .map((id) => ({ id, order: r.get(id)?.order ?? "" }));
}

/** Creates a new, empty document. */
export function initDocument(
  doc: Y.Doc,
  init: { id?: string; title?: string } = {},
  options?: OpOptions,
): void {
  const r = roots(doc);
  transact(doc, options, () => {
    r.meta.set("schemaVersion", SCHEMA_VERSION);
    r.meta.set("id", init.id ?? newId(options?.randomBytes));
    r.meta.set("title", init.title ?? "");
  });
}

export function setTitle(doc: Y.Doc, title: string, options?: OpOptions): void {
  transact(doc, options, () => roots(doc).meta.set("title", title));
}

export function setSetting(
  doc: Y.Doc,
  key: string,
  value: Json,
  options?: OpOptions,
): void {
  transact(doc, options, () => roots(doc).settings.set(key, cloneJson(value)));
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export interface NewElement {
  id?: ElementId;
  type: ElementTypeId;
  typeVersion?: number;
  parent?: ElementId | null;
  /** Position in the parent's local space. */
  x: number;
  y: number;
  /** Required for everything but groups. */
  size?: { w: number; h: number };
  rot?: number;
  name?: string;
  locked?: boolean;
  assets?: AssetId[];
  data?: ElementData;
  /** Stacking index among the parent's live children; default: in front. */
  index?: number;
}

/** Adds an element and returns its id. */
export function addElement(doc: Y.Doc, init: NewElement, options?: OpOptions): ElementId {
  const id = init.id ?? newId(options?.randomBytes);
  const parent = init.parent ?? null;
  return transact(doc, options, () => {
    const r = resolver(doc);
    const siblings = liveSiblings(r, parent);
    const base = {
      type: init.type,
      typeVersion: init.typeVersion ?? 1,
      parent,
      order: keyAt(siblings, init.index ?? siblings.length, options?.random),
      pos: { x: init.x, y: init.y, space: parent },
      name: init.name ?? "",
      locked: init.locked ?? false,
      assets: init.assets ?? [],
      removed: null,
      data: init.data ?? {},
    };
    let element: Element;
    if (init.type === GROUP_TYPE) element = { ...base, type: GROUP_TYPE };
    else {
      if (!init.size) throw new Error(`Element type ${init.type} needs a size`);
      element =
        init.type === FRAME_TYPE
          ? { ...base, type: FRAME_TYPE, size: init.size }
          : { ...base, size: init.size, rot: init.rot ?? 0 };
    }
    const map = new Y.Map<unknown>();
    roots(doc).elements.set(id, map);
    writeElement(map, element);
    return id;
  });
}

/**
 * Moves an element within its parent. The position is tagged with the parent, so
 * a concurrent reparent can convert it (section 5.3).
 */
export function moveElement(
  doc: Y.Doc,
  id: ElementId,
  x: number,
  y: number,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    const parent = resolver(doc).parentOf(id);
    if (map.get("parent") !== parent) map.set("parent", parent);
    map.set("pos", { x, y, space: parent });
  });
}

export function resizeElement(
  doc: Y.Doc,
  id: ElementId,
  w: number,
  h: number,
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set("size", { w, h }));
}

export function rotateElement(
  doc: Y.Doc,
  id: ElementId,
  rot: number,
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set("rot", rot));
}

export function renameElement(
  doc: Y.Doc,
  id: ElementId,
  name: string,
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set("name", name));
}

export function setLocked(
  doc: Y.Doc,
  id: ElementId,
  locked: boolean,
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set("locked", locked));
}

export function setAssets(
  doc: Y.Doc,
  id: ElementId,
  assets: AssetId[],
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set("assets", [...assets]));
}

/** Replaces one key of the element's data with a new value. */
export function setData(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: DataValue,
  options?: OpOptions,
): void {
  transact(doc, options, () => dataMap(doc, id).set(key, dataValueToY(value)));
}

/** The element's data map, for editing shared types (text, arrays) in place. */
export function dataMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const data = elementMap(doc, id).get("data");
  if (!(data instanceof Y.Map)) throw new Error(`Element ${id} has no data map`);
  return data;
}

/** Runs `fn` in one local transaction (for in-place edits of shared types). */
export function edit(doc: Y.Doc, fn: () => void, options?: OpOptions): void {
  transact(doc, options, fn);
}

// ---------------------------------------------------------------------------
// Z-order (section 4)
// ---------------------------------------------------------------------------

function restack(
  doc: Y.Doc,
  id: ElementId,
  target: (siblings: Ordered[], current: number) => number,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    const parent = r.parentOf(id);
    const all = liveSiblings(r, parent);
    const current = all.findIndex((s) => s.id === id);
    const others = all.filter((s) => s.id !== id);
    const index = target(others, current);
    if (index === current) return;
    elementMap(doc, id).set("order", keyAt(others, index, options?.random));
  });
}

export function bringToFront(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, (others) => others.length, options);
}

export function sendToBack(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, () => 0, options);
}

/** One step forward: past the sibling directly in front. */
export function bringForward(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, (others, current) => Math.min(current + 1, others.length), options);
}

/** One step backward: behind the sibling directly behind. */
export function sendBackward(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, (_others, current) => Math.max(current - 1, 0), options);
}

// ---------------------------------------------------------------------------
// Containers (section 5)
// ---------------------------------------------------------------------------

/**
 * Moves an element into another container (or the root) without moving it on the
 * canvas: parent, tagged position and order key are written together.
 */
export function reparent(
  doc: Y.Doc,
  id: ElementId,
  parent: ElementId | null,
  options?: OpOptions & { index?: number },
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    if (parent !== null) {
      const target = r.get(parent);
      if (!target || (target.type !== FRAME_TYPE && target.type !== GROUP_TYPE)) {
        throw new Error(`${parent} is not a frame or group`);
      }
      if (r.isWithin(parent, id))
        throw new Error("An element cannot be moved into itself");
    }
    const world = r.worldOrigin(id);
    const origin = r.spaceOrigin(parent);
    const siblings = liveSiblings(r, parent, id);
    const map = elementMap(doc, id);
    map.set("parent", parent);
    map.set("pos", { x: world.x - origin.x, y: world.y - origin.y, space: parent });
    map.set("order", keyAt(siblings, options?.index ?? siblings.length, options?.random));
  });
}

/**
 * Groups elements that share a parent. The group takes the frontmost member's
 * place in the stacking order; members keep their order keys, now among each
 * other, and their positions become relative to the group's origin (the top-left
 * corner of their bounds).
 */
export function group(
  doc: Y.Doc,
  ids: readonly ElementId[],
  options?: OpOptions & { id?: ElementId },
): ElementId {
  if (ids.length === 0) throw new Error("Nothing to group");
  const groupId = options?.id ?? newId(options?.randomBytes);
  return transact(doc, options, () => {
    const r = resolver(doc);
    const parent = r.parentOf(ids[0]!);
    if (ids.some((id) => r.parentOf(id) !== parent))
      throw new Error("Grouped elements must share a parent");
    const origin = r.spaceOrigin(parent);
    let minX = Infinity;
    let minY = Infinity;
    for (const id of ids) {
      const b = r.bounds(id);
      const w = b ?? { ...r.worldOrigin(id), w: 0, h: 0 };
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
    }
    const gx = minX - origin.x;
    const gy = minY - origin.y;
    const members = sortOrdered(ids.map((id) => ({ id, order: r.get(id)?.order ?? "" })));
    const front = members[members.length - 1]!;
    const map = new Y.Map<unknown>();
    roots(doc).elements.set(groupId, map);
    writeElement(map, {
      type: GROUP_TYPE,
      typeVersion: 1,
      parent,
      order: front.order,
      pos: { x: gx, y: gy, space: parent },
      name: "",
      locked: false,
      assets: [],
      removed: null,
      data: {},
    });
    for (const id of ids) {
      const local = r.localPosition(id);
      const m = elementMap(doc, id);
      m.set("parent", groupId);
      m.set("pos", { x: local.x - gx, y: local.y - gy, space: groupId });
    }
    return groupId;
  });
}

/**
 * Ungroups, or removes a frame but keeps its contents: the container is marked
 * dissolved and its children are left as they are. They stay on the canvas and in
 * the container's slot, and children added concurrently survive too (section 5.5).
 */
export function dissolve(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    const type = map.get("type");
    if (type !== GROUP_TYPE && type !== FRAME_TYPE)
      throw new Error("Only frames and groups can be dissolved");
    map.set("removed", "dissolve");
  });
}

/** Deletes elements. Their subtrees disappear with them; the records are kept. */
export function deleteElements(
  doc: Y.Doc,
  ids: readonly ElementId[],
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    for (const id of ids) elementMap(doc, id).set("removed", "delete");
  });
}

/** Undoes a delete or dissolve. */
export function restoreElement(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  transact(doc, options, () => elementMap(doc, id).set("removed", null));
}

// ---------------------------------------------------------------------------
// Stops and routes (section 6)
// ---------------------------------------------------------------------------

function stopMap(doc: Y.Doc, id: StopId): Y.Map<unknown> {
  const map = roots(doc).stops.get(id);
  if (!map) throw new Error(`No stop ${id}`);
  return map;
}

function routeMap(doc: Y.Doc, id: RouteId): Y.Map<unknown> {
  const map = roots(doc).routes.get(id);
  if (!map) throw new Error(`No route ${id}`);
  return map;
}

export function addStop(
  doc: Y.Doc,
  init: { id?: StopId; view: StopView; name?: string; notes?: TextRun[] },
  options?: OpOptions,
): StopId {
  const id = init.id ?? newId(options?.randomBytes);
  return transact(doc, options, () => {
    const map = new Y.Map<unknown>();
    roots(doc).stops.set(id, map);
    writeStop(map, {
      name: init.name ?? "",
      view: init.view,
      notes: { $y: "text", delta: init.notes ?? [] },
      visibility: {},
      transition: null,
      removed: false,
    });
    return id;
  });
}

export function setStopView(
  doc: Y.Doc,
  id: StopId,
  view: StopView,
  options?: OpOptions,
): void {
  transact(doc, options, () => stopMap(doc, id).set("view", cloneJson(view)));
}

export function renameStop(
  doc: Y.Doc,
  id: StopId,
  name: string,
  options?: OpOptions,
): void {
  transact(doc, options, () => stopMap(doc, id).set("name", name));
}

export function setStopTransition(
  doc: Y.Doc,
  id: StopId,
  transition: Json,
  options?: OpOptions,
): void {
  transact(doc, options, () => stopMap(doc, id).set("transition", cloneJson(transition)));
}

/** The stop's speaker notes, for editing in place. */
export function stopNotes(doc: Y.Doc, id: StopId): Y.Text {
  const notes = stopMap(doc, id).get("notes");
  if (!(notes instanceof Y.Text)) throw new Error(`Stop ${id} has no notes`);
  return notes;
}

/** Shows or hides an element on arrival at a stop; null clears the change. */
export function setVisibility(
  doc: Y.Doc,
  stop: StopId,
  element: ElementId,
  action: "show" | "hide" | null,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const visibility = stopMap(doc, stop).get("visibility") as Y.Map<unknown>;
    if (action === null) visibility.delete(element);
    else visibility.set(element, { action });
  });
}

/** Removes a stop. Route entries that visit it are skipped until it is restored. */
export function removeStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => stopMap(doc, id).set("removed", true));
}

export function restoreStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => stopMap(doc, id).set("removed", false));
}

export function addRoute(
  doc: Y.Doc,
  init: { id?: RouteId; name?: string } = {},
  options?: OpOptions,
): RouteId {
  const id = init.id ?? newId(options?.randomBytes);
  return transact(doc, options, () => {
    const routes = roots(doc).routes;
    const siblings = [...routes.entries()]
      .filter(([, m]) => m.get("removed") !== true)
      .map(([rid, m]) => ({ id: rid, order: String(m.get("order") ?? "") }));
    const map = new Y.Map<unknown>();
    routes.set(id, map);
    writeRoute(map, {
      name: init.name ?? "",
      order: keyAt(sortOrdered(siblings), siblings.length, options?.random),
      entries: {},
      removed: false,
    });
    return id;
  });
}

export function renameRoute(
  doc: Y.Doc,
  id: RouteId,
  name: string,
  options?: OpOptions,
): void {
  transact(doc, options, () => routeMap(doc, id).set("name", name));
}

export function removeRoute(doc: Y.Doc, id: RouteId, options?: OpOptions): void {
  transact(doc, options, () => routeMap(doc, id).set("removed", true));
}

function entryList(entries: Y.Map<unknown>, except?: RouteEntryId): Ordered[] {
  return sortOrdered(
    [...entries.entries()]
      .filter(([id]) => id !== except)
      .map(([id, e]) => ({ id, order: String((e as { order?: unknown }).order ?? "") })),
  );
}

/** Adds a visit to `stop` at `index` in the route (default: at the end). */
export function insertRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  stop: StopId,
  options?: OpOptions & { index?: number; id?: RouteEntryId },
): RouteEntryId {
  const id = options?.id ?? newId(options?.randomBytes);
  return transact(doc, options, () => {
    const entries = routeMap(doc, route).get("entries") as Y.Map<unknown>;
    const list = entryList(entries);
    entries.set(id, {
      stop,
      order: keyAt(list, options?.index ?? list.length, options?.random),
    });
    return id;
  });
}

/** Moves a route entry to `index` among the other entries. */
export function moveRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  entry: RouteEntryId,
  index: number,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const entries = routeMap(doc, route).get("entries") as Y.Map<unknown>;
    const current = entries.get(entry) as { stop: StopId } | undefined;
    if (!current) throw new Error(`No entry ${entry}`);
    entries.set(entry, {
      stop: current.stop,
      order: keyAt(entryList(entries, entry), index, options?.random),
    });
  });
}

export function removeRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  entry: RouteEntryId,
  options?: OpOptions,
): void {
  transact(doc, options, () =>
    (routeMap(doc, route).get("entries") as Y.Map<unknown>).delete(entry),
  );
}

// ---------------------------------------------------------------------------
// Assets (section 8)
// ---------------------------------------------------------------------------

/** Registers an asset's description. Adding the same asset twice changes nothing. */
export function addAsset(
  doc: Y.Doc,
  id: AssetId,
  info: AssetInfo,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const assets = roots(doc).assets;
    if (!assets.has(id)) assets.set(id, cloneJson(info));
  });
}
