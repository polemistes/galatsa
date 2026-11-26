// SPDX-License-Identifier: GPL-3.0-or-later

// Conversion between a Y.Doc and the JSON form (DocumentSnapshot), and read
// access to elements straight from the Y.Doc. Section 2 of
// docs/adr/0001-document-model-and-file-format.md.
//
// Reading has two steps: the Yjs state is copied into plain data as it is, and
// the grammar (`model/grammar.ts`) reads that. So what `toSnapshot` returns is
// valid whatever a peer wrote, and it is the same reading the file reader does.

import * as Y from "yjs";
import {
  ID_PATTERN,
  InvalidDocumentError,
  Problems,
  readDeleteMarks,
  readEnvelope,
  readRevision,
  readSnapshot,
} from "../model/grammar.ts";
import { newId, type RandomBytes } from "../model/ids.ts";
import type { ElementEnvelope, ElementLookup } from "../model/resolve.ts";
import {
  type AssetId,
  type DeleteMarks,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type Revision,
  type Route,
  type Stop,
} from "../model/types.ts";
import { cloneJson, jsonFromY, rawFromY, textToY, valueToY } from "./encode.ts";
import {
  ELEMENT_KEYS,
  META_KEYS,
  ORIGIN,
  ROOT_NAMES,
  ROUTE_KEYS,
  STOP_KEYS,
  roots,
} from "./schema.ts";

type Raw = Record<string, unknown>;

function put(target: Raw, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Revisions and delete marks (section 5.5)
// ---------------------------------------------------------------------------

/** A record's `rev` as stored: each writer's counter is the length of its array. */
function rawRevision(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return jsonFromY(value);
  const out: Raw = {};
  for (const [writer, pool] of (value as Y.Map<unknown>).entries()) {
    put(out, writer, pool instanceof Y.Array ? pool.length : jsonFromY(pool));
  }
  return out;
}

function rawMarks(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return jsonFromY(value);
  const out: Raw = {};
  for (const [action, mark] of (value as Y.Map<unknown>).entries()) {
    if (!(mark instanceof Y.Map)) {
      put(out, action, jsonFromY(mark));
      continue;
    }
    const fields: Raw = {};
    for (const [key, item] of (mark as Y.Map<unknown>).entries()) {
      put(fields, key, jsonFromY(item));
    }
    put(out, action, fields);
  }
  return out;
}

const QUIET = new Problems(0);

/** The current revision of a record map. */
export function revisionOf(record: Y.Map<unknown>): Revision {
  return readRevision(rawRevision(record.get("rev")), QUIET);
}

/** The delete marks of a record map. */
export function marksOf(record: Y.Map<unknown>): DeleteMarks {
  return readDeleteMarks(rawMarks(record.get("deleted")), QUIET);
}

function revisionToY(rev: Revision): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const writer of Object.keys(rev)) {
    const pool = new Y.Array<boolean>();
    pool.push(new Array<boolean>(rev[writer]!).fill(true));
    map.set(writer, pool);
  }
  return map;
}

/** A delete mark as it is stored: a map, so that undo keeps it while it is refreshed. */
export function markToY(seen: { [id: string]: Revision }): Y.Map<unknown> {
  const mark = new Y.Map<unknown>();
  mark.set("seen", cloneJson(seen));
  return mark;
}

function marksToY(marks: DeleteMarks): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const action of Object.keys(marks)) map.set(action, markToY(marks[action]!.seen));
  return map;
}

// ---------------------------------------------------------------------------
// Records as plain data
// ---------------------------------------------------------------------------

function rawSlots(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return jsonFromY(value);
  const out: Raw = {};
  for (const [key, item] of (value as Y.Map<unknown>).entries()) {
    put(out, key, rawFromY(item));
  }
  return out;
}

function rawJsonMap(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return jsonFromY(value);
  const out: Raw = {};
  for (const [key, item] of (value as Y.Map<unknown>).entries()) {
    put(out, key, jsonFromY(item));
  }
  return out;
}

const ELEMENT_SPECIAL: { [key: string]: (value: unknown) => unknown } = {
  rev: rawRevision,
  deleted: rawMarks,
  ext: rawSlots,
  data: rawSlots,
};
const STOP_SPECIAL: { [key: string]: (value: unknown) => unknown } = {
  rev: rawRevision,
  deleted: rawMarks,
  ext: rawSlots,
  notes: (value) => rawFromY(value),
  visibility: rawJsonMap,
};
const ROUTE_SPECIAL: { [key: string]: (value: unknown) => unknown } = {
  rev: rawRevision,
  deleted: rawMarks,
  ext: rawSlots,
  entries: rawJsonMap,
};

function rawRecord(
  record: unknown,
  special: { [key: string]: (value: unknown) => unknown },
  skip?: ReadonlySet<string>,
): unknown {
  if (!(record instanceof Y.Map)) return jsonFromY(record);
  const out: Raw = {};
  for (const [key, value] of (record as Y.Map<unknown>).entries()) {
    if (skip?.has(key)) continue;
    const convert = Object.hasOwn(special, key) ? special[key]! : jsonFromY;
    put(out, key, convert(value));
  }
  return out;
}

const NOT_ENVELOPE: ReadonlySet<string> = new Set(["ext", "data"]);

/** Reads the envelope of one element map (everything except data and ext). */
export function envelopeFromY(map: Y.Map<unknown>): ElementEnvelope | undefined {
  return readEnvelope(rawRecord(map, ELEMENT_SPECIAL, NOT_ENVELOPE), QUIET) ?? undefined;
}

/**
 * Element lookup that reads the Y.Doc directly. It sees exactly the elements the
 * JSON form has: records the grammar leaves out are absent here too.
 */
export function yLookup(doc: Y.Doc): ElementLookup {
  const elements = roots(doc).elements as Y.Map<unknown>;
  return {
    get(id) {
      if (!ID_PATTERN.test(id)) return undefined;
      const map = elements.get(id);
      return map instanceof Y.Map ? envelopeFromY(map as Y.Map<unknown>) : undefined;
    },
    *ids() {
      for (const id of elements.keys()) if (ID_PATTERN.test(id)) yield id;
    },
  };
}

function rawRecords(
  map: Y.Map<unknown>,
  special: { [key: string]: (value: unknown) => unknown },
): Raw {
  const out: Raw = {};
  for (const [id, record] of map.entries()) put(out, id, rawRecord(record, special));
  return out;
}

/** The document as plain data, exactly as stored, for the grammar to read. */
function rawSnapshot(doc: Y.Doc): Raw {
  const r = roots(doc);
  const settings: Raw = {};
  for (const [key, value] of r.settings.entries()) put(settings, key, jsonFromY(value));
  const assets: Raw = {};
  for (const [id, info] of r.assets.entries()) put(assets, id, jsonFromY(info));
  return {
    schemaVersion: jsonFromY(r.meta.get("schemaVersion")),
    minReaderVersion: jsonFromY(r.meta.get("minReaderVersion")),
    id: jsonFromY(r.meta.get("id")),
    title: jsonFromY(r.meta.get("title")),
    settings,
    elements: rawRecords(r.elements as Y.Map<unknown>, ELEMENT_SPECIAL),
    stops: rawRecords(r.stops as Y.Map<unknown>, STOP_SPECIAL),
    routes: rawRecords(r.routes as Y.Map<unknown>, ROUTE_SPECIAL),
    assets,
  };
}

export interface Inspection {
  /** The JSON form of the document. Always valid. */
  snapshot: DocumentSnapshot;
  /**
   * Everything in the Y.Doc that the JSON form does not carry as it is stored:
   * values read as defaults, records and keys left out, unknown root types. Empty
   * for a document that only the reference operations wrote.
   */
  problems: string[];
}

/** True if the document holds nothing at all (a replica that has not synced yet). */
export function isBlank(doc: Y.Doc): boolean {
  if (doc.store.clients.size > 0) return false;
  return doc.store.pendingStructs === null && doc.store.pendingDs === null;
}

/**
 * Reads the document and reports what the reading had to leave out or replace.
 * A blank document (nothing synced yet) reads as an empty one without problems.
 */
export function inspectDocument(doc: Y.Doc): Inspection {
  const raw = rawSnapshot(doc);
  const r = roots(doc);
  const blankMeta = r.meta.size === 0;
  if (blankMeta) {
    // Nothing has arrived yet: the defaults are not a defect of the document.
    Object.assign(raw, { schemaVersion: 1, minReaderVersion: 1, id: "unknown", title: "" });
  }
  const read = readSnapshot(raw);
  const problems = [...read.problems];
  for (const [name, type] of doc.share) {
    if (!ROOT_NAMES.includes(name)) problems.push(`root ${name}: unknown root type`);
    else if (type._start !== null) problems.push(`root ${name}: not a map`);
  }
  for (const key of r.meta.keys()) {
    if (!(META_KEYS as readonly string[]).includes(key))
      problems.push(`meta.${key}: unknown field`);
  }
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    problems.push("document: holds updates that cannot be applied yet");
  }
  return { snapshot: read.snapshot!, problems };
}

/** The JSON form of the document's current state. Never throws; always valid. */
export function toSnapshot(doc: Y.Doc): DocumentSnapshot {
  return inspectDocument(doc).snapshot;
}

/** The document's merge identity (section 9.3); empty if it has none. */
export function lineageOf(doc: Y.Doc): string {
  const lineage = roots(doc).meta.get("lineage");
  return typeof lineage === "string" ? lineage : "";
}

// ---------------------------------------------------------------------------
// Writing records (the input is valid: it was read by the grammar)
// ---------------------------------------------------------------------------

function slotsToY(data: ElementData): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const key of Object.keys(data)) map.set(key, valueToY(data[key]!));
  return map;
}

/** Fills a new element map from the JSON form. */
export function writeElement(map: Y.Map<unknown>, element: Element): void {
  map.set("type", element.type);
  map.set("typeVersion", element.typeVersion);
  map.set("parent", element.parent);
  map.set("order", element.order);
  map.set("pos", cloneJson(element.pos));
  map.set(
    "rebase",
    element.rebase ? cloneJson(element.rebase) : null,
  );
  if ("size" in element) map.set("size", cloneJson(element.size));
  if ("rot" in element) map.set("rot", element.rot);
  map.set("name", element.name);
  map.set("locked", element.locked);
  map.set("dissolved", element.dissolved);
  map.set("refs", [...element.refs]);
  map.set("rev", revisionToY(element.rev));
  map.set("deleted", marksToY(element.deleted));
  map.set("ext", slotsToY(element.ext));
  map.set("data", slotsToY(element.data));
}

export function writeStop(map: Y.Map<unknown>, stop: Stop): void {
  map.set("name", stop.name);
  map.set("view", cloneJson(stop.view));
  map.set("notes", textToY(stop.notes));
  const visibility = new Y.Map<unknown>();
  map.set("visibility", visibility);
  for (const element of Object.keys(stop.visibility)) {
    visibility.set(element, cloneJson(stop.visibility[element]));
  }
  map.set("transition", cloneJson(stop.transition));
  map.set("rev", revisionToY(stop.rev));
  map.set("deleted", marksToY(stop.deleted));
  map.set("ext", slotsToY(stop.ext));
}

export function writeRoute(map: Y.Map<unknown>, route: Route): void {
  map.set("name", route.name);
  map.set("order", route.order);
  map.set("rev", revisionToY(route.rev));
  map.set("deleted", marksToY(route.deleted));
  const entries = new Y.Map<unknown>();
  map.set("entries", entries);
  for (const id of Object.keys(route.entries)) {
    entries.set(id, cloneJson(route.entries[id]));
  }
  map.set("ext", slotsToY(route.ext));
}

/**
 * Builds a new Y.Doc from the JSON form. The result has a fresh CRDT identity and
 * a new lineage: it merges with copies made from it, never with the Y.Doc the
 * snapshot was taken from or with another document built from the same snapshot
 * (section 9.3). The snapshot is read by the grammar first, so anything can be
 * passed; throws only if it is not an object at all.
 */
export function fromSnapshot(
  input: DocumentSnapshot,
  doc: Y.Doc = new Y.Doc(),
  randomBytes?: RandomBytes,
): Y.Doc {
  const snapshot = readSnapshot(input).snapshot;
  if (!snapshot) throw new InvalidDocumentError("document", ["must be an object"]);
  const r = roots(doc);
  doc.transact(() => {
    r.meta.set("schemaVersion", snapshot.schemaVersion);
    r.meta.set("minReaderVersion", snapshot.minReaderVersion);
    r.meta.set("id", snapshot.id);
    r.meta.set("title", snapshot.title);
    r.meta.set("lineage", newId(randomBytes));
    for (const key of Object.keys(snapshot.settings)) {
      r.settings.set(key, cloneJson(snapshot.settings[key]!));
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

/** Keys of each kind of record, for code that removes what the grammar does not know. */
export const RECORD_KEYS = {
  elements: ELEMENT_KEYS as readonly string[],
  stops: STOP_KEYS as readonly string[],
  routes: ROUTE_KEYS as readonly string[],
} as const;
