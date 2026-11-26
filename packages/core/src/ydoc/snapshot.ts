// SPDX-License-Identifier: GPL-3.0-or-later

// Conversion between a Y.Doc and the JSON form (DocumentSnapshot), and read
// access to elements straight from the Y.Doc. Section 2 of
// docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import type { ElementEnvelope, ElementLookup } from "../model/resolve.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type ElementId,
  type Json,
  type JsonObject,
  type Position,
  type Removal,
  type Route,
  type RouteEntry,
  type Size,
  type Stop,
  type StopView,
  type VisibilityChange,
} from "../model/types.ts";
import { cloneJson, dataValueFromY, dataValueToY, textFromY, textToY } from "./encode.ts";
import { ORIGIN, roots } from "./schema.ts";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPos(value: unknown): Position {
  const v = (value ?? {}) as Partial<Position>;
  return {
    x: num(v.x),
    y: num(v.y),
    space: typeof v.space === "string" ? v.space : null,
  };
}

function readSize(value: unknown): Size {
  const v = (value ?? {}) as Partial<Size>;
  return { w: num(v.w), h: num(v.h) };
}

function readRemoval(value: unknown): Removal | null {
  return value === "delete" || value === "dissolve" ? value : null;
}

/** Reads the envelope of one element map (everything except data). */
export function readEnvelope(map: Y.Map<unknown>): ElementEnvelope {
  const type = str(map.get("type"));
  const parent = map.get("parent");
  const envelope: {
    -readonly [K in keyof ElementEnvelope]: ElementEnvelope[K];
  } = {
    type,
    parent: typeof parent === "string" ? parent : null,
    order: str(map.get("order")),
    pos: readPos(map.get("pos")),
    locked: map.get("locked") === true,
    removed: readRemoval(map.get("removed")),
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
      return map ? readEnvelope(map) : undefined;
    },
    ids: () => elements.keys(),
  };
}

function readData(map: Y.Map<unknown> | undefined): ElementData {
  const data: ElementData = {};
  if (!map) return data;
  for (const [key, value] of map.entries()) data[key] = dataValueFromY(value);
  return data;
}

export function readElement(map: Y.Map<unknown>): Element {
  const envelope = readEnvelope(map);
  const assets = map.get("assets");
  const typeVersion = map.get("typeVersion");
  const base = {
    type: envelope.type,
    typeVersion: Number.isInteger(typeVersion) ? (typeVersion as number) : 1,
    parent: envelope.parent,
    order: envelope.order,
    pos: envelope.pos,
    name: str(map.get("name")),
    locked: envelope.locked,
    assets: Array.isArray(assets)
      ? (assets.filter((a) => typeof a === "string") as AssetId[])
      : [],
    removed: envelope.removed,
    data: readData(map.get("data") as Y.Map<unknown> | undefined),
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
  if ("size" in element) map.set("size", cloneJson(element.size));
  if ("rot" in element) map.set("rot", element.rot);
  map.set("name", element.name);
  map.set("locked", element.locked);
  map.set("assets", [...element.assets]);
  map.set("removed", element.removed);
  const data = new Y.Map<unknown>();
  map.set("data", data);
  for (const [key, value] of Object.entries(element.data))
    data.set(key, dataValueToY(value));
}

function readStop(map: Y.Map<unknown>): Stop {
  const visibility: { [element: ElementId]: VisibilityChange } = {};
  const vis = map.get("visibility");
  if (vis instanceof Y.Map) {
    for (const [element, change] of vis.entries()) {
      const action = (change as Partial<VisibilityChange> | null)?.action;
      if (action === "show" || action === "hide") visibility[element] = { action };
    }
  }
  const notes = map.get("notes");
  return {
    name: str(map.get("name")),
    view: cloneJson(map.get("view")) as unknown as StopView,
    notes: { $y: "text", delta: notes instanceof Y.Text ? textFromY(notes) : [] },
    visibility,
    transition: cloneJson(map.get("transition") ?? null),
    removed: map.get("removed") === true,
  };
}

export function writeStop(map: Y.Map<unknown>, stop: Stop): void {
  map.set("name", stop.name);
  map.set("view", cloneJson(stop.view));
  map.set("notes", textToY(stop.notes.delta));
  const visibility = new Y.Map<unknown>();
  map.set("visibility", visibility);
  for (const [element, change] of Object.entries(stop.visibility)) {
    visibility.set(element, { action: change.action });
  }
  map.set("transition", cloneJson(stop.transition));
  map.set("removed", stop.removed);
}

function readRoute(map: Y.Map<unknown>): Route {
  const entries: { [entry: string]: RouteEntry } = {};
  const raw = map.get("entries");
  if (raw instanceof Y.Map) {
    for (const [id, entry] of raw.entries()) {
      const e = entry as Partial<RouteEntry> | null;
      if (typeof e?.stop === "string" && typeof e.order === "string") {
        entries[id] = { stop: e.stop, order: e.order };
      }
    }
  }
  return {
    name: str(map.get("name")),
    order: str(map.get("order")),
    entries,
    removed: map.get("removed") === true,
  };
}

export function writeRoute(map: Y.Map<unknown>, route: Route): void {
  map.set("name", route.name);
  map.set("order", route.order);
  map.set("removed", route.removed);
  const entries = new Y.Map<unknown>();
  map.set("entries", entries);
  for (const [id, entry] of Object.entries(route.entries)) {
    entries.set(id, { stop: entry.stop, order: entry.order });
  }
}

function sortedRecord<T>(entries: Iterable<[string, T]>): { [key: string]: T } {
  const list = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: { [key: string]: T } = {};
  for (const [key, value] of list) out[key] = value;
  return out;
}

/** The JSON form of the document's current state. Keys are sorted. */
export function toSnapshot(doc: Y.Doc): DocumentSnapshot {
  const r = roots(doc);
  const schemaVersion = r.meta.get("schemaVersion");
  return {
    schemaVersion: Number.isInteger(schemaVersion)
      ? (schemaVersion as number)
      : SCHEMA_VERSION,
    id: str(r.meta.get("id")),
    title: str(r.meta.get("title")),
    settings: sortedRecord(
      [...r.settings.entries()].map(([key, value]): [string, Json] => [
        key,
        cloneJson(value),
      ]),
    ) as JsonObject,
    elements: sortedRecord(
      [...r.elements.entries()].map(([id, map]) => [id, readElement(map)]),
    ),
    stops: sortedRecord([...r.stops.entries()].map(([id, map]) => [id, readStop(map)])),
    routes: sortedRecord(
      [...r.routes.entries()].map(([id, map]) => [id, readRoute(map)]),
    ),
    assets: sortedRecord(
      [...r.assets.entries()].map(([id, info]) => [
        id,
        cloneJson(info) as unknown as AssetInfo,
      ]),
    ) as DocumentSnapshot["assets"],
  };
}

/**
 * Builds a new Y.Doc from the JSON form. The result has fresh CRDT identity: it
 * merges with copies made from it, not with the Y.Doc the snapshot was taken from
 * (section 9.3).
 */
export function fromSnapshot(
  snapshot: DocumentSnapshot,
  doc: Y.Doc = new Y.Doc(),
): Y.Doc {
  const r = roots(doc);
  doc.transact(() => {
    r.meta.set("schemaVersion", snapshot.schemaVersion);
    r.meta.set("id", snapshot.id);
    r.meta.set("title", snapshot.title);
    for (const [key, value] of Object.entries(snapshot.settings))
      r.settings.set(key, cloneJson(value));
    for (const [id, element] of Object.entries(snapshot.elements)) {
      const map = new Y.Map<unknown>();
      r.elements.set(id, map);
      writeElement(map, element);
    }
    for (const [id, stop] of Object.entries(snapshot.stops)) {
      const map = new Y.Map<unknown>();
      r.stops.set(id, map);
      writeStop(map, stop);
    }
    for (const [id, route] of Object.entries(snapshot.routes)) {
      const map = new Y.Map<unknown>();
      r.routes.set(id, map);
      writeRoute(map, route);
    }
    for (const [id, info] of Object.entries(snapshot.assets))
      r.assets.set(id, cloneJson(info));
  }, ORIGIN.load);
  return doc;
}
