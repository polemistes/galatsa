// SPDX-License-Identifier: GPL-3.0-or-later

// Conversion between a Y.Doc and the JSON form (DocumentSnapshot), and read
// access to elements straight from the Y.Doc. Section 2 of
// docs/adr/0001-document-model-and-file-format.md. Reading never throws.

import * as Y from "yjs";
import { newId, type RandomBytes } from "../model/ids.ts";
import { DEFAULT_ORDER_KEY, isValidOrderKey } from "../model/order.ts";
import type { ElementEnvelope, ElementLookup } from "../model/resolve.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  MIN_READER_VERSION,
  SCHEMA_VERSION,
  setOwn,
  type AssetId,
  type AssetInfo,
  type DeleteMark,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type ElementId,
  type Json,
  type JsonObject,
  type Position,
  type Rebase,
  type RemovalMark,
  type Route,
  type RouteEntry,
  type Shift,
  type Size,
  type Stop,
  type StopView,
  type VisibilityChange,
} from "../model/types.ts";
import {
  cloneJson,
  dataValueFromY,
  dataValueToY,
  isJson,
  textFromY,
  textToY,
} from "./encode.ts";
import {
  ELEMENT_KEYS,
  META_KEYS,
  ORIGIN,
  ROOT_NAMES,
  ROUTE_KEYS,
  STOP_KEYS,
  roots,
} from "./schema.ts";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function idOrNull(value: unknown): ElementId | null {
  return typeof value === "string" ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Order keys and revisions can be missing after an undo that races a remote
 * change, or invalid when written by a faulty peer. Every reader substitutes the
 * same defaults, so all replicas and the JSON form agree (section 4.1).
 */
function orderKey(value: unknown): string {
  return typeof value === "string" && isValidOrderKey(value) ? value : DEFAULT_ORDER_KEY;
}

function revision(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : "0";
}

function readPos(value: unknown): Position {
  const v = obj(value);
  return { x: num(v.x), y: num(v.y), space: idOrNull(v.space) };
}

function readRebase(value: unknown): Rebase | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const base = obj(v.base);
  const shifts: Shift[] = Array.isArray(v.shifts)
    ? v.shifts.map((s) => {
        const o = obj(s);
        return { from: idOrNull(o.from), dx: num(o.dx), dy: num(o.dy) };
      })
    : [];
  return {
    to: idOrNull(v.to),
    base:
      typeof v.base === "object" && v.base !== null
        ? { x: num(base.x), y: num(base.y), dx: num(base.dx), dy: num(base.dy) }
        : null,
    shifts,
  };
}

function readSize(value: unknown): Size {
  const v = obj(value);
  return { w: num(v.w), h: num(v.h) };
}

function readDeleteMark(value: unknown): DeleteMark | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return { action: str(v.action), root: str(v.root), rev: str(v.rev) };
}

function readRemovalMark(value: unknown): RemovalMark | null {
  if (typeof value !== "object" || value === null) return null;
  return { rev: str((value as Record<string, unknown>).rev) };
}

function readIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Reads the envelope of one element map (everything except data and ext). */
export function readEnvelope(map: Y.Map<unknown>): ElementEnvelope {
  const type = str(map.get("type"));
  const envelope: { -readonly [K in keyof ElementEnvelope]: ElementEnvelope[K] } = {
    type,
    parent: idOrNull(map.get("parent")),
    order: orderKey(map.get("order")),
    pos: readPos(map.get("pos")),
    rebase: readRebase(map.get("rebase")),
    locked: map.get("locked") === true,
    rev: revision(map.get("rev")),
    deleted: readDeleteMark(map.get("deleted")),
    dissolved: map.get("dissolved") === true,
  };
  if (type !== GROUP_TYPE) envelope.size = readSize(map.get("size"));
  if (type !== GROUP_TYPE && type !== FRAME_TYPE) envelope.rot = num(map.get("rot"));
  return envelope;
}

/** Element lookup that reads the Y.Doc directly. */
export function yLookup(doc: Y.Doc): ElementLookup {
  const elements = roots(doc).elements;
  return {
    get(id) {
      const map = elements.get(id);
      return map instanceof Y.Map ? readEnvelope(map) : undefined;
    },
    ids: () => elements.keys(),
  };
}

function readSlots(map: unknown): ElementData {
  const data: ElementData = {};
  if (!(map instanceof Y.Map)) return data;
  for (const [key, value] of map.entries()) setOwn(data, key, dataValueFromY(value));
  return data;
}

function writeSlots(map: Y.Map<unknown>, data: ElementData): void {
  for (const key of Object.keys(data)) map.set(key, dataValueToY(data[key]!));
}

function jsonOr(value: unknown, fallback: Json): Json {
  return isJson(value) ? cloneJson(value) : fallback;
}

export function readElement(map: Y.Map<unknown>): Element {
  const envelope = readEnvelope(map);
  const typeVersion = map.get("typeVersion");
  const base = {
    type: envelope.type,
    typeVersion: Number.isInteger(typeVersion) ? (typeVersion as number) : 1,
    parent: envelope.parent,
    order: envelope.order,
    pos: envelope.pos,
    rebase: envelope.rebase ?? null,
    name: str(map.get("name")),
    locked: envelope.locked,
    rev: envelope.rev ?? "0",
    deleted: envelope.deleted ?? null,
    dissolved: envelope.dissolved ?? false,
    refs: readIds(map.get("refs")),
    ext: readSlots(map.get("ext")),
    data: readSlots(map.get("data")),
  };
  if (envelope.type === GROUP_TYPE) return base as Element;
  if (envelope.type === FRAME_TYPE) return { ...base, size: envelope.size! } as Element;
  return { ...base, size: envelope.size!, rot: envelope.rot ?? 0 };
}

/** Fills an (empty or new) element map from the JSON form. */
export function writeElement(map: Y.Map<unknown>, element: Element): void {
  map.set("type", element.type);
  map.set("typeVersion", element.typeVersion);
  map.set("parent", element.parent);
  map.set("order", element.order);
  map.set("pos", cloneJson(element.pos));
  map.set("rebase", element.rebase ? cloneJson(element.rebase) : null);
  if ("size" in element) map.set("size", cloneJson(element.size));
  if ("rot" in element) map.set("rot", element.rot);
  map.set("name", element.name);
  map.set("locked", element.locked);
  map.set("rev", element.rev);
  map.set("deleted", element.deleted ? cloneJson(element.deleted) : null);
  map.set("dissolved", element.dissolved);
  map.set("refs", [...element.refs]);
  const ext = new Y.Map<unknown>();
  map.set("ext", ext);
  writeSlots(ext, element.ext);
  const data = new Y.Map<unknown>();
  map.set("data", data);
  writeSlots(data, element.data);
}

function readView(value: unknown): StopView {
  const v = obj(value);
  if (v.kind === "frame")
    return { kind: "frame", frame: str(v.frame), padding: num(v.padding) };
  return {
    kind: "rect",
    space: idOrNull(v.space),
    x: num(v.x),
    y: num(v.y),
    w: num(v.w, 1),
    h: num(v.h, 1),
  };
}

export function readStop(map: Y.Map<unknown>): Stop {
  const visibility: { [element: ElementId]: VisibilityChange } = {};
  const vis = map.get("visibility");
  if (vis instanceof Y.Map) {
    for (const [element, change] of vis.entries()) {
      const action = obj(change).action;
      if (action === "show" || action === "hide") setOwn(visibility, element, { action });
    }
  }
  const notes = map.get("notes");
  return {
    name: str(map.get("name")),
    view: readView(map.get("view")),
    notes: notes instanceof Y.Text ? textFromY(notes) : { $y: "text", delta: [] },
    visibility,
    transition: jsonOr(map.get("transition") ?? null, null),
    rev: revision(map.get("rev")),
    removed: readRemovalMark(map.get("removed")),
    ext: readSlots(map.get("ext")),
  };
}

export function writeStop(map: Y.Map<unknown>, stop: Stop): void {
  map.set("name", stop.name);
  map.set("view", cloneJson(stop.view));
  map.set("notes", textToY(stop.notes));
  const visibility = new Y.Map<unknown>();
  map.set("visibility", visibility);
  for (const element of Object.keys(stop.visibility)) {
    visibility.set(element, { action: stop.visibility[element]!.action });
  }
  map.set("transition", cloneJson(stop.transition));
  map.set("rev", stop.rev);
  map.set("removed", stop.removed ? cloneJson(stop.removed) : null);
  const ext = new Y.Map<unknown>();
  map.set("ext", ext);
  writeSlots(ext, stop.ext);
}

export function readRoute(map: Y.Map<unknown>): Route {
  const entries: { [entry: string]: RouteEntry } = {};
  const raw = map.get("entries");
  if (raw instanceof Y.Map) {
    for (const [id, entry] of raw.entries()) {
      const e = obj(entry);
      if (typeof e.stop === "string") {
        setOwn(entries, id, { stop: e.stop, order: orderKey(e.order) });
      }
    }
  }
  return {
    name: str(map.get("name")),
    order: orderKey(map.get("order")),
    entries,
    rev: revision(map.get("rev")),
    removed: readRemovalMark(map.get("removed")),
    ext: readSlots(map.get("ext")),
  };
}

export function writeRoute(map: Y.Map<unknown>, route: Route): void {
  map.set("name", route.name);
  map.set("order", route.order);
  map.set("rev", route.rev);
  map.set("removed", route.removed ? cloneJson(route.removed) : null);
  const entries = new Y.Map<unknown>();
  map.set("entries", entries);
  for (const id of Object.keys(route.entries)) {
    const entry = route.entries[id]!;
    entries.set(id, { stop: entry.stop, order: entry.order });
  }
  const ext = new Y.Map<unknown>();
  map.set("ext", ext);
  writeSlots(ext, route.ext);
}

function sortedRecord<T>(entries: Iterable<[string, T]>): { [key: string]: T } {
  const list = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: { [key: string]: T } = {};
  for (const [key, value] of list) setOwn(out, key, value);
  return out;
}

function mapsOf(map: Y.Map<Y.Map<unknown>> | Y.Map<unknown>): [string, Y.Map<unknown>][] {
  return [...(map as Y.Map<unknown>).entries()].filter(
    (e): e is [string, Y.Map<unknown>] => e[1] instanceof Y.Map,
  );
}

/** The JSON form of the document's current state. Keys are sorted. Never throws. */
export function toSnapshot(doc: Y.Doc): DocumentSnapshot {
  const r = roots(doc);
  const schemaVersion = r.meta.get("schemaVersion");
  const minReaderVersion = r.meta.get("minReaderVersion");
  return {
    schemaVersion: Number.isInteger(schemaVersion)
      ? (schemaVersion as number)
      : SCHEMA_VERSION,
    minReaderVersion: Number.isInteger(minReaderVersion)
      ? (minReaderVersion as number)
      : MIN_READER_VERSION,
    id: str(r.meta.get("id")),
    title: str(r.meta.get("title")),
    settings: sortedRecord(
      [...r.settings.entries()]
        .filter(([, value]) => isJson(value))
        .map(([key, value]): [string, Json] => [key, cloneJson(value)]),
    ) as JsonObject,
    elements: sortedRecord(mapsOf(r.elements).map(([id, map]) => [id, readElement(map)])),
    stops: sortedRecord(mapsOf(r.stops).map(([id, map]) => [id, readStop(map)])),
    routes: sortedRecord(mapsOf(r.routes).map(([id, map]) => [id, readRoute(map)])),
    assets: sortedRecord(
      [...r.assets.entries()]
        .filter(([, info]) => isJson(info))
        .map(([id, info]) => [id, cloneJson(info) as unknown as AssetInfo]),
    ) as DocumentSnapshot["assets"],
  };
}

/** The document's merge identity (section 9.3); empty if it has none. */
export function lineageOf(doc: Y.Doc): string {
  return str(roots(doc).meta.get("lineage"));
}

/**
 * Builds a new Y.Doc from the JSON form. The result has a fresh CRDT identity and
 * a new lineage: it merges with copies made from it, never with the Y.Doc the
 * snapshot was taken from or with another document built from the same snapshot
 * (section 9.3).
 */
export function fromSnapshot(
  snapshot: DocumentSnapshot,
  doc: Y.Doc = new Y.Doc(),
  randomBytes?: RandomBytes,
): Y.Doc {
  const r = roots(doc);
  doc.transact(() => {
    r.meta.set("schemaVersion", snapshot.schemaVersion);
    r.meta.set("minReaderVersion", snapshot.minReaderVersion);
    r.meta.set("id", snapshot.id);
    r.meta.set("title", snapshot.title);
    r.meta.set("lineage", newId(randomBytes));
    for (const key of Object.keys(snapshot.settings)) {
      r.settings.set(key, cloneJson(snapshot.settings[key]));
    }
    for (const id of Object.keys(snapshot.elements)) {
      const map = new Y.Map<unknown>();
      r.elements.set(id, map);
      writeElement(map, snapshot.elements[id]!);
    }
    for (const id of Object.keys(snapshot.stops)) {
      const map = new Y.Map<unknown>();
      r.stops.set(id, map);
      writeStop(map, snapshot.stops[id]!);
    }
    for (const id of Object.keys(snapshot.routes)) {
      const map = new Y.Map<unknown>();
      r.routes.set(id, map);
      writeRoute(map, snapshot.routes[id]!);
    }
    for (const id of Object.keys(snapshot.assets)) {
      r.assets.set(id, cloneJson(snapshot.assets[id as AssetId]));
    }
  }, ORIGIN.load);
  return doc;
}

/**
 * Content of a Y.Doc that the JSON form does not carry: unknown root types,
 * unknown keys in meta, element, stop and route maps, or records and values of
 * the wrong kind. A document read from a file must have none (section 9.3).
 */
export function hiddenContent(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const [name, type] of doc.share) {
    if (!ROOT_NAMES.includes(name)) out.push(`root ${name}`);
    else if (type._start !== null) out.push(`root ${name}: not a map`);
  }
  const r = roots(doc);
  const known = (map: Y.Map<unknown>, keys: readonly string[], path: string) => {
    for (const key of map.keys()) if (!keys.includes(key)) out.push(`${path}.${key}`);
  };
  known(r.meta, META_KEYS, "meta");
  for (const [id, value] of r.elements.entries()) {
    if (!(value instanceof Y.Map)) out.push(`elements.${id}: not a map`);
    else known(value, ELEMENT_KEYS, `elements.${id}`);
  }
  for (const [id, value] of r.stops.entries()) {
    if (!(value instanceof Y.Map)) out.push(`stops.${id}: not a map`);
    else known(value, STOP_KEYS, `stops.${id}`);
  }
  for (const [id, value] of r.routes.entries()) {
    if (!(value instanceof Y.Map)) out.push(`routes.${id}: not a map`);
    else known(value, ROUTE_KEYS, `routes.${id}`);
  }
  for (const [key, value] of r.settings.entries())
    if (!isJson(value)) out.push(`settings.${key}`);
  for (const [key, value] of r.assets.entries())
    if (!isJson(value)) out.push(`assets.${key}`);
  return out;
}
