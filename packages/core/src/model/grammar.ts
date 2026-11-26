// SPDX-License-Identifier: GPL-3.0-or-later

// The grammar of a document in its JSON form, as one total reading function.
//
// `readSnapshot` turns anything into a valid DocumentSnapshot and lists what it
// had to change: values that do not fit read as fixed defaults, records that
// cannot be used at all are left out, and values in value positions that this
// version does not understand are kept verbatim as "unsupported". Reading the
// result again changes nothing.
//
// Everything that produces or accepts a document uses this one function: the
// conversion from a Y.Doc (`toSnapshot`), the file reader and the file writer,
// validation (`validateSnapshot` is "reading reports nothing"), and the
// operations, which check their arguments with the same readers. So a document
// that can be saved can be opened, and one odd value never makes a file
// unreadable. Sections 3.4 and 9.6 of
// docs/adr/0001-document-model-and-file-format.md.

import { DEFAULT_ORDER_KEY, isValidOrderKey } from "./order.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  MIN_READER_VERSION,
  SCHEMA_VERSION,
  UNKNOWN_DOCUMENT_ID,
  setOwn,
  type AnyTree,
  type AssetId,
  type AssetInfo,
  type DataValue,
  type DeleteMarks,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type Json,
  type JsonExt,
  type JsonObject,
  type NodeAttributes,
  type Position,
  type Rebase,
  type Revision,
  type Route,
  type RouteEntry,
  type Shift,
  type Size,
  type Stop,
  type StopView,
  type TextRun,
  type UnsupportedValue,
  type VisibilityChange,
  type YXmlNode,
} from "./types.ts";

export const ASSET_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;
export const ELEMENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/**
 * Ids are opaque, 1 to 64 characters from the URL-safe base64 alphabet, and never
 * "__proto__" (which some JSON tools treat specially).
 */
export const ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9_-]{1,64}$/;
/** Keys of a revision: a writer's session key. */
export const WRITER_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;
/** Largest counter in a revision. */
export const MAX_REVISION_COUNT = 4096;
/** Deepest nesting of arrays and objects in a document's JSON form. */
export const MAX_DEPTH = 256;
/** Most shifts a rebase holds (section 5.3). */
export const MAX_SHIFTS = 64;
/** The media type an asset reads as when its own is missing or invalid. */
export const DEFAULT_MEDIA_TYPE = "application/octet-stream";
/** Hook name of a node in an XML fragment that could not be represented. */
export const UNSUPPORTED_HOOK = "galatsa:unsupported";

// ---------------------------------------------------------------------------
// Collecting problems
// ---------------------------------------------------------------------------

/** Collects what a reading changed. Paths are only built when a problem is found. */
export class Problems {
  readonly list: string[] = [];
  /** Number of problems found (the list keeps only the first `limit`). */
  count = 0;
  /** A trial reading: only whether anything is found matters. */
  readonly trial: boolean;
  readonly #path: string[] = [];
  readonly #limit: number;

  constructor(limit = 1000, trial = false) {
    this.#limit = limit;
    this.trial = trial;
  }

  add(message: string): void {
    this.count++;
    if (this.list.length < this.#limit) {
      this.list.push(`${this.#path.join(".") || "document"}: ${message}`);
    }
  }

  /** Runs `fn` with `segment` appended to the path. */
  at<T>(segment: string, fn: () => T): T {
    this.#path.push(segment);
    try {
      return fn();
    } finally {
      this.#path.pop();
    }
  }
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/** A plain object: created by `{}`, JSON.parse or with a null prototype. */
export function isPlainObject(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

/**
 * Strings are well-formed Unicode: a lone surrogate reads as U+FFFD, which is
 * what it becomes when Yjs sends it to another replica.
 */
export function wellFormed(text: string): string {
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATES, "\uFFFD") : text;
}

function own(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownKeys(raw: Raw, allowed: readonly string[], p: Problems): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) p.at(key, () => p.add("unknown field, left out"));
  }
}

function readString(raw: Raw, key: string, fallback: string, p: Problems): string {
  const value = own(raw, key);
  if (typeof value === "string") {
    const text = wellFormed(value);
    if (text !== value) p.at(key, () => p.add("not well-formed Unicode"));
    return text;
  }
  p.at(key, () => p.add(`must be a string, read as ${JSON.stringify(fallback)}`));
  return fallback;
}

function readNumber(
  raw: Raw,
  key: string,
  fallback: number,
  p: Problems,
  min = -Infinity,
): number {
  const value = own(raw, key);
  if (finite(value) && value >= min) return value === 0 ? 0 : value;
  p.at(key, () =>
    p.add(
      `must be a finite number${min === -Infinity ? "" : ` >= ${min}`}, read as ${fallback}`,
    ),
  );
  return fallback;
}

function readIdOrNull(raw: Raw, key: string, p: Problems): string | null {
  const value = own(raw, key);
  if (value === null || isId(value)) return value;
  p.at(key, () => p.add("must be an id or null, read as null"));
  return null;
}

function readOrder(raw: Raw, key: string, p: Problems): string {
  const value = own(raw, key);
  if (typeof value === "string" && isValidOrderKey(value)) return value;
  p.at(key, () => p.add(`not a valid order key, read as "${DEFAULT_ORDER_KEY}"`));
  return DEFAULT_ORDER_KEY;
}

// ---------------------------------------------------------------------------
// Plain JSON
// ---------------------------------------------------------------------------

/**
 * Reads a plain JSON value. `level` is the nesting level of `raw` in the
 * document (the document object is level 1). Numbers are finite, negative zero
 * reads as zero, strings are well-formed, object keys named "__proto__" are left
 * out (Yjs does not carry them between replicas), and anything deeper than
 * MAX_DEPTH or not JSON reads as null.
 */
export function readJson(raw: unknown, p: Problems, level: number): Json {
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const text = wellFormed(raw);
    if (text !== raw) p.add("not well-formed Unicode");
    return text;
  }
  if (typeof raw === "number") {
    if (Number.isFinite(raw)) return raw === 0 ? 0 : raw;
    p.add("number is not finite, read as null");
    return null;
  }
  if (Array.isArray(raw)) {
    if (level > MAX_DEPTH) {
      p.add("nested too deep, read as null");
      return null;
    }
    const out: Json[] = [];
    for (let i = 0; i < raw.length; i++) {
      out.push(p.at(String(i), () => readJson(raw[i], p, level + 1)));
    }
    return out;
  }
  if (isPlainObject(raw)) {
    if (level > MAX_DEPTH) {
      p.add("nested too deep, read as null");
      return null;
    }
    const out: JsonObject = {};
    for (const key of Object.keys(raw)) {
      if (key === "__proto__") {
        p.add('a key named "__proto__" inside a plain value is left out');
        continue;
      }
      const item = raw[key];
      if (item === undefined) {
        p.at(key, () => p.add("undefined, left out"));
        continue;
      }
      const name = wellFormed(key);
      setOwn(
        out,
        name,
        p.at(key, () => readJson(item, p, level + 1)),
      );
    }
    return out;
  }
  p.add("not a JSON value, read as null");
  return null;
}

/** Deep equality of two JSON values, whatever the key order. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEquals(item, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) && jsonEquals((a as Raw)[key], (b as Raw)[key] as unknown),
  );
}

/** An open slot of a plain JSON value: a JSON object, left out when empty. */
function readJsonExt(raw: Raw, p: Problems, level: number): JsonExt | undefined {
  const value = own(raw, "ext");
  if (value === undefined) return undefined;
  return p.at("ext", () => {
    if (!isPlainObject(value)) {
      p.add("must be an object, left out");
      return undefined;
    }
    const ext = readJson(value, p, level + 1) as JsonExt;
    if (Object.keys(ext).length === 0) {
      p.add("empty, left out");
      return undefined;
    }
    return ext;
  });
}

// ---------------------------------------------------------------------------
// Values in value positions (section 3.4)
// ---------------------------------------------------------------------------

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
const INT64 = /^(?:0|-?[1-9][0-9]{0,18})$/;

/** Reads an any tree, or returns undefined if it is not one. */
function readAnyTree(raw: unknown, level: number): AnyTree | undefined {
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "string") return wellFormed(raw) === raw ? raw : undefined;
  if (typeof raw === "number") return Number.isFinite(raw) && !Object.is(raw, -0) ? raw : undefined;
  if (!isPlainObject(raw) || level + 1 > MAX_DEPTH) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  const inner = raw[key];
  switch (key) {
    case "a": {
      if (!Array.isArray(inner)) return undefined;
      const a: AnyTree[] = [];
      for (const item of inner) {
        const tree = readAnyTree(item, level + 2);
        if (tree === undefined) return undefined;
        a.push(tree);
      }
      return { a };
    }
    case "o": {
      if (!isPlainObject(inner)) return undefined;
      const o: { [key: string]: AnyTree } = {};
      for (const k of Object.keys(inner)) {
        if (k === "__proto__" || wellFormed(k) !== k) return undefined;
        const tree = readAnyTree(inner[k], level + 2);
        if (tree === undefined) return undefined;
        setOwn(o, k, tree);
      }
      return { o };
    }
    case "u":
      return inner === 1 ? { u: 1 } : undefined;
    case "b":
      return typeof inner === "string" && BASE64.test(inner) ? { b: inner } : undefined;
    case "n":
      return inner === "NaN" || inner === "Infinity" || inner === "-Infinity"
        ? { n: inner }
        : undefined;
    case "i":
      return typeof inner === "string" &&
        INT64.test(inner) &&
        BigInt.asIntN(64, BigInt(inner)).toString() === inner
        ? { i: inner }
        : undefined;
    default:
      return undefined;
  }
}

/** True if an any tree stands for a plain JSON value (and so should not be one). */
function anyTreeIsJson(tree: AnyTree): boolean {
  if (tree === null || typeof tree !== "object") return true;
  if ("a" in tree) return tree.a.every(anyTreeIsJson);
  if ("o" in tree) return Object.values(tree.o).every(anyTreeIsJson);
  return false;
}

function isUndefinedTree(tree: unknown): boolean {
  return isPlainObject(tree) && tree.u === 1;
}

function isMarker(raw: unknown): raw is Raw {
  if (!isPlainObject(raw) || own(raw, "$y") !== "unsupported") return false;
  if (typeof own(raw, "note") !== "string") return false;
  return Object.keys(raw).every((k) => k === "$y" || k === "note" || k === "raw");
}

/** The value a reader keeps in place of one it cannot represent. */
export function unsupported(note: string, raw?: Json): UnsupportedValue {
  return raw === undefined
    ? { $y: "unsupported", note }
    : { $y: "unsupported", note, raw };
}

/**
 * Keeps a value that does not read cleanly: the original, as plain JSON, inside
 * an unsupported value. If the plain copy does read cleanly (the trouble was
 * something plain JSON drops anyway), that reading is used instead, so reading
 * the result again gives the same.
 */
function quarantine(raw: unknown, note: string, p: Problems, level: number): DataValue {
  p.add(`${note}; kept as an unsupported value`);
  if (p.trial) return unsupported(note);
  const copy = readJson(raw, new Problems(0), level + 1);
  return restore(copy, level) ?? unsupported(note, copy);
}

/** The value `copy` stands for, if this version reads it without changing it. */
function restore(copy: Json, level: number): DataValue | undefined {
  const trial = new Problems(0, true);
  const value = readValue(copy, trial, level);
  return trial.count === 0 && !isMarker(value) ? value : undefined;
}

/** Levels a tagged value needs below itself (a text: delta, run, attributes). */
const TAG_HEADROOM = 3;

function hasOnly(raw: Raw, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function readEntries(
  raw: unknown,
  p: Problems,
  level: number,
): { [key: string]: DataValue } {
  const out: { [key: string]: DataValue } = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(raw)) {
    const name = wellFormed(key);
    if (name !== key) p.at(key, () => p.add("key is not well-formed Unicode"));
    setOwn(
      out,
      name,
      p.at(key, () => readValue(raw[key], p, level + 1)),
    );
  }
  return out;
}

function readDelta(raw: unknown[], p: Problems, level: number): TextRun[] {
  const out: TextRun[] = [];
  raw.forEach((item, i) =>
    p.at(String(i), () => {
      if (!isPlainObject(item) || !Object.hasOwn(item, "insert")) {
        p.add("not a run, left out");
        return;
      }
      unknownKeys(item, ["insert", "attributes"], p);
      let insert: string | DataValue;
      if (typeof item.insert === "string") {
        insert = wellFormed(item.insert);
        if (insert !== item.insert) p.add("not well-formed Unicode");
        if (insert === "") {
          p.add("empty run, left out");
          return;
        }
      } else {
        insert = p.at("insert", () => readValue(item.insert, p, level + 2));
        // Yjs stores an embed as JSON text or as a shared type: never null, and
        // never something JSON cannot express.
        if (insert === null || insert === "" || (isPlainObject(insert) && insert.$y === "any")) {
          p.add("not a possible embed, left out");
          return;
        }
      }
      let attributes: JsonObject | undefined;
      const rawAttributes = own(item, "attributes");
      if (rawAttributes !== undefined) {
        p.at("attributes", () => {
          if (!isPlainObject(rawAttributes)) {
            p.add("must be an object, left out");
            return;
          }
          const read = readJson(rawAttributes, p, level + 2) as JsonObject;
          const kept: JsonObject = {};
          for (const key of Object.keys(read)) {
            // A null attribute means "no formatting" in Yjs and is never stored.
            if (read[key] === null) p.add(`${key}: null attribute, left out`);
            else setOwn(kept, key, read[key]!);
          }
          if (Object.keys(kept).length === 0) p.add("empty, left out");
          else attributes = kept;
        });
      }
      const last = out[out.length - 1];
      if (
        typeof insert === "string" &&
        last !== undefined &&
        typeof last.insert === "string" &&
        jsonEquals(last.attributes, attributes)
      ) {
        // Runs are normalized as Yjs stores them: equal neighbours are one run.
        p.add("merged with the run before it");
        last.insert += insert;
        return;
      }
      out.push(attributes ? { insert, attributes } : { insert });
    }),
  );
  return out;
}

function readNodeAttributes(
  raw: unknown,
  p: Problems,
  level: number,
): NodeAttributes | undefined {
  if (raw === undefined) return undefined;
  const attributes = p.at("attributes", () => readEntries(raw, p, level));
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

/** Reads a child of an XML fragment or element. Anything else becomes a marker hook. */
function readXmlNode(raw: unknown, p: Problems, level: number): YXmlNode {
  const tag = isPlainObject(raw) ? own(raw, "$y") : undefined;
  if (tag === "xmlElement" || tag === "xmlText" || tag === "xmlHook") {
    const node = raw as Raw;
    const isMarkerHook =
      tag === "xmlHook" &&
      node.hookName === UNSUPPORTED_HOOK &&
      isPlainObject(node.entries) &&
      Object.keys(node.entries).length === 0 &&
      hasOnly(node, ["$y", "hookName", "entries"]);
    if (!isMarkerHook) {
      const value = readTagged(node, tag, p, level);
      if (isPlainObject(value) && value.$y === tag) return value as unknown as YXmlNode;
      p.add("replaced by a marker node");
    }
  } else p.add("not an XML node, replaced by a marker node");
  return { $y: "xmlHook", hookName: UNSUPPORTED_HOOK, entries: {} };
}

function readXmlChildren(raw: unknown[], p: Problems, level: number): YXmlNode[] {
  return raw.map((child, i) => p.at(String(i), () => readXmlNode(child, p, level + 1)));
}

function readTagged(raw: Raw, tag: unknown, p: Problems, level: number): DataValue {
  // An unsupported value without an original fits at any level.
  if (tag === "unsupported" && isMarker(raw) && !Object.hasOwn(raw, "raw")) {
    const note = wellFormed(raw.note as string);
    if (note !== raw.note) p.add("not well-formed Unicode");
    return unsupported(note);
  }
  if (level + TAG_HEADROOM > MAX_DEPTH) {
    p.add("nested too deep; kept as an unsupported value");
    return unsupported("nested too deep");
  }
  switch (tag) {
    case "json": {
      const value = own(raw, "value");
      if (!hasOnly(raw, ["$y", "value"])) break;
      if (isPlainObject(value) && Object.hasOwn(value, "$y") && !isMarker(value)) {
        return { $y: "json", value: p.at("value", () => readJson(value, p, level + 1)) };
      }
      p.add("needless escape, read as the value itself");
      return readValue(value, p, level);
    }
    case "any": {
      if (!hasOnly(raw, ["$y", "value"])) break;
      const tree = readAnyTree(own(raw, "value"), level + 1);
      if (tree === undefined) break;
      if (anyTreeIsJson(tree)) break;
      // Yjs cannot hold a big integer directly in a shared type, only nested.
      if (typeof tree === "object" && tree !== null && "i" in tree) break;
      return { $y: "any", value: tree };
    }
    case "unsupported": {
      if (!isMarker(raw)) break;
      const note = wellFormed(raw.note as string);
      if (note !== raw.note) p.add("not well-formed Unicode");
      const copy = p.at("raw", () => readJson(raw.raw, p, level + 1));
      // A version that understands the original restores it.
      return restore(copy, level) ?? unsupported(note, copy);
    }
    case "text":
    case "xmlText": {
      const delta = own(raw, "delta");
      const attributes = own(raw, "attributes");
      if (!hasOnly(raw, ["$y", "delta", "attributes"]) || !Array.isArray(delta)) break;
      if (attributes !== undefined && !isPlainObject(attributes)) break;
      const runs = p.at("delta", () => readDelta(delta, p, level + 1));
      const node = readNodeAttributes(attributes, p, level + 1);
      return node
        ? { $y: tag, delta: runs, attributes: node }
        : { $y: tag, delta: runs };
    }
    case "map": {
      const entries = own(raw, "entries");
      if (!hasOnly(raw, ["$y", "entries"]) || !isPlainObject(entries)) break;
      return { $y: "map", entries: p.at("entries", () => readEntries(entries, p, level + 1)) };
    }
    case "array": {
      const items = own(raw, "items");
      if (!hasOnly(raw, ["$y", "items"]) || !Array.isArray(items)) break;
      return {
        $y: "array",
        items: p.at("items", () =>
          items.map((item, i) =>
            p.at(String(i), () => {
              const value = readValue(item, p, level + 2);
              // A shared array cannot hold undefined directly.
              if (isPlainObject(value) && value.$y === "any" && isUndefinedTree(value.value)) {
                p.add("undefined in a shared array, read as null");
                return null;
              }
              return value;
            }),
          ),
        ),
      };
    }
    case "xmlFragment": {
      const children = own(raw, "children");
      if (!hasOnly(raw, ["$y", "children"]) || !Array.isArray(children)) break;
      return {
        $y: "xmlFragment",
        children: p.at("children", () => readXmlChildren(children, p, level + 1)),
      };
    }
    case "xmlElement": {
      const children = own(raw, "children");
      const attributes = own(raw, "attributes");
      if (
        !hasOnly(raw, ["$y", "name", "attributes", "children"]) ||
        typeof raw.name !== "string" ||
        !Array.isArray(children) ||
        !isPlainObject(attributes)
      ) {
        break;
      }
      return {
        $y: "xmlElement",
        name: wellFormed(raw.name),
        attributes: p.at("attributes", () => readEntries(attributes, p, level + 1)),
        children: p.at("children", () => readXmlChildren(children, p, level + 1)),
      };
    }
    case "xmlHook": {
      const entries = own(raw, "entries");
      if (
        !hasOnly(raw, ["$y", "hookName", "entries"]) ||
        typeof raw.hookName !== "string" ||
        !isPlainObject(entries)
      ) {
        break;
      }
      return {
        $y: "xmlHook",
        hookName: wellFormed(raw.hookName),
        entries: p.at("entries", () => readEntries(entries, p, level + 1)),
      };
    }
    default:
      return quarantine(raw, `unknown kind of value ${JSON.stringify(tag)}`, p, level);
  }
  return quarantine(raw, `malformed "${String(tag)}" value`, p, level);
}

/**
 * Reads a value in a value position: plain JSON, or an object with a "$y" tag.
 * A tagged value this version does not know, or whose own fields are malformed,
 * is kept verbatim as an unsupported value. A tagged value nested too deep is
 * replaced by an unsupported value without the original.
 */
export function readValue(raw: unknown, p: Problems, level: number): DataValue {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, "$y")) return readJson(raw, p, level);
  return readTagged(raw, raw.$y, p, level);
}

/** Reads a data or ext map: any keys, each value in a value position. */
export function readSlots(raw: unknown, p: Problems, level: number): ElementData {
  if (!isPlainObject(raw)) {
    p.add("must be an object, read as empty");
    return {};
  }
  return readEntries(raw, p, level);
}

// ---------------------------------------------------------------------------
// Revisions and delete marks (section 5.5)
// ---------------------------------------------------------------------------

export function readRevision(raw: unknown, p: Problems): Revision {
  const out: Revision = {};
  if (!isPlainObject(raw)) {
    p.add("must be an object, read as empty");
    return out;
  }
  for (const key of Object.keys(raw)) {
    const count = raw[key];
    if (
      WRITER_PATTERN.test(key) &&
      Number.isInteger(count) &&
      (count as number) >= 1 &&
      (count as number) <= MAX_REVISION_COUNT
    ) {
      setOwn(out, key, count as number);
    } else p.at(key, () => p.add("not a revision entry, left out"));
  }
  return out;
}

export function readDeleteMarks(raw: unknown, p: Problems): DeleteMarks {
  const out: DeleteMarks = {};
  if (!isPlainObject(raw)) {
    p.add("must be an object, read as empty");
    return out;
  }
  for (const action of Object.keys(raw)) {
    p.at(action, () => {
      const mark = raw[action];
      const seen = isPlainObject(mark) ? own(mark, "seen") : undefined;
      if (!ID_PATTERN.test(action) || !isPlainObject(mark) || !isPlainObject(seen)) {
        p.add("not a delete mark, left out");
        return;
      }
      unknownKeys(mark, ["seen"], p);
      const read: { [id: string]: Revision } = {};
      for (const id of Object.keys(seen)) {
        if (!ID_PATTERN.test(id)) {
          p.at(id, () => p.add("not an id, left out"));
          continue;
        }
        setOwn(
          read,
          id,
          p.at(id, () => readRevision(seen[id], p)),
        );
      }
      setOwn(out, action, { seen: read });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elements (section 3)
// ---------------------------------------------------------------------------

function readPosition(raw: unknown, p: Problems): Position {
  if (!isPlainObject(raw)) {
    p.add("must be an object, read as the origin");
    return { x: 0, y: 0, space: null };
  }
  unknownKeys(raw, ["x", "y", "space"], p);
  return {
    x: readNumber(raw, "x", 0, p),
    y: readNumber(raw, "y", 0, p),
    space: readIdOrNull(raw, "space", p),
  };
}

/** A rebase is used whole or not at all: a damaged one reads as null. */
function readRebase(raw: unknown, p: Problems): Rebase | null {
  if (raw === null) return null;
  const bad = (): null => {
    p.add("not a rebase, read as null");
    return null;
  };
  if (!isPlainObject(raw) || !hasOnly(raw, ["to", "base", "shifts"])) return bad();
  const { to, base, shifts } = raw;
  if (to !== null && !isId(to)) return bad();
  let readBase: Rebase["base"] = null;
  if (base !== null) {
    if (!isPlainObject(base) || !hasOnly(base, ["x", "y", "dx", "dy"])) return bad();
    const { x, y, dx, dy } = base;
    if (!finite(x) || !finite(y) || !finite(dx) || !finite(dy)) return bad();
    readBase = { x, y, dx, dy };
  }
  if (!Array.isArray(shifts) || shifts.length > MAX_SHIFTS) return bad();
  const readShifts: Shift[] = [];
  for (const shift of shifts as unknown[]) {
    if (!isPlainObject(shift) || !hasOnly(shift, ["from", "dx", "dy"])) return bad();
    const { from, dx, dy } = shift;
    if ((from !== null && !isId(from)) || !finite(dx) || !finite(dy)) return bad();
    readShifts.push({ from, dx, dy });
  }
  return { to, base: readBase, shifts: readShifts };
}

function readSize(raw: unknown, p: Problems): Size {
  if (!isPlainObject(raw)) {
    p.add("must be an object, read as empty");
    return { w: 0, h: 0 };
  }
  unknownKeys(raw, ["w", "h"], p);
  return { w: readNumber(raw, "w", 0, p, 0), h: readNumber(raw, "h", 0, p, 0) };
}

function readRefs(raw: unknown, p: Problems): string[] {
  if (!Array.isArray(raw)) {
    p.add("must be an array, read as empty");
    return [];
  }
  const out: string[] = [];
  for (const ref of raw) {
    if (isId(ref)) out.push(ref);
    else p.add("an entry is not an id, left out");
  }
  return out;
}

/** The envelope of an element: every key except `ext` and `data`. */
export type ElementFields = Omit<Element, "ext" | "data"> & {
  size?: Size;
  rot?: number;
};

const ENVELOPE_KEYS = [
  "type",
  "typeVersion",
  "parent",
  "order",
  "pos",
  "rebase",
  "size",
  "rot",
  "name",
  "locked",
  "rev",
  "deleted",
  "dissolved",
  "refs",
];

/**
 * Reads the envelope of an element, or returns null if the record cannot be an
 * element at all (it is not an object, or has no valid type).
 */
export function readEnvelope(raw: unknown, p: Problems): ElementFields | null {
  if (!isPlainObject(raw)) {
    p.add("not an object, left out");
    return null;
  }
  const type = own(raw, "type");
  if (typeof type !== "string" || !ELEMENT_TYPE_PATTERN.test(type)) {
    p.add("no valid element type, left out");
    return null;
  }
  const isGroup = type === GROUP_TYPE;
  const container = isGroup || type === FRAME_TYPE;
  const typeVersion = own(raw, "typeVersion");
  if (!Number.isInteger(typeVersion) || (typeVersion as number) < 1) {
    p.at("typeVersion", () => p.add("must be an integer >= 1, read as 1"));
  }
  const locked = own(raw, "locked");
  if (typeof locked !== "boolean") p.at("locked", () => p.add("must be a boolean"));
  let dissolved = own(raw, "dissolved");
  if (typeof dissolved !== "boolean") {
    p.at("dissolved", () => p.add("must be a boolean"));
    dissolved = false;
  } else if (dissolved && !container) {
    p.at("dissolved", () => p.add("only frames and groups can be dissolved"));
    dissolved = false;
  }
  const fields: ElementFields = {
    type,
    typeVersion:
      Number.isInteger(typeVersion) && (typeVersion as number) >= 1
        ? (typeVersion as number)
        : 1,
    parent: readIdOrNull(raw, "parent", p),
    order: readOrder(raw, "order", p),
    pos: p.at("pos", () => readPosition(own(raw, "pos"), p)),
    rebase: p.at("rebase", () => readRebase(own(raw, "rebase"), p)),
    name: readString(raw, "name", "", p),
    locked: locked === true,
    rev: p.at("rev", () => readRevision(own(raw, "rev"), p)),
    deleted: p.at("deleted", () => readDeleteMarks(own(raw, "deleted"), p)),
    dissolved: dissolved === true,
    refs: p.at("refs", () => readRefs(own(raw, "refs"), p)),
  };
  if (!isGroup) fields.size = p.at("size", () => readSize(own(raw, "size"), p));
  else if (Object.hasOwn(raw, "size")) p.at("size", () => p.add("groups have no size"));
  if (!container) fields.rot = readNumber(raw, "rot", 0, p);
  else if (Object.hasOwn(raw, "rot")) p.at("rot", () => p.add("containers do not rotate"));
  return fields;
}

/** Level of an element record in the document: document, elements, the record. */
const RECORD_LEVEL = 3;

export function readElement(raw: unknown, p: Problems): Element | null {
  const fields = readEnvelope(raw, p);
  if (!fields) return null;
  unknownKeys(raw as Raw, [...ENVELOPE_KEYS, "ext", "data"], p);
  return {
    ...fields,
    ext: p.at("ext", () => readSlots(own(raw as Raw, "ext"), p, RECORD_LEVEL + 1)),
    data: p.at("data", () => readSlots(own(raw as Raw, "data"), p, RECORD_LEVEL + 1)),
  } as Element;
}

// ---------------------------------------------------------------------------
// Stops and routes (section 6)
// ---------------------------------------------------------------------------

const DEFAULT_VIEW: StopView = { kind: "rect", space: null, x: 0, y: 0, w: 1, h: 1 };

export function readView(raw: unknown, p: Problems): StopView {
  if (isPlainObject(raw) && raw.kind === "frame" && isId(raw.frame)) {
    unknownKeys(raw, ["kind", "frame", "padding", "ext"], p);
    const view: StopView = {
      kind: "frame",
      frame: raw.frame,
      padding: readNumber(raw, "padding", 0, p, 0),
    };
    const ext = readJsonExt(raw, p, RECORD_LEVEL + 1);
    if (ext) view.ext = ext;
    return view;
  }
  if (isPlainObject(raw) && raw.kind === "rect") {
    unknownKeys(raw, ["kind", "space", "x", "y", "w", "h", "ext"], p);
    const size = (key: "w" | "h"): number => {
      const value = own(raw, key);
      if (finite(value) && value > 0) return value;
      p.at(key, () => p.add("must be a finite number > 0, read as 1"));
      return 1;
    };
    const view: StopView = {
      kind: "rect",
      space: readIdOrNull(raw, "space", p),
      x: readNumber(raw, "x", 0, p),
      y: readNumber(raw, "y", 0, p),
      w: size("w"),
      h: size("h"),
    };
    const ext = readJsonExt(raw, p, RECORD_LEVEL + 1);
    if (ext) view.ext = ext;
    return view;
  }
  p.add("not a stop view, read as a unit rectangle at the origin");
  return { ...DEFAULT_VIEW };
}

export function readVisibilityChange(raw: unknown, p: Problems): VisibilityChange | null {
  if (!isPlainObject(raw) || (raw.action !== "show" && raw.action !== "hide")) {
    p.add('action must be "show" or "hide", left out');
    return null;
  }
  unknownKeys(raw, ["action", "ext"], p);
  const change: VisibilityChange = { action: raw.action };
  const ext = readJsonExt(raw, p, RECORD_LEVEL + 2);
  if (ext) change.ext = ext;
  return change;
}

export function readStop(raw: unknown, p: Problems): Stop | null {
  if (!isPlainObject(raw)) {
    p.add("not an object, left out");
    return null;
  }
  unknownKeys(
    raw,
    ["name", "view", "notes", "visibility", "transition", "rev", "deleted", "ext"],
    p,
  );
  const visibility: Stop["visibility"] = {};
  p.at("visibility", () => {
    const rawVisibility = own(raw, "visibility");
    if (!isPlainObject(rawVisibility)) return p.add("must be an object, read as empty");
    for (const element of Object.keys(rawVisibility)) {
      p.at(element, () => {
        if (!ID_PATTERN.test(element)) return p.add("not an id, left out");
        const change = readVisibilityChange(rawVisibility[element], p);
        if (change) setOwn(visibility, element, change);
      });
    }
  });
  const notes = p.at("notes", () => {
    const rawNotes = own(raw, "notes");
    const value =
      isPlainObject(rawNotes) && rawNotes.$y === "text"
        ? readTagged(rawNotes, "text", p, RECORD_LEVEL + 1)
        : undefined;
    if (isPlainObject(value) && value.$y === "text") return value as unknown as Stop["notes"];
    p.add("must be a shared text, read as empty");
    return { $y: "text", delta: [] } as Stop["notes"];
  });
  return {
    name: readString(raw, "name", "", p),
    view: p.at("view", () => readView(own(raw, "view"), p)),
    notes,
    visibility,
    transition: p.at("transition", () =>
      readJson(own(raw, "transition") ?? null, p, RECORD_LEVEL + 1),
    ),
    rev: p.at("rev", () => readRevision(own(raw, "rev"), p)),
    deleted: p.at("deleted", () => readDeleteMarks(own(raw, "deleted"), p)),
    ext: p.at("ext", () => readSlots(own(raw, "ext"), p, RECORD_LEVEL + 1)),
  };
}

export function readRouteEntry(raw: unknown, p: Problems): RouteEntry | null {
  if (!isPlainObject(raw) || !isId(raw.stop)) {
    p.add("must have a stop id, left out");
    return null;
  }
  unknownKeys(raw, ["stop", "order", "ext"], p);
  const entry: RouteEntry = { stop: raw.stop, order: readOrder(raw, "order", p) };
  const ext = readJsonExt(raw, p, RECORD_LEVEL + 2);
  if (ext) entry.ext = ext;
  return entry;
}

export function readRoute(raw: unknown, p: Problems): Route | null {
  if (!isPlainObject(raw)) {
    p.add("not an object, left out");
    return null;
  }
  unknownKeys(raw, ["name", "order", "entries", "rev", "deleted", "ext"], p);
  const entries: Route["entries"] = {};
  p.at("entries", () => {
    const rawEntries = own(raw, "entries");
    if (!isPlainObject(rawEntries)) return p.add("must be an object, read as empty");
    for (const id of Object.keys(rawEntries)) {
      p.at(id, () => {
        if (!ID_PATTERN.test(id)) return p.add("not an id, left out");
        const entry = readRouteEntry(rawEntries[id], p);
        if (entry) setOwn(entries, id, entry);
      });
    }
  });
  return {
    name: readString(raw, "name", "", p),
    order: readOrder(raw, "order", p),
    entries,
    rev: p.at("rev", () => readRevision(own(raw, "rev"), p)),
    deleted: p.at("deleted", () => readDeleteMarks(own(raw, "deleted"), p)),
    ext: p.at("ext", () => readSlots(own(raw, "ext"), p, RECORD_LEVEL + 1)),
  };
}

// ---------------------------------------------------------------------------
// Assets (section 8)
// ---------------------------------------------------------------------------

/** A file name without folders, drive letters or special names. */
export function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    wellFormed(name) === name &&
    [...name].every((ch) => ch >= " " && ch !== "/" && ch !== "\\" && ch !== ":") &&
    name !== "." &&
    name !== ".."
  );
}

export function readAsset(raw: unknown, p: Problems): AssetInfo | null {
  if (!isPlainObject(raw)) {
    p.add("not an object, left out");
    return null;
  }
  unknownKeys(
    raw,
    ["mediaType", "byteLength", "name", "width", "height", "external", "ext"],
    p,
  );
  const mediaType = own(raw, "mediaType");
  const validType =
    typeof mediaType === "string" && /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(mediaType);
  if (!validType)
    p.at("mediaType", () => p.add(`not a media type, read as ${DEFAULT_MEDIA_TYPE}`));
  const byteLength = own(raw, "byteLength");
  const validLength = Number.isSafeInteger(byteLength) && (byteLength as number) >= 0;
  if (!validLength) p.at("byteLength", () => p.add("must be an integer >= 0, read as 0"));
  const info: AssetInfo = {
    mediaType: validType ? mediaType : DEFAULT_MEDIA_TYPE,
    byteLength: validLength ? (byteLength as number) : 0,
  };
  if (Object.hasOwn(raw, "name")) info.name = readString(raw, "name", "", p);
  for (const key of ["width", "height"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (finite(value) && value >= 0) info[key] = value === 0 ? 0 : value;
    else p.at(key, () => p.add("must be a finite number >= 0, left out"));
  }
  if (Object.hasOwn(raw, "external")) {
    const external = raw.external;
    if (
      isPlainObject(external) &&
      typeof external.path === "string" &&
      isPlainFileName(external.path) &&
      hasOnly(external, ["path"])
    ) {
      info.external = { path: external.path };
    } else {
      p.at("external", () => p.add("must be { path } with a plain file name, left out"));
    }
  }
  const ext = readJsonExt(raw, p, RECORD_LEVEL);
  if (ext) info.ext = ext;
  return info;
}

// ---------------------------------------------------------------------------
// The document (section 2)
// ---------------------------------------------------------------------------

const DOCUMENT_KEYS = [
  "schemaVersion",
  "minReaderVersion",
  "id",
  "title",
  "settings",
  "elements",
  "stops",
  "routes",
  "assets",
];

function readRecords<T>(
  raw: Raw,
  key: string,
  idPattern: RegExp,
  p: Problems,
  read: (item: unknown, p: Problems) => T | null,
): { [id: string]: T } {
  const out: { [id: string]: T } = {};
  p.at(key, () => {
    const records = own(raw, key);
    if (!isPlainObject(records)) return p.add("must be an object, read as empty");
    // Sorted by id, so that every replica lists the records in the same order.
    for (const id of Object.keys(records).sort()) {
      p.at(id, () => {
        if (!idPattern.test(id)) return p.add("not a valid id, left out");
        const record = read(records[id], p);
        if (record !== null) setOwn(out, id, record);
      });
    }
  });
  return out;
}

export interface ReadSnapshotResult {
  /** The document; null only if the input is not an object at all. */
  snapshot: DocumentSnapshot | null;
  /** What reading left out or replaced; empty for a valid document. */
  problems: string[];
  /** Number of problems (the list holds at most the first 1000). */
  problemCount: number;
}

/**
 * Reads anything as a document. Never throws. The result is valid: reading it
 * again reports nothing and returns an equal document.
 */
export function readSnapshot(raw: unknown): ReadSnapshotResult {
  const p = new Problems();
  if (!isPlainObject(raw)) {
    p.add("must be an object");
    return { snapshot: null, problems: p.list, problemCount: p.count };
  }
  unknownKeys(raw, DOCUMENT_KEYS, p);
  const rawSchema = own(raw, "schemaVersion");
  const schemaOk = Number.isSafeInteger(rawSchema) && (rawSchema as number) >= 1;
  if (!schemaOk) p.at("schemaVersion", () => p.add("must be an integer >= 1"));
  const schemaVersion = schemaOk ? (rawSchema as number) : SCHEMA_VERSION;
  const rawMin = own(raw, "minReaderVersion");
  const minOk =
    Number.isSafeInteger(rawMin) &&
    (rawMin as number) >= 1 &&
    (rawMin as number) <= schemaVersion;
  if (!minOk) {
    p.at("minReaderVersion", () => p.add("must be an integer from 1 to schemaVersion"));
  }
  const id = own(raw, "id");
  if (!isId(id)) p.at("id", () => p.add(`not an id, read as "${UNKNOWN_DOCUMENT_ID}"`));
  const settings: JsonObject = {};
  p.at("settings", () => {
    const rawSettings = own(raw, "settings");
    if (!isPlainObject(rawSettings)) return p.add("must be an object, read as empty");
    for (const key of Object.keys(rawSettings)) {
      const name = wellFormed(key);
      setOwn(
        settings,
        name,
        p.at(key, () => readJson(rawSettings[key], p, 3)),
      );
    }
  });
  const snapshot: DocumentSnapshot = {
    schemaVersion,
    minReaderVersion: minOk
      ? (rawMin as number)
      : Math.min(MIN_READER_VERSION, schemaVersion),
    id: isId(id) ? id : UNKNOWN_DOCUMENT_ID,
    title: readString(raw, "title", "", p),
    settings,
    elements: readRecords(raw, "elements", ID_PATTERN, p, readElement),
    stops: readRecords(raw, "stops", ID_PATTERN, p, readStop),
    routes: readRecords(raw, "routes", ID_PATTERN, p, readRoute),
    assets: readRecords(raw, "assets", ASSET_ID_PATTERN, p, readAsset) as {
      [id: AssetId]: AssetInfo;
    },
  };
  return { snapshot, problems: p.list, problemCount: p.count };
}

/** Problems found in a snapshot; an empty list means it is valid. */
export function validateSnapshot(value: unknown): string[] {
  return readSnapshot(value).problems;
}

/** Raised when something that must be valid is not. */
export class InvalidDocumentError extends Error {
  readonly problems: readonly string[];

  constructor(what: string, problems: readonly string[]) {
    super(`Invalid ${what}:\n${problems.slice(0, 20).join("\n")}`);
    this.name = "InvalidDocumentError";
    this.problems = problems;
  }
}

/** Narrows `value` to a snapshot, or throws with the problems found. */
export function assertSnapshot(value: unknown): asserts value is DocumentSnapshot {
  const problems = validateSnapshot(value);
  if (problems.length > 0) throw new InvalidDocumentError("document", problems);
}

/**
 * Runs a reader on an argument of an operation and throws if the reader had to
 * change anything, so operations cannot write what the grammar does not allow.
 */
export function checked<T>(what: string, read: (p: Problems) => T | null): T {
  const p = new Problems(20);
  const value = p.at(what, () => read(p));
  if (p.count > 0 || value === null) {
    throw new InvalidDocumentError(what, p.count > 0 ? p.list : [`${what}: invalid`]);
  }
  return value;
}

/**
 * Deepest nesting of `value`, computed without recursion so that hostile input
 * cannot overflow the stack. Stops counting at `limit + 1`.
 */
export function nestingDepth(value: unknown, limit = MAX_DEPTH): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (typeof item !== "object" || item === null) continue;
    if (depth + 1 > max) max = depth + 1;
    if (max > limit) return max;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return max;
}
