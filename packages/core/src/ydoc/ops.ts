// SPDX-License-Identifier: GPL-3.0-or-later

// Reference operations on a Galatsa Y.Doc: the writes each user action makes, as
// specified in sections 4 to 6 and 10 of
// docs/adr/0001-document-model-and-file-format.md. The command layer (with undo)
// is built on top of these.
//
// Rules every operation follows:
// - Each runs in one transaction (origin ORIGIN.local unless given), except that
//   creating a record takes two: the record is created already removed, in an
//   untracked transaction, then restored in the local one. Undo of a creation is
//   therefore a soft removal, never a hard delete (section 10).
// - Every change of a record writes a fresh `rev` (section 5.5); removals do not.
// - Moves write only `pos`; container changes write only `parent`, `rebase` and
//   `order` (section 5.3).
// - Locking is an editor rule and is not checked here (section 5.6).

import * as Y from "yjs";
import { newId, type RandomBytes } from "../model/ids.ts";
import {
  compareOrdered,
  keyAt,
  sortOrdered,
  type Ordered,
  type RandomSource,
} from "../model/order.ts";
import { Resolver, type Point } from "../model/resolve.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  MIN_READER_VERSION,
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DataValue,
  type Element,
  type ElementData,
  type ElementId,
  type ElementTypeId,
  type ExtSlots,
  type Json,
  type Rebase,
  type RouteEntryId,
  type RouteId,
  type Shift,
  type StopId,
  type StopView,
  type TextRun,
} from "../model/types.ts";
import { cloneJson, dataValueToY } from "./encode.ts";
import { ORIGIN, roots } from "./schema.ts";
import {
  readEnvelope,
  writeElement,
  writeRoute,
  writeStop,
  yLookup,
} from "./snapshot.ts";

/** Options shared by all operations. */
export interface OpOptions {
  /** Transaction origin; defaults to ORIGIN.local. */
  origin?: unknown;
  /** Random numbers for order-key jitter (tests pass a seeded source). */
  random?: RandomSource;
  /** Random bytes for new ids and revisions. */
  randomBytes?: RandomBytes;
}

function transact<T>(doc: Y.Doc, options: OpOptions | undefined, fn: () => T): T {
  let result!: T;
  doc.transact(() => {
    result = fn();
  }, options?.origin ?? ORIGIN.local);
  return result;
}

function createTransact(doc: Y.Doc, fn: () => void): void {
  doc.transact(fn, ORIGIN.create);
}

function elementMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const map = roots(doc).elements.get(id);
  if (!(map instanceof Y.Map)) throw new Error(`No element ${id}`);
  return map;
}

function resolver(doc: Y.Doc): Resolver {
  return new Resolver(yLookup(doc));
}

function freshRev(options?: OpOptions): string {
  return newId(options?.randomBytes);
}

/** Records a change of a record (section 5.5). */
function touch(map: Y.Map<unknown>, options?: OpOptions): void {
  map.set("rev", freshRev(options));
}

/**
 * Children of a container that occupy a slot the user sees, back to front: live
 * children, and gone containers that still hold visible children.
 */
function slots(r: Resolver, parent: ElementId | null, except?: ElementId): Ordered[] {
  return r
    .children(parent)
    .filter(
      (id) =>
        id !== except &&
        (!r.isGone(id) || (r.isContainer(id) && r.logicalChildren(id).length > 0)),
    )
    .map((id) => ({ id, order: r.get(id)?.order ?? "" }));
}

/** Creates a new, empty document with a fresh lineage. */
export function initDocument(
  doc: Y.Doc,
  init: { id?: string; title?: string } = {},
  options?: OpOptions,
): void {
  const r = roots(doc);
  doc.transact(() => {
    r.meta.set("schemaVersion", SCHEMA_VERSION);
    r.meta.set("minReaderVersion", MIN_READER_VERSION);
    r.meta.set("id", init.id ?? newId(options?.randomBytes));
    r.meta.set("title", init.title ?? "");
    r.meta.set("lineage", newId(options?.randomBytes));
  }, ORIGIN.create);
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
  refs?: string[];
  ext?: ExtSlots;
  data?: ElementData;
  /** Stacking index among the parent's slots; default: in front. */
  index?: number;
}

/** Adds an element and returns its id. */
export function addElement(doc: Y.Doc, init: NewElement, options?: OpOptions): ElementId {
  const id = init.id ?? newId(options?.randomBytes);
  const parent = init.parent ?? null;
  const r = resolver(doc);
  const siblings = slots(r, parent);
  const rev = freshRev(options);
  const base = {
    type: init.type,
    typeVersion: init.typeVersion ?? 1,
    parent,
    order: keyAt(siblings, init.index ?? siblings.length, options?.random),
    pos: { x: init.x, y: init.y, space: parent },
    rebase: null,
    name: init.name ?? "",
    locked: init.locked ?? false,
    rev,
    deleted: { action: newId(options?.randomBytes), root: id, rev },
    dissolved: false,
    refs: init.refs ?? [],
    ext: init.ext ?? {},
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
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    roots(doc).elements.set(id, map);
    writeElement(map, element);
  });
  transact(doc, options, () => elementMap(doc, id).set("deleted", null));
  return id;
}

/**
 * Moves an element within its parent: writes the position, tagged with the
 * effective parent. Never writes `parent` or `rebase`, so it cannot overwrite a
 * concurrent reparent, and it never "repairs" a parent that has not arrived yet.
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
    map.set("pos", { x, y, space: resolver(doc).parentOf(id) });
    touch(map, options);
  });
}

function setKey(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: unknown,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    map.set(key, value);
    touch(map, options);
  });
}

export function resizeElement(
  doc: Y.Doc,
  id: ElementId,
  w: number,
  h: number,
  options?: OpOptions,
): void {
  setKey(doc, id, "size", { w, h }, options);
}

export function rotateElement(
  doc: Y.Doc,
  id: ElementId,
  rot: number,
  options?: OpOptions,
): void {
  setKey(doc, id, "rot", rot, options);
}

export function renameElement(
  doc: Y.Doc,
  id: ElementId,
  name: string,
  options?: OpOptions,
): void {
  setKey(doc, id, "name", name, options);
}

export function setLocked(
  doc: Y.Doc,
  id: ElementId,
  locked: boolean,
  options?: OpOptions,
): void {
  setKey(doc, id, "locked", locked, options);
}

/** Sets the ids of elements and stops that the element's data refers to. */
export function setRefs(
  doc: Y.Doc,
  id: ElementId,
  refs: string[],
  options?: OpOptions,
): void {
  setKey(doc, id, "refs", [...refs], options);
}

/** Replaces one key of the element's data with a new value. */
export function setData(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: DataValue,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    dataMap(doc, id).set(key, dataValueToY(value));
    touch(elementMap(doc, id), options);
  });
}

/** Replaces one key of the element's ext slots. */
export function setExt(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: DataValue,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    (map.get("ext") as Y.Map<unknown>).set(key, dataValueToY(value));
    touch(map, options);
  });
}

/** The element's data map, for editing shared types (text, arrays) in place. */
export function dataMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const data = elementMap(doc, id).get("data");
  if (!(data instanceof Y.Map)) throw new Error(`Element ${id} has no data map`);
  return data;
}

/**
 * Runs `fn` in one local transaction, for in-place edits of shared types. Every
 * element or stop changed must be listed in `touch`, so that a concurrent delete
 * knows it was worked on (section 5.5).
 */
export function edit(
  doc: Y.Doc,
  fn: () => void,
  options?: OpOptions & { touch?: readonly string[] },
): void {
  transact(doc, options, () => {
    fn();
    const r = roots(doc);
    for (const id of options?.touch ?? []) {
      const map = r.elements.get(id) ?? r.stops.get(id) ?? r.routes.get(id);
      if (map instanceof Y.Map) touch(map, options);
    }
  });
}

// ---------------------------------------------------------------------------
// Containers (section 5)
// ---------------------------------------------------------------------------

const MAX_SHIFTS = 64;

/**
 * Puts an element into container `target` without moving it on the canvas
 * (section 5.3). Writes `parent` and a rebase, never `pos`: the rebase holds a
 * shift for the space the stored position was written in, for the current
 * parent, and for every space an earlier pending rebase covered, so a concurrent
 * move written in any of them lands where its author put it.
 */
function place(
  map: Y.Map<unknown>,
  r: Resolver,
  id: ElementId,
  target: ElementId | null,
  options?: OpOptions,
): void {
  const envelope = r.get(id)!;
  const parent = r.parentOf(id);
  const local = r.localPosition(id);
  const d = r.offset(parent, target);
  const next: Point = { x: local.x + d.x, y: local.y + d.y };
  const pos = envelope.pos;
  const shifts: Shift[] = [];
  const add = (from: ElementId | null, dx: number, dy: number) => {
    if (from === target || shifts.some((s) => s.from === from)) return;
    if (shifts.length < MAX_SHIFTS) shifts.push({ from, dx, dy });
  };
  add(pos.space, next.x - pos.x, next.y - pos.y);
  add(parent, d.x, d.y);
  const old = envelope.rebase;
  if (old && old.to === parent) {
    for (const s of old.shifts) add(s.from, s.dx + d.x, s.dy + d.y);
  }
  const rebase: Rebase = {
    to: target,
    base:
      pos.space === target
        ? { x: pos.x, y: pos.y, dx: next.x - pos.x, dy: next.y - pos.y }
        : null,
    shifts,
  };
  map.set("parent", target);
  map.set("rebase", rebase);
  touch(map, options);
}

function checkTarget(r: Resolver, id: ElementId, target: ElementId | null): void {
  if (target === null) return;
  if (!r.isContainer(target)) throw new Error(`${target} is not a frame or group`);
  if (r.isGone(target)) throw new Error(`${target} has been removed`);
  if (r.isWithin(target, id)) throw new Error("An element cannot be moved into itself");
}

/**
 * Moves an element into another container (or the root) without moving it on the
 * canvas: writes the parent, a rebase and the order key. A drag that ends in
 * another container is this operation followed by moveElement, in one command.
 */
export function reparent(
  doc: Y.Doc,
  id: ElementId,
  target: ElementId | null,
  options?: OpOptions & { index?: number },
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    checkTarget(r, id, target);
    const siblings = slots(r, target, id);
    const map = elementMap(doc, id);
    place(map, r, id, target, options);
    map.set("order", keyAt(siblings, options?.index ?? siblings.length, options?.random));
  });
}

/**
 * Restacks an element among the slots of the container the user sees it in
 * (section 4.2). If it sits inside a gone (deleted or dissolved) container, it is
 * first moved out into the visible container, so it can pass its new siblings.
 */
function restack(
  doc: Y.Doc,
  id: ElementId,
  target: (others: number, current: number, inGone: boolean) => number,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    const logical = r.logicalParentOf(id);
    const holder = r.slotIn(id, logical) ?? id;
    const all = slots(r, logical);
    if (!all.some((s) => s.id === holder))
      all.push({ id: holder, order: r.get(holder)?.order ?? "" });
    all.sort(compareOrdered);
    const current = all.findIndex((s) => s.id === holder);
    const inGone = holder !== id;
    const others = inGone ? all : all.filter((s) => s.id !== id);
    const index = target(others.length, current, inGone);
    if (!inGone && index === current) return;
    const map = elementMap(doc, id);
    if (r.parentOf(id) !== logical) place(map, r, id, logical, options);
    else touch(map, options);
    map.set("order", keyAt(others, index, options?.random));
  });
}

export function bringToFront(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, (n) => n, options);
}

export function sendToBack(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(doc, id, () => 0, options);
}

/** One step forward: past the slot directly in front. */
export function bringForward(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(
    doc,
    id,
    (n, current, inGone) => (inGone ? current + 1 : Math.min(current + 1, n)),
    options,
  );
}

/** One step backward: behind the slot directly behind. */
export function sendBackward(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  restack(
    doc,
    id,
    (_n, current, inGone) => (inGone ? current : Math.max(current - 1, 0)),
    options,
  );
}

/**
 * Groups elements the user sees in the same container. The group takes the
 * frontmost member's slot; members keep their order keys, now among each other.
 * The group's origin is the top-left corner of their bounds; members get a rebase
 * into the group rather than rewritten positions (section 5.4). Undo dissolves
 * the group (it was created dissolved and restored).
 */
export function group(
  doc: Y.Doc,
  ids: readonly ElementId[],
  options?: OpOptions & { id?: ElementId },
): ElementId {
  if (ids.length === 0) throw new Error("Nothing to group");
  const groupId = options?.id ?? newId(options?.randomBytes);
  const r = resolver(doc);
  const logical = r.logicalParentOf(ids[0]!);
  if (ids.some((id) => r.logicalParentOf(id) !== logical || r.isGone(id))) {
    throw new Error("Grouped elements must be visible in the same container");
  }
  let minX = Infinity;
  let minY = Infinity;
  for (const id of ids) {
    const b = r.boundsIn(id, logical) ?? { ...r.positionIn(id, logical), w: 0, h: 0 };
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  // The group goes just in front of the frontmost member's slot.
  const holders = new Set(ids.map((id) => r.slotIn(id, logical) ?? id));
  const all = slots(r, logical);
  const front = sortOrdered(all.filter((s) => holders.has(s.id))).pop();
  const others = all.filter((s) => !ids.includes(s.id));
  const index = front
    ? others.filter((s) => compareOrdered(s, front) <= 0).length
    : others.length;
  const rev = freshRev(options);
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    roots(doc).elements.set(groupId, map);
    writeElement(map, {
      type: GROUP_TYPE,
      typeVersion: 1,
      parent: logical,
      order: keyAt(others, index, options?.random),
      pos: { x: minX, y: minY, space: logical },
      rebase: null,
      name: "",
      locked: false,
      rev,
      deleted: null,
      dissolved: true,
      refs: [],
      ext: {},
      data: {},
    });
  });
  transact(doc, options, () => {
    elementMap(doc, groupId).set("dissolved", false);
    const withGroup = resolver(doc);
    for (const id of ids) place(elementMap(doc, id), withGroup, id, groupId, options);
  });
  return groupId;
}

/**
 * Ungroups, or removes a frame but keeps its contents: the container is marked
 * dissolved and its children are left as they are. They stay on the canvas and in
 * the container's slot, and children added concurrently survive (section 5.5).
 * A dissolve beats a concurrent delete of the same container.
 */
export function dissolve(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    const type = map.get("type");
    if (type !== GROUP_TYPE && type !== FRAME_TYPE) {
      throw new Error("Only frames and groups can be dissolved");
    }
    map.set("dissolved", true);
  });
}

/**
 * Deletes elements (section 5.5). Each gets a delete mark, and so does every
 * descendant this replica sees, all with the same action id and each with its own
 * current revision. Anything changed or added concurrently survives.
 */
export function deleteElements(
  doc: Y.Doc,
  ids: readonly ElementId[],
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    for (const root of ids) {
      if (!roots(doc).elements.has(root)) continue;
      const action = newId(options?.randomBytes);
      const visit = (id: ElementId): void => {
        const map = elementMap(doc, id);
        if (id === root || !r.isDeleted(id)) {
          map.set("deleted", { action, root, rev: readEnvelope(map).rev ?? "" });
        }
        for (const child of r.children(id)) visit(child);
      };
      visit(root);
    }
  });
}

/** Undoes a delete or dissolve of this element (and so of what the delete covered). */
export function restoreElement(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    map.set("deleted", null);
    if (map.get("dissolved") === true) map.set("dissolved", false);
  });
}

// ---------------------------------------------------------------------------
// Stops and routes (section 6)
// ---------------------------------------------------------------------------

function stopMap(doc: Y.Doc, id: StopId): Y.Map<unknown> {
  const map = roots(doc).stops.get(id);
  if (!(map instanceof Y.Map)) throw new Error(`No stop ${id}`);
  return map;
}

function routeMap(doc: Y.Doc, id: RouteId): Y.Map<unknown> {
  const map = roots(doc).routes.get(id);
  if (!(map instanceof Y.Map)) throw new Error(`No route ${id}`);
  return map;
}

export function addStop(
  doc: Y.Doc,
  init: { id?: StopId; view: StopView; name?: string; notes?: TextRun[] },
  options?: OpOptions,
): StopId {
  const id = init.id ?? newId(options?.randomBytes);
  const rev = freshRev(options);
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    roots(doc).stops.set(id, map);
    writeStop(map, {
      name: init.name ?? "",
      view: init.view,
      notes: { $y: "text", delta: init.notes ?? [] },
      visibility: {},
      transition: null,
      rev,
      removed: { rev },
      ext: {},
    });
  });
  transact(doc, options, () => stopMap(doc, id).set("removed", null));
  return id;
}

function setStopKey(
  doc: Y.Doc,
  id: StopId,
  key: string,
  value: unknown,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = stopMap(doc, id);
    map.set(key, value);
    touch(map, options);
  });
}

export function setStopView(
  doc: Y.Doc,
  id: StopId,
  view: StopView,
  options?: OpOptions,
): void {
  setStopKey(doc, id, "view", cloneJson(view), options);
}

export function renameStop(
  doc: Y.Doc,
  id: StopId,
  name: string,
  options?: OpOptions,
): void {
  setStopKey(doc, id, "name", name, options);
}

export function setStopTransition(
  doc: Y.Doc,
  id: StopId,
  transition: Json,
  options?: OpOptions,
): void {
  setStopKey(doc, id, "transition", cloneJson(transition), options);
}

/** The stop's speaker notes, for editing in place (with `edit` and `touch: [stop]`). */
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
    const map = stopMap(doc, stop);
    const visibility = map.get("visibility") as Y.Map<unknown>;
    if (action === null) visibility.delete(element);
    else visibility.set(element, { action });
    touch(map, options);
  });
}

/** Removes a stop. Concurrent changes of the stop cancel the removal (section 5.5). */
export function removeStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = stopMap(doc, id);
    map.set("removed", { rev: String(map.get("rev") ?? "") });
  });
}

export function restoreStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => stopMap(doc, id).set("removed", null));
}

export function addRoute(
  doc: Y.Doc,
  init: { id?: RouteId; name?: string } = {},
  options?: OpOptions,
): RouteId {
  const id = init.id ?? newId(options?.randomBytes);
  const routes = roots(doc).routes;
  const siblings = [...routes.entries()]
    .filter(([, m]) => m instanceof Y.Map && m.get("removed") === null)
    .map(([rid, m]) => ({ id: rid, order: String(m.get("order") ?? "") }));
  const rev = freshRev(options);
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    routes.set(id, map);
    writeRoute(map, {
      name: init.name ?? "",
      order: keyAt(sortOrdered(siblings), siblings.length, options?.random),
      entries: {},
      rev,
      removed: { rev },
      ext: {},
    });
  });
  transact(doc, options, () => routeMap(doc, id).set("removed", null));
  return id;
}

export function renameRoute(
  doc: Y.Doc,
  id: RouteId,
  name: string,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = routeMap(doc, id);
    map.set("name", name);
    touch(map, options);
  });
}

export function removeRoute(doc: Y.Doc, id: RouteId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = routeMap(doc, id);
    map.set("removed", { rev: String(map.get("rev") ?? "") });
  });
}

export function restoreRoute(doc: Y.Doc, id: RouteId, options?: OpOptions): void {
  transact(doc, options, () => routeMap(doc, id).set("removed", null));
}

function entryList(entries: Y.Map<unknown>, except?: RouteEntryId): Ordered[] {
  return sortOrdered(
    [...entries.entries()]
      .filter(([id]) => id !== except)
      .map(([id, e]) => ({ id, order: String((e as { order?: unknown }).order ?? "") })),
  );
}

/**
 * Adds a visit to `stop` at `index` in the route (default: at the end). This is
 * work on both the route and the stop, so it cancels a concurrent removal of
 * either (section 5.5).
 */
export function insertRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  stop: StopId,
  options?: OpOptions & { index?: number; id?: RouteEntryId },
): RouteEntryId {
  const id = options?.id ?? newId(options?.randomBytes);
  return transact(doc, options, () => {
    const map = routeMap(doc, route);
    const entries = map.get("entries") as Y.Map<unknown>;
    const list = entryList(entries);
    entries.set(id, {
      stop,
      order: keyAt(list, options?.index ?? list.length, options?.random),
    });
    touch(map, options);
    const stopRecord = roots(doc).stops.get(stop);
    if (stopRecord instanceof Y.Map) touch(stopRecord, options);
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
    const map = routeMap(doc, route);
    const entries = map.get("entries") as Y.Map<unknown>;
    const current = entries.get(entry) as { stop: StopId } | undefined;
    if (!current) throw new Error(`No entry ${entry}`);
    entries.set(entry, {
      stop: current.stop,
      order: keyAt(entryList(entries, entry), index, options?.random),
    });
    touch(map, options);
  });
}

export function removeRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  entry: RouteEntryId,
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const map = routeMap(doc, route);
    (map.get("entries") as Y.Map<unknown>).delete(entry);
    touch(map, options);
  });
}

// ---------------------------------------------------------------------------
// Assets (section 8)
// ---------------------------------------------------------------------------

/**
 * Registers an asset's description. Adding the same asset twice changes nothing.
 * Not undoable: descriptions are immutable and harmless.
 */
export function addAsset(doc: Y.Doc, id: AssetId, info: AssetInfo): void {
  doc.transact(() => {
    const assets = roots(doc).assets;
    if (!assets.has(id)) assets.set(id, cloneJson(info));
  }, ORIGIN.create);
}
