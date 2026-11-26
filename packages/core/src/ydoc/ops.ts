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
// - Arguments are checked with the grammar's own readers before anything is
//   written, so an operation cannot write what a file could not hold; an invalid
//   argument throws InvalidDocumentError and changes nothing.
// - Operations never write revisions: the work tracker (track.ts) does, for any
//   local transaction, in a follow-up transaction that undo does not touch
//   (section 5.5).
// - Moves write only `pos`; container changes write only `parent`, `rebase` and
//   `order` (section 5.3).
// - Locking is an editor rule and is not checked here (section 5.6).
// - A document that needs a newer version of the format is not written to
//   (section 9.4).

import * as Y from "yjs";
import {
  ASSET_ID_PATTERN,
  ID_PATTERN,
  InvalidDocumentError,
  MAX_SHIFTS,
  checked,
  readAsset,
  readElement,
  readJson,
  readRoute,
  readRouteEntry,
  readStop,
  readValue,
  readView,
  readVisibilityChange,
  wellFormed,
} from "../model/grammar.ts";
import { newId, type RandomBytes } from "../model/ids.ts";
import {
  compareOrdered,
  keyAt,
  sortOrdered,
  type Ordered,
  type RandomSource,
} from "../model/order.ts";
import { Resolver, type Point } from "../model/resolve.ts";
import { isRemoved } from "../model/route.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  MIN_READER_VERSION,
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DataValue,
  type ElementData,
  type ElementId,
  type ElementTypeId,
  type ExtSlots,
  type Json,
  type JsonExt,
  type Rebase,
  type RouteEntryId,
  type RouteId,
  type Shift,
  type StopId,
  type StopView,
  type TextRun,
} from "../model/types.ts";
import { cloneJson, valueToY } from "./encode.ts";
import { NewerVersionError, ORIGIN, roots } from "./schema.ts";
import {
  marksOf,
  markToY,
  revisionOf,
  writeElement,
  writeRoute,
  writeStop,
  yLookup,
} from "./snapshot.ts";
import { noteWork, trackWork } from "./track.ts";

/** Options shared by all operations. */
export interface OpOptions {
  /** Transaction origin; defaults to ORIGIN.local. */
  origin?: unknown;
  /** Random numbers for order-key jitter (tests pass a seeded source). */
  random?: RandomSource;
  /** Random bytes for new ids and revisions. */
  randomBytes?: RandomBytes;
}

/** Throws if the document needs a newer version of the format than this code reads. */
export function assertWritable(doc: Y.Doc): void {
  const needed = roots(doc).meta.get("minReaderVersion");
  if (typeof needed === "number" && needed > SCHEMA_VERSION) {
    throw new NewerVersionError(needed, SCHEMA_VERSION);
  }
}

function prepare(doc: Y.Doc, options: OpOptions | undefined): void {
  trackWork(doc, options?.randomBytes);
  assertWritable(doc);
}

function transact<T>(doc: Y.Doc, options: OpOptions | undefined, fn: () => T): T {
  prepare(doc, options);
  let result!: T;
  doc.transact(() => {
    result = fn();
  }, options?.origin ?? ORIGIN.local);
  return result;
}

function createTransact(doc: Y.Doc, fn: () => void): void {
  doc.transact(fn, ORIGIN.create);
}

function invalid(what: string, message: string): never {
  throw new InvalidDocumentError(what, [`${what}: ${message}`]);
}

function checkId(id: unknown, what: string): asserts id is string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) invalid(what, "not a valid id");
}

function checkNumbers(what: string, ...values: number[]): void {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value))
      invalid(what, "must be a finite number");
  }
}

function checkText(what: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || wellFormed(value) !== value)
    invalid(what, "must be a well-formed string");
}

function marksMap(record: Y.Map<unknown>): Y.Map<unknown> {
  let marks = record.get("deleted");
  if (!(marks instanceof Y.Map)) {
    marks = new Y.Map<unknown>();
    record.set("deleted", marks);
  }
  return marks as Y.Map<unknown>;
}

function clearMarks(record: Y.Map<unknown>): void {
  const marks = record.get("deleted");
  if (marks instanceof Y.Map)
    for (const action of [...marks.keys()]) marks.delete(action);
}

function elementMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const map = roots(doc).elements.get(id);
  if (!(map instanceof Y.Map)) throw new Error(`No element ${id}`);
  return map;
}

function resolver(doc: Y.Doc): Resolver {
  return new Resolver(yLookup(doc));
}

/**
 * Children of a container that occupy a slot the user sees, back to front: live
 * children, and gone containers that still hold visible children.
 */
export function slotsOf(
  r: Resolver,
  parent: ElementId | null,
  except?: ElementId,
): Ordered[] {
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
  if (r.meta.size > 0) throw new Error("The document is already initialized");
  if (init.id !== undefined) checkId(init.id, "document id");
  if (init.title !== undefined) checkText("title", init.title);
  trackWork(doc, options?.randomBytes);
  doc.transact(() => {
    r.meta.set("schemaVersion", SCHEMA_VERSION);
    r.meta.set("minReaderVersion", MIN_READER_VERSION);
    r.meta.set("id", init.id ?? newId(options?.randomBytes));
    r.meta.set("title", init.title ?? "");
    r.meta.set("lineage", newId(options?.randomBytes));
  }, ORIGIN.create);
}

export function setTitle(doc: Y.Doc, title: string, options?: OpOptions): void {
  checkText("title", title);
  transact(doc, options, () => roots(doc).meta.set("title", title));
}

export function setSetting(
  doc: Y.Doc,
  key: string,
  value: Json,
  options?: OpOptions,
): void {
  checkText("setting key", key);
  const json = checked("setting", (p) => readJson(value, p, 3));
  transact(doc, options, () => roots(doc).settings.set(key, json));
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
  prepare(doc, options);
  const id = init.id ?? newId(options?.randomBytes);
  checkId(id, "element id");
  if (roots(doc).elements.has(id)) throw new Error(`Element ${id} exists already`);
  const parent = init.parent ?? null;
  const siblings = slotsOf(resolver(doc), parent);
  const action = newId(options?.randomBytes);
  const raw: Record<string, unknown> = {
    type: init.type,
    typeVersion: init.typeVersion ?? 1,
    parent,
    order: keyAt(siblings, init.index ?? siblings.length, options?.random),
    pos: { x: init.x, y: init.y, space: parent },
    rebase: null,
    name: init.name ?? "",
    locked: init.locked ?? false,
    rev: {},
    // Created removed (the creation itself is the removal that undo restores).
    deleted: { [action]: { seen: { [id]: {} } } },
    dissolved: false,
    refs: init.refs ?? [],
    ext: init.ext ?? {},
    data: init.data ?? {},
  };
  if (init.size !== undefined) raw.size = init.size;
  if (init.type !== GROUP_TYPE && init.type !== FRAME_TYPE) raw.rot = init.rot ?? 0;
  const element = checked("element", (p) => readElement(raw, p));
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    roots(doc).elements.set(id, map);
    writeElement(map, element);
  });
  transact(doc, options, () => marksMap(elementMap(doc, id)).delete(action));
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
  checkNumbers("position", x, y);
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    map.set("pos", { x, y, space: resolver(doc).parentOf(id) });
  });
}

function setKey(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: unknown,
  options?: OpOptions,
): void {
  transact(doc, options, () => elementMap(doc, id).set(key, value));
}

/** Sets the size. Groups have none; width and height are never negative. */
export function resizeElement(
  doc: Y.Doc,
  id: ElementId,
  w: number,
  h: number,
  options?: OpOptions,
): void {
  checkNumbers("size", w, h);
  if (w < 0 || h < 0) invalid("size", "width and height must not be negative");
  if (elementMap(doc, id).get("type") === GROUP_TYPE)
    invalid("size", "groups have no size");
  setKey(doc, id, "size", { w, h }, options);
}

/** Sets the rotation. Frames and groups do not rotate. */
export function rotateElement(
  doc: Y.Doc,
  id: ElementId,
  rot: number,
  options?: OpOptions,
): void {
  checkNumbers("rotation", rot);
  const type = elementMap(doc, id).get("type");
  if (type === GROUP_TYPE || type === FRAME_TYPE)
    invalid("rotation", "containers do not rotate");
  setKey(doc, id, "rot", rot, options);
}

export function renameElement(
  doc: Y.Doc,
  id: ElementId,
  name: string,
  options?: OpOptions,
): void {
  checkText("name", name);
  setKey(doc, id, "name", name, options);
}

export function setLocked(
  doc: Y.Doc,
  id: ElementId,
  locked: boolean,
  options?: OpOptions,
): void {
  setKey(doc, id, "locked", locked === true, options);
}

/** Sets the ids of elements and stops that the element's data refers to. */
export function setRefs(
  doc: Y.Doc,
  id: ElementId,
  refs: string[],
  options?: OpOptions,
): void {
  for (const ref of refs) checkId(ref, "reference");
  setKey(doc, id, "refs", [...refs], options);
}

/** Nesting level of a value directly in a data or ext map of a record. */
const VALUE_LEVEL = 5;

/** Replaces one key of the element's data with a new value. */
export function setData(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: DataValue,
  options?: OpOptions,
): void {
  checkText("data key", key);
  const read = checked("value", (p) => readValue(value, p, VALUE_LEVEL));
  transact(doc, options, () => dataMap(doc, id).set(key, valueToY(read)));
}

/** Replaces one key of the element's ext slots. */
export function setExt(
  doc: Y.Doc,
  id: ElementId,
  key: string,
  value: DataValue,
  options?: OpOptions,
): void {
  checkText("ext key", key);
  const read = checked("value", (p) => readValue(value, p, VALUE_LEVEL));
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    let ext = map.get("ext");
    if (!(ext instanceof Y.Map)) map.set("ext", (ext = new Y.Map<unknown>()));
    (ext as Y.Map<unknown>).set(key, valueToY(read));
  });
}

/** The element's data map, for editing shared types (text, arrays) in place. */
export function dataMap(doc: Y.Doc, id: ElementId): Y.Map<unknown> {
  const data = elementMap(doc, id).get("data");
  if (!(data instanceof Y.Map)) throw new Error(`Element ${id} has no data map`);
  return data;
}

/**
 * Runs `fn` in one local transaction, for in-place edits of shared types (text,
 * arrays, maps inside data). The records changed need not be listed: the work
 * tracker finds them. Editor bindings that run their own transactions are
 * covered in the same way.
 */
export function edit(doc: Y.Doc, fn: () => void, options?: OpOptions): void {
  transact(doc, options, fn);
}

// ---------------------------------------------------------------------------
// Containers (section 5)
// ---------------------------------------------------------------------------

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
): void {
  const envelope = r.get(id);
  if (!envelope) throw new Error(`No element ${id}`);
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
    const siblings = slotsOf(r, target, id);
    const map = elementMap(doc, id);
    place(map, r, id, target);
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
    const all = slotsOf(r, logical);
    if (!all.some((s) => s.id === holder))
      all.push({ id: holder, order: r.get(holder)?.order ?? "" });
    all.sort(compareOrdered);
    const current = all.findIndex((s) => s.id === holder);
    const inGone = holder !== id;
    const others = inGone ? all : all.filter((s) => s.id !== id);
    const index = target(others.length, current, inGone);
    if (!inGone && index === current) return;
    const map = elementMap(doc, id);
    if (r.parentOf(id) !== logical) place(map, r, id, logical);
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
  prepare(doc, options);
  const groupId = options?.id ?? newId(options?.randomBytes);
  checkId(groupId, "group id");
  if (roots(doc).elements.has(groupId))
    throw new Error(`Element ${groupId} exists already`);
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
  const all = slotsOf(r, logical);
  const front = sortOrdered(all.filter((s) => holders.has(s.id))).pop();
  const others = all.filter((s) => !ids.includes(s.id));
  const index = front
    ? others.filter((s) => compareOrdered(s, front) <= 0).length
    : others.length;
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
      rev: {},
      deleted: {},
      dissolved: true,
      refs: [],
      ext: {},
      data: {},
    });
  });
  transact(doc, options, () => {
    elementMap(doc, groupId).set("dissolved", false);
    const withGroup = resolver(doc);
    for (const id of ids) place(elementMap(doc, id), withGroup, id, groupId);
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
 * Deletes elements (section 5.5). Each gets a delete mark that lists what this
 * replica sees: the element and everything inside it, with their revisions.
 * Anything worked on or added concurrently, without knowing about the delete,
 * survives. Elements that are already gone are skipped.
 */
export function deleteElements(
  doc: Y.Doc,
  ids: readonly ElementId[],
  options?: OpOptions,
): void {
  transact(doc, options, () => {
    const r = resolver(doc);
    for (const root of new Set(ids)) {
      const map = roots(doc).elements.get(root);
      if (!(map instanceof Y.Map) || !r.get(root) || r.isGone(root)) continue;
      marksMap(map).set(newId(options?.randomBytes), markToY(r.coverage(root)));
    }
  });
}

/**
 * Undoes every delete of this element itself, and a dissolve. Deletes of
 * containers above it are not touched: `Resolver.deleters` tells which elements
 * to restore to bring something back.
 */
export function restoreElement(doc: Y.Doc, id: ElementId, options?: OpOptions): void {
  transact(doc, options, () => {
    const map = elementMap(doc, id);
    clearMarks(map);
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
  prepare(doc, options);
  const id = init.id ?? newId(options?.randomBytes);
  checkId(id, "stop id");
  if (roots(doc).stops.has(id)) throw new Error(`Stop ${id} exists already`);
  const action = newId(options?.randomBytes);
  const stop = checked("stop", (p) =>
    readStop(
      {
        name: init.name ?? "",
        view: init.view,
        notes: { $y: "text", delta: init.notes ?? [] },
        visibility: {},
        transition: null,
        rev: {},
        deleted: { [action]: { seen: { [id]: {} } } },
        ext: {},
      },
      p,
    ),
  );
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    roots(doc).stops.set(id, map);
    writeStop(map, stop);
  });
  transact(doc, options, () => marksMap(stopMap(doc, id)).delete(action));
  return id;
}

function setStopKey(
  doc: Y.Doc,
  id: StopId,
  key: string,
  value: unknown,
  options?: OpOptions,
): void {
  transact(doc, options, () => stopMap(doc, id).set(key, value));
}

export function setStopView(
  doc: Y.Doc,
  id: StopId,
  view: StopView,
  options?: OpOptions,
): void {
  const read = checked("view", (p) => readView(view, p));
  setStopKey(doc, id, "view", cloneJson(read), options);
}

export function renameStop(
  doc: Y.Doc,
  id: StopId,
  name: string,
  options?: OpOptions,
): void {
  checkText("name", name);
  setStopKey(doc, id, "name", name, options);
}

export function setStopTransition(
  doc: Y.Doc,
  id: StopId,
  transition: Json,
  options?: OpOptions,
): void {
  const read = checked("transition", (p) => readJson(transition, p, 4));
  setStopKey(doc, id, "transition", read, options);
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
  options?: OpOptions & { ext?: JsonExt },
): void {
  checkId(element, "element id");
  const change =
    action === null
      ? null
      : checked("visibility", (p) =>
          readVisibilityChange(
            options?.ext ? { action, ext: options.ext } : { action },
            p,
          ),
        );
  transact(doc, options, () => {
    const map = stopMap(doc, stop);
    let visibility = map.get("visibility");
    if (!(visibility instanceof Y.Map)) {
      map.set("visibility", (visibility = new Y.Map<unknown>()));
    }
    if (change === null) (visibility as Y.Map<unknown>).delete(element);
    else (visibility as Y.Map<unknown>).set(element, cloneJson(change));
  });
}

function removeRecord(id: string, map: Y.Map<unknown>, options?: OpOptions): void {
  const rev = revisionOf(map);
  if (isRemoved(id, { rev, deleted: marksOf(map) })) return;
  marksMap(map).set(newId(options?.randomBytes), markToY({ [id]: rev }));
}

/**
 * Removes a stop. Work on the stop that the remover did not see, such as adding
 * a visit to it, cancels the removal (section 5.5).
 */
export function removeStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => removeRecord(id, stopMap(doc, id), options));
}

export function restoreStop(doc: Y.Doc, id: StopId, options?: OpOptions): void {
  transact(doc, options, () => clearMarks(stopMap(doc, id)));
}

export function addRoute(
  doc: Y.Doc,
  init: { id?: RouteId; name?: string } = {},
  options?: OpOptions,
): RouteId {
  prepare(doc, options);
  const id = init.id ?? newId(options?.randomBytes);
  checkId(id, "route id");
  const routes = roots(doc).routes;
  if (routes.has(id)) throw new Error(`Route ${id} exists already`);
  const siblings: Ordered[] = [];
  for (const [routeId, map] of routes.entries()) {
    if (!(map instanceof Y.Map)) continue;
    if (isRemoved(routeId, { rev: revisionOf(map), deleted: marksOf(map) })) continue;
    const order = map.get("order");
    siblings.push({ id: routeId, order: typeof order === "string" ? order : "" });
  }
  const action = newId(options?.randomBytes);
  const route = checked("route", (p) =>
    readRoute(
      {
        name: init.name ?? "",
        order: keyAt(sortOrdered(siblings), siblings.length, options?.random),
        entries: {},
        rev: {},
        deleted: { [action]: { seen: { [id]: {} } } },
        ext: {},
      },
      p,
    ),
  );
  createTransact(doc, () => {
    const map = new Y.Map<unknown>();
    routes.set(id, map);
    writeRoute(map, route);
  });
  transact(doc, options, () => marksMap(routeMap(doc, id)).delete(action));
  return id;
}

export function renameRoute(
  doc: Y.Doc,
  id: RouteId,
  name: string,
  options?: OpOptions,
): void {
  checkText("name", name);
  transact(doc, options, () => routeMap(doc, id).set("name", name));
}

export function removeRoute(doc: Y.Doc, id: RouteId, options?: OpOptions): void {
  transact(doc, options, () => removeRecord(id, routeMap(doc, id), options));
}

export function restoreRoute(doc: Y.Doc, id: RouteId, options?: OpOptions): void {
  transact(doc, options, () => clearMarks(routeMap(doc, id)));
}

function entriesMap(route: Y.Map<unknown>): Y.Map<unknown> {
  let entries = route.get("entries");
  if (!(entries instanceof Y.Map)) route.set("entries", (entries = new Y.Map<unknown>()));
  return entries as Y.Map<unknown>;
}

function entryList(entries: Y.Map<unknown>, except?: RouteEntryId): Ordered[] {
  return sortOrdered(
    [...entries.entries()]
      .filter(([id]) => id !== except)
      .map(([id, e]) => {
        const order = (e as { order?: unknown } | null)?.order;
        return { id, order: typeof order === "string" ? order : "" };
      }),
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
  options?: OpOptions & { index?: number; id?: RouteEntryId; ext?: JsonExt },
): RouteEntryId {
  const id = options?.id ?? newId(options?.randomBytes);
  checkId(id, "route entry id");
  checkId(stop, "stop id");
  return transact(doc, options, () => {
    const entries = entriesMap(routeMap(doc, route));
    const list = entryList(entries);
    const raw: Record<string, unknown> = {
      stop,
      order: keyAt(list, options?.index ?? list.length, options?.random),
    };
    if (options?.ext) raw.ext = options.ext;
    entries.set(id, cloneJson(checked("route entry", (p) => readRouteEntry(raw, p))));
    const stopRecord = roots(doc).stops.get(stop);
    if (stopRecord instanceof Y.Map) noteWork(doc, stopRecord);
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
    const entries = entriesMap(routeMap(doc, route));
    const current = entries.get(entry);
    if (current === undefined) throw new Error(`No entry ${entry}`);
    const read = checked("route entry", (p) => readRouteEntry(current, p));
    entries.set(
      entry,
      cloneJson({
        ...read,
        order: keyAt(entryList(entries, entry), index, options?.random),
      }),
    );
  });
}

export function removeRouteEntry(
  doc: Y.Doc,
  route: RouteId,
  entry: RouteEntryId,
  options?: OpOptions,
): void {
  transact(doc, options, () => entriesMap(routeMap(doc, route)).delete(entry));
}

// ---------------------------------------------------------------------------
// Assets (section 8)
// ---------------------------------------------------------------------------

/**
 * Registers an asset's description. Adding the same asset twice changes nothing.
 * Not undoable: descriptions are immutable and harmless.
 */
export function addAsset(doc: Y.Doc, id: AssetId, info: AssetInfo): void {
  if (!ASSET_ID_PATTERN.test(id)) invalid("asset id", "not an asset id");
  const read = checked("asset", (p) => readAsset(info, p));
  assertWritable(doc);
  doc.transact(() => {
    const assets = roots(doc).assets;
    if (!assets.has(id)) assets.set(id, cloneJson(read));
  }, ORIGIN.create);
}
