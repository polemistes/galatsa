// SPDX-License-Identifier: GPL-3.0-or-later

// Conversion between Yjs values and values in value positions of the JSON form
// (element data, ext slots, shared-type contents). It needs no knowledge of the
// element type, which is what lets elements from missing extensions survive a
// round trip untouched. Section 3.4 of
// docs/adr/0001-document-model-and-file-format.md.
//
// Reading from Yjs (`rawFromY`) never throws and gives the same result on every
// replica: a value is read the way Yjs delivers it to other replicas, not the way
// the writing replica happens to hold it in memory. The result is then read by
// the grammar (`readValue`), which is what makes it valid.

import * as Y from "yjs";
import {
  MAX_DEPTH,
  Problems,
  UNSUPPORTED_HOOK,
  isPlainObject,
  readValue,
  wellFormed,
} from "../model/grammar.ts";
import {
  setOwn,
  type AnyTree,
  type DataValue,
  type Json,
  type JsonObject,
  type NodeAttributes,
  type TextRun,
  type YValue,
  type YXmlElementValue,
  type YXmlNode,
} from "../model/types.ts";

/**
 * Deepest recursion of the conversions here. The grammar cuts at MAX_DEPTH, so
 * anything this bound replaces would have been cut anyway.
 */
const CONVERSION_DEPTH = MAX_DEPTH + 8;

/** Deep copy of valid JSON-form data (as the grammar returns it). */
export function cloneJson<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => cloneJson(item)) as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) setOwn(out, key, cloneJson(item));
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Base64 (no platform API needed)
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("Invalid base64");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 255;
    }
  }
  return out.subarray(0, at);
}

// ---------------------------------------------------------------------------
// Plain values, as Yjs delivers them
// ---------------------------------------------------------------------------

/**
 * The lossless tree of a plain value stored in a shared map or array, as every
 * replica reads it. Yjs encodes such values with lib0's "any" encoding, which
 * keeps undefined, binary data, non-finite numbers and 64-bit integers, reads
 * every other object by its own enumerable keys, and loses keys named
 * "__proto__". Strings are well-formed and negative zero is zero, as in JSON.
 */
export function toAnyTree(value: unknown, depth = 0): AnyTree {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { n: String(value) };
    return value === 0 ? 0 : value;
  }
  if (typeof value === "bigint") return { i: BigInt.asIntN(64, value).toString() };
  if (value instanceof Uint8Array) return { b: toBase64(value) };
  if (typeof value !== "object") return { u: 1 };
  if (depth > CONVERSION_DEPTH) return null;
  if (Array.isArray(value)) return { a: value.map((v) => toAnyTree(v, depth + 1)) };
  const o: { [key: string]: AnyTree } = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") continue;
    setOwn(
      o,
      wellFormed(key),
      toAnyTree((value as Record<string, unknown>)[key], depth + 1),
    );
  }
  return { o };
}

/** Decodes an any tree back to the value it stands for. */
export function fromAnyTree(tree: AnyTree): unknown {
  if (tree === null || typeof tree !== "object") return tree;
  if ("a" in tree) return tree.a.map(fromAnyTree);
  if ("o" in tree) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(tree.o)) setOwn(out, key, fromAnyTree(tree.o[key]!));
    return out;
  }
  if ("u" in tree) return undefined;
  if ("b" in tree) return fromBase64(tree.b);
  if ("n" in tree) return Number(tree.n);
  if ("i" in tree) return BigInt(tree.i);
  return null;
}

/** The JSON value of an any tree, or undefined if it holds something JSON cannot. */
function jsonOfTree(tree: AnyTree): Json | undefined {
  if (tree === null || typeof tree !== "object") return tree;
  if ("a" in tree) {
    const out: Json[] = [];
    for (const item of tree.a) {
      const json = jsonOfTree(item);
      if (json === undefined) return undefined;
      out.push(json);
    }
    return out;
  }
  if ("o" in tree) {
    const out: JsonObject = {};
    for (const key of Object.keys(tree.o)) {
      const json = jsonOfTree(tree.o[key]!);
      if (json === undefined) return undefined;
      setOwn(out, key, json);
    }
    return out;
  }
  return undefined;
}

function isMarkerShaped(value: JsonObject): boolean {
  return (
    value.$y === "unsupported" &&
    typeof value.note === "string" &&
    Object.keys(value).every((key) => key === "$y" || key === "note" || key === "raw")
  );
}

/** A JSON value in a value position: an object with a "$y" key of its own is escaped. */
function escaped(json: Json): unknown {
  return isPlainObject(json) && Object.hasOwn(json, "$y") && !isMarkerShaped(json)
    ? { $y: "json", value: json }
    : json;
}

/** A plain value read from a shared map or array, in the JSON form. */
function plainFromY(value: unknown): unknown {
  const tree = toAnyTree(value);
  const json = jsonOfTree(tree);
  return json === undefined ? { $y: "any", value: tree } : escaped(json);
}

/**
 * A plain value where the JSON form has plain JSON (settings, asset
 * descriptions, envelope keys, route entries): what JSON cannot express, and
 * shared types, read as null.
 */
export function jsonFromY(value: unknown): Json {
  if (value instanceof Y.AbstractType) return null;
  const lossy = (tree: AnyTree): Json => {
    if (tree === null || typeof tree !== "object") return tree;
    if ("a" in tree) return tree.a.map(lossy);
    if ("o" in tree) {
      const out: JsonObject = {};
      for (const key of Object.keys(tree.o)) setOwn(out, key, lossy(tree.o[key]!));
      return out;
    }
    return null;
  };
  return lossy(toAnyTree(value));
}

/**
 * A text embed or a formatting attribute value, as every replica reads it. Yjs
 * sends these as JSON text (update format 1, the format Galatsa uses), so this
 * follows JSON.stringify: undefined, functions and symbols disappear from
 * objects and become null in arrays, non-finite numbers become null, and other
 * objects are read by their own enumerable keys (or their toJSON method).
 */
function jsonWire(value: unknown, depth = 0): Json | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (typeof value === "bigint") return null;
  if (typeof value !== "object") return undefined;
  if (depth > CONVERSION_DEPTH) return null;
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    try {
      return jsonWire((toJson as () => unknown).call(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.map((v) => jsonWire(v, depth + 1) ?? null);
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const item = jsonWire((value as Record<string, unknown>)[key], depth + 1);
    if (item !== undefined) setOwn(out, wellFormed(key), item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// From Yjs to the JSON form
// ---------------------------------------------------------------------------

function entriesFromY(map: Y.Map<unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of map.entries()) setOwn(out, key, rawFromY(item, depth + 1));
  return out;
}

function attributesFromY(
  node: Y.Text | Y.XmlElement,
  depth: number,
): Record<string, unknown> | undefined {
  const raw = node.getAttributes() as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) setOwn(out, key, rawFromY(raw[key], depth + 1));
  return out;
}

function deltaFromY(text: Y.Text, depth: number): unknown[] {
  const delta = text.toDelta() as Array<{ insert: unknown; attributes?: unknown }>;
  return delta.map((op) => {
    let insert: unknown;
    if (typeof op.insert === "string") insert = op.insert;
    else if (op.insert instanceof Y.AbstractType) insert = rawFromY(op.insert, depth + 1);
    else {
      const json = jsonWire(op.insert) ?? null;
      insert = typeof json === "string" ? json : escaped(json);
    }
    const attributes = op.attributes === undefined ? undefined : jsonWire(op.attributes);
    return attributes === undefined ? { insert } : { insert, attributes };
  });
}

function textFromY(text: Y.Text, tag: "text" | "xmlText", depth: number): unknown {
  const attributes = attributesFromY(text, depth);
  const delta = deltaFromY(text, depth);
  return attributes ? { $y: tag, delta, attributes } : { $y: tag, delta };
}

function hookFromY(hook: Y.XmlHook, depth: number): unknown {
  return { $y: "xmlHook", hookName: hook.hookName, entries: entriesFromY(hook, depth) };
}

function xmlChildrenFromY(node: Y.XmlFragment, depth: number): unknown[] {
  return node.toArray().map((child: unknown) => {
    if (
      child instanceof Y.XmlText ||
      child instanceof Y.XmlElement ||
      child instanceof Y.XmlHook
    ) {
      return rawFromY(child, depth + 1);
    }
    // Anything else in a fragment has no place in the JSON form.
    return { $y: "xmlHook", hookName: UNSUPPORTED_HOOK, entries: {} };
  });
}

/**
 * Converts a value read from a shared map, array or text to the JSON form, to be
 * read by the grammar. Never throws.
 */
export function rawFromY(value: unknown, depth = 0): unknown {
  if (!(value instanceof Y.AbstractType)) return plainFromY(value);
  if (depth > CONVERSION_DEPTH) return { $y: "unsupported", note: "nested too deep" };
  // Subclasses first: XmlHook extends Map, XmlText extends Text, XmlElement
  // extends XmlFragment.
  if (value instanceof Y.XmlHook) return hookFromY(value, depth);
  if (value instanceof Y.XmlText) return textFromY(value, "xmlText", depth);
  if (value instanceof Y.XmlElement) {
    return {
      $y: "xmlElement",
      name: value.nodeName,
      attributes: attributesFromY(value, depth) ?? {},
      children: xmlChildrenFromY(value, depth),
    };
  }
  if (value instanceof Y.Text) return textFromY(value, "text", depth);
  if (value instanceof Y.XmlFragment) {
    return { $y: "xmlFragment", children: xmlChildrenFromY(value, depth) };
  }
  if (value instanceof Y.Map) {
    return { $y: "map", entries: entriesFromY(value as Y.Map<unknown>, depth) };
  }
  if (value instanceof Y.Array) {
    return {
      $y: "array",
      items: (value as Y.Array<unknown>)
        .toArray()
        .map((item) => rawFromY(item, depth + 1)),
    };
  }
  return { $y: "unsupported", note: "unknown shared type" };
}

/**
 * The JSON form of a value read from a shared map or array directly inside a
 * data or ext map. Never throws; the result is valid.
 */
export function valueFromY(value: unknown): DataValue {
  return readValue(rawFromY(value), new Problems(0), 5);
}

// ---------------------------------------------------------------------------
// From the JSON form to Yjs (the input is valid: it was read by the grammar)
// ---------------------------------------------------------------------------

function isTagged(value: unknown): value is YValue {
  return isPlainObject(value) && Object.hasOwn(value, "$y");
}

function setAttributes(
  node: Y.Text | Y.XmlElement,
  attributes: NodeAttributes | undefined,
): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    // Yjs's typing says string, but attributes hold any value, shared types included.
    node.setAttribute(key, valueToY(attributes[key]!) as string);
  }
}

function deltaToY(delta: readonly TextRun[]): object[] {
  return delta.map((run) => {
    const insert = typeof run.insert === "string" ? run.insert : valueToY(run.insert);
    return run.attributes
      ? { insert, attributes: cloneJson(run.attributes) }
      : { insert };
  });
}

function xmlNodeToY(node: YXmlNode): Y.XmlElement | Y.XmlText | Y.XmlHook {
  if (node.$y === "xmlText") {
    const text = new Y.XmlText();
    text.applyDelta(deltaToY(node.delta));
    setAttributes(text, node.attributes);
    return text;
  }
  if (node.$y === "xmlHook") {
    const hook = new Y.XmlHook(node.hookName);
    for (const key of Object.keys(node.entries))
      hook.set(key, valueToY(node.entries[key]!));
    return hook;
  }
  return xmlElementToY(node);
}

function xmlElementToY(node: YXmlElementValue): Y.XmlElement {
  const element = new Y.XmlElement(node.name);
  setAttributes(element, node.attributes);
  element.insert(0, node.children.map(xmlNodeToY) as Array<Y.XmlElement | Y.XmlText>);
  return element;
}

/** Converts a valid JSON-form value to what is stored in a shared map, array or text. */
export function valueToY(input: DataValue): unknown {
  if (!isTagged(input)) return cloneJson(input);
  const value = input;
  switch (value.$y) {
    case "json":
      return cloneJson(value.value);
    case "any":
      return fromAnyTree(value.value);
    case "unsupported":
      // Stored as it is written; it reads back as the same unsupported value.
      return cloneJson(value);
    case "text":
      return textToY(value);
    case "map": {
      const map = new Y.Map<unknown>();
      for (const key of Object.keys(value.entries))
        map.set(key, valueToY(value.entries[key]!));
      return map;
    }
    case "array": {
      const array = new Y.Array<unknown>();
      array.insert(0, value.items.map(valueToY));
      return array;
    }
    case "xmlFragment": {
      const fragment = new Y.XmlFragment();
      fragment.insert(
        0,
        value.children.map(xmlNodeToY) as Array<Y.XmlElement | Y.XmlText>,
      );
      return fragment;
    }
    case "xmlElement":
    case "xmlText":
    case "xmlHook":
      return xmlNodeToY(value);
  }
}

/** Converts a JSON-form shared text to a Y.Text (not yet attached to a document). */
export function textToY(value: {
  delta: readonly TextRun[];
  attributes?: NodeAttributes;
}): Y.Text {
  const text = new Y.Text();
  text.applyDelta(deltaToY(value.delta));
  setAttributes(text, value.attributes);
  return text;
}
