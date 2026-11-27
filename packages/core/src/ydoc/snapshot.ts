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
  envelopeField,
  isPlainObject,
  readRevision,
  readSeen,
  readSnapshot,
} from "../model/grammar.ts";
import { newId, type RandomBytes } from "../model/ids.ts";
import type { ElementEnvelope, ElementLookup } from "../model/resolve.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  type AssetId,
  type DeleteMark,
  type DeleteMarks,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type Rebase,
  type Revision,
  type Route,
  type Size,
  type Stop,
} from "../model/types.ts";
import { cloneJson, jsonFromY, rawFromY, textToY, valueToY } from "./encode.ts";
import { trackWork } from "./track.ts";
import {
  ELEMENT_KEYS,
  META_KEYS,
  ORIGIN,
  ROOT_NAMES,
  ROUTE_KEYS,
  STOP_KEYS,
  isVersionKey,
  roots,
  versionsOf,
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

/** A record's `refs` as stored: a set of ids. */
function rawRefs(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return jsonFromY(value);
  return [...(value as Y.Map<unknown>).keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** The current revision of a record map. */
export function revisionOf(record: Y.Map<unknown>): Revision {
  return readRevision(rawRevision(record.get("rev")), QUIET);
}

/**
 * What marks list, read once per stored value. A mark's `seen` is one stored
 * object that is replaced as a whole, so the reading of it can be kept for as
 * long as that object is: resolving a document after every local transaction
 * then costs nothing for the marks that are there, however much they list.
 */
const SEEN = new WeakMap<object, DeleteMark["seen"]>();
const NO_MARKS: DeleteMarks = Object.freeze({}) as DeleteMarks;

/** The delete marks of a record map, as the grammar reads them. */
export function marksOf(record: Y.Map<unknown>): DeleteMarks {
  const marks = record.get("deleted");
  if (!(marks instanceof Y.Map) || marks.size === 0) return NO_MARKS;
  const out: DeleteMarks = {};
  for (const [action, mark] of (marks as Y.Map<unknown>).entries()) {
    if (!ID_PATTERN.test(action) || !(mark instanceof Y.Map)) continue;
    const stored = (mark as Y.Map<unknown>).get("seen");
    if (!isPlainObject(stored)) continue;
    let seen = SEEN.get(stored);
    if (!seen) SEEN.set(stored, (seen = readSeen(jsonFromY(stored) as Raw, QUIET)));
    out[action] = { seen };
  }
  return out;
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
export function markToY(seen: DeleteMark["seen"]): Y.Map<unknown> {
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
  refs: rawRefs,
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
): unknown {
  if (!(record instanceof Y.Map)) return jsonFromY(record);
  const out: Raw = {};
  for (const [key, value] of (record as Y.Map<unknown>).entries()) {
    const convert = Object.hasOwn(special, key) ? special[key]! : jsonFromY;
    put(out, key, convert(value));
  }
  return out;
}

const UNREAD = Symbol("unread");
type Unread = typeof UNREAD;

/**
 * The envelope of one element map (everything except data and ext). Each key is
 * read, by the grammar's reader for it, when it is first asked for: resolving a
 * large document for one question reads only the keys that question needs.
 */
class LiveEnvelope implements ElementEnvelope {
  readonly type: string;
  private readonly map: Y.Map<unknown>;
  private _parent: string | null | Unread = UNREAD;
  private _order: string | Unread = UNREAD;
  private _pos: ElementEnvelope["pos"] | Unread = UNREAD;
  private _rebase: Rebase | null | Unread = UNREAD;
  private _locked: boolean | Unread = UNREAD;
  private _rev: Revision | Unread = UNREAD;
  private _deleted: DeleteMarks | Unread = UNREAD;
  private _dissolved: boolean | Unread = UNREAD;
  private _purged: boolean | Unread = UNREAD;
  private _size: Size | undefined | Unread = UNREAD;
  private _rot: number | undefined | Unread = UNREAD;

  constructor(map: Y.Map<unknown>, type: string) {
    this.map = map;
    this.type = type;
  }

  get parent(): string | null {
    if (this._parent === UNREAD)
      this._parent = envelopeField.parent(this.map.get("parent"), QUIET);
    return this._parent;
  }

  get order(): string {
    if (this._order === UNREAD)
      this._order = envelopeField.order(this.map.get("order"), QUIET);
    return this._order;
  }

  get pos(): ElementEnvelope["pos"] {
    if (this._pos === UNREAD)
      this._pos = envelopeField.pos(jsonFromY(this.map.get("pos")), QUIET);
    return this._pos;
  }

  get rebase(): Rebase | null {
    if (this._rebase === UNREAD)
      this._rebase = envelopeField.rebase(jsonFromY(this.map.get("rebase")), QUIET);
    return this._rebase;
  }

  get locked(): boolean {
    if (this._locked === UNREAD)
      this._locked = envelopeField.locked(this.map.get("locked"), QUIET);
    return this._locked;
  }

  get rev(): Revision {
    if (this._rev === UNREAD)
      this._rev = envelopeField.rev(rawRevision(this.map.get("rev")), QUIET);
    return this._rev;
  }

  get deleted(): DeleteMarks {
    if (this._deleted === UNREAD) this._deleted = marksOf(this.map);
    return this._deleted;
  }

  get dissolved(): boolean {
    if (this._dissolved === UNREAD) {
      this._dissolved = envelopeField.dissolved(
        this.map.get("dissolved"),
        this.type,
        QUIET,
      );
    }
    return this._dissolved;
  }

  get purged(): boolean {
    if (this._purged === UNREAD) {
      this._purged = envelopeField.purged(this.map.get("purged"), this.type, QUIET);
    }
    return this._purged;
  }

  get size(): Size | undefined {
    if (this._size === UNREAD) {
      this._size =
        this.type === GROUP_TYPE
          ? undefined
          : envelopeField.size(jsonFromY(this.map.get("size")), QUIET);
    }
    return this._size;
  }

  get rot(): number | undefined {
    if (this._rot === UNREAD) {
      this._rot =
        this.type === GROUP_TYPE || this.type === FRAME_TYPE
          ? undefined
          : envelopeField.rot(this.map.get("rot"), QUIET);
    }
    return this._rot;
  }
}

/** The envelope of one element map, or undefined if the record is not an element. */
export function envelopeFromY(map: Y.Map<unknown>): ElementEnvelope | undefined {
  const type = envelopeField.type(map.get("type"));
  return type === null ? undefined : new LiveEnvelope(map, type);
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
  // The versions in effect; a base value that is not a version is passed on as
  // it is, so that the grammar reports it.
  const versions = versionsOf(doc);
  const version = (key: "schemaVersion" | "minReaderVersion"): unknown => {
    const base = r.meta.get(key);
    return Number.isSafeInteger(base) && (base as number) >= 1
      ? versions[key]
      : jsonFromY(base);
  };
  return {
    schemaVersion: version("schemaVersion"),
    minReaderVersion: version("minReaderVersion"),
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

/**
 * What a root type holds that the format has no place for: "all" of it if the
 * root is not one of the six, its "list" content if it is (they are maps), or
 * null. A root that has been emptied counts as holding nothing.
 */
export function foreignRootContent(
  name: string,
  type: Y.AbstractType<unknown>,
): "all" | "list" | null {
  let list = false;
  for (let item = type._start; item !== null; item = item.right) {
    if (!item.deleted) list = true;
  }
  if (ROOT_NAMES.includes(name)) return list ? "list" : null;
  if (list) return "all";
  for (const item of type._map.values()) if (!item.deleted) return "all";
  return null;
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
    Object.assign(raw, {
      schemaVersion: 1,
      minReaderVersion: 1,
      id: "unknown",
      title: "",
    });
  }
  const read = readSnapshot(raw);
  const problems = [...read.problems];
  for (const [name, type] of doc.share) {
    const content = foreignRootContent(name, type as Y.AbstractType<unknown>);
    if (content === "all") problems.push(`root ${name}: unknown root type`);
    else if (content === "list") problems.push(`root ${name}: not a map`);
  }
  for (const key of r.meta.keys()) {
    if (!(META_KEYS as readonly string[]).includes(key) && !isVersionKey(key))
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
  map.set("rebase", element.rebase ? cloneJson(element.rebase) : null);
  if ("size" in element) map.set("size", cloneJson(element.size));
  if ("rot" in element) map.set("rot", element.rot);
  map.set("name", element.name);
  map.set("locked", element.locked);
  map.set("dissolved", element.dissolved);
  map.set("purged", element.purged);
  const refs = new Y.Map<unknown>();
  map.set("refs", refs);
  for (const ref of element.refs) refs.set(ref, true);
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
  trackWork(doc, randomBytes);
  return doc;
}

/** Keys of each kind of record, for code that removes what the grammar does not know. */
export const RECORD_KEYS = {
  elements: ELEMENT_KEYS as readonly string[],
  stops: STOP_KEYS as readonly string[],
  routes: ROUTE_KEYS as readonly string[],
} as const;
