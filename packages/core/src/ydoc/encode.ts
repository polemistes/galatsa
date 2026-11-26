// SPDX-License-Identifier: GPL-3.0-or-later

// Lossless conversion between values in value positions (element data, ext slots,
// shared-type contents) in the JSON form and Yjs values. It needs no knowledge of
// the element type, which is what lets elements from missing extensions survive a
// round trip untouched. Reading from Yjs never throws: values JSON cannot express
// are encoded as "any" trees, and unknown shared types are quarantined as
// "unsupported" (section 3.4 of docs/adr/0001-document-model-and-file-format.md).

import * as Y from "yjs";
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep copy of a JSON value; throws on anything that is not JSON. */
export function cloneJson(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Numbers in the document must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) setOwn(out, key, cloneJson(item));
    }
    return out;
  }
  throw new Error(`Not a JSON value: ${String(value)}`);
}

/** True if `value` is plain JSON (finite numbers, no undefined, binary or bigint). */
export function isJson(value: unknown, depth = 0): boolean {
  if (depth > 512) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
  if (isPlainObject(value)) {
    return Object.keys(value).every((k) => isJson(value[k], depth + 1));
  }
  return false;
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
// Any trees: lossless form of values JSON cannot express
// ---------------------------------------------------------------------------

/** Encodes any value Yjs can store as plain content. Never throws. */
export function toAnyTree(value: unknown, depth = 0): AnyTree {
  if (depth > 512) return { u: 1 };
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : { n: String(value) };
  if (typeof value === "bigint") return { i: value.toString() };
  if (value === undefined) return { u: 1 };
  if (value instanceof Uint8Array) return { b: toBase64(value) };
  if (Array.isArray(value)) return { a: value.map((v) => toAnyTree(v, depth + 1)) };
  if (typeof value === "object") {
    const o: { [key: string]: AnyTree } = {};
    for (const key of Object.keys(value)) {
      setOwn(o, key, toAnyTree((value as Record<string, unknown>)[key], depth + 1));
    }
    return { o };
  }
  return { u: 1 };
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

// ---------------------------------------------------------------------------
// From Yjs to the JSON form
// ---------------------------------------------------------------------------

/** A plain (non-shared) value read from Yjs, in its JSON-form encoding. */
function plainFromY(value: unknown): DataValue {
  if (!isJson(value)) return { $y: "any", value: toAnyTree(value) };
  const json = cloneJson(value);
  // A plain object with a "$y" key of its own must be escaped to stay plain.
  if (isPlainObject(json) && "$y" in json) return { $y: "json", value: json };
  return json;
}

function attributesFromY(node: Y.Text | Y.XmlElement): NodeAttributes | undefined {
  const raw = node.getAttributes() as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) return undefined;
  const out: NodeAttributes = {};
  for (const key of keys) setOwn(out, key, dataValueFromY(raw[key]));
  return out;
}

function deltaFromY(text: Y.Text): TextRun[] {
  const delta = text.toDelta() as Array<{ insert: unknown; attributes?: unknown }>;
  return delta.map((op) => {
    const insert: string | DataValue =
      typeof op.insert === "string" ? op.insert : dataValueFromY(op.insert);
    const run: TextRun = { insert };
    if (op.attributes !== undefined && isJson(op.attributes)) {
      run.attributes = cloneJson(op.attributes) as JsonObject;
    }
    return run;
  });
}

function xmlNodeFromY(node: unknown): YXmlNode {
  if (node instanceof Y.XmlText) {
    const attributes = attributesFromY(node);
    return attributes
      ? { $y: "xmlText", delta: deltaFromY(node), attributes }
      : { $y: "xmlText", delta: deltaFromY(node) };
  }
  if (node instanceof Y.XmlElement) {
    return {
      $y: "xmlElement",
      name: node.nodeName,
      attributes: attributesFromY(node) ?? {},
      children: node.toArray().map(xmlNodeFromY),
    };
  }
  if (node instanceof Y.XmlHook) return hookFromY(node);
  // Anything else in a fragment is quarantined as an empty hook.
  return { $y: "xmlHook", hookName: "galatsa:unsupported", entries: {} };
}

function hookFromY(hook: Y.XmlHook): YXmlNode {
  const entries: { [key: string]: DataValue } = {};
  for (const [key, item] of hook.entries()) setOwn(entries, key, dataValueFromY(item));
  return { $y: "xmlHook", hookName: hook.hookName, entries };
}

/** Converts a value read from a Y.Map, Y.Array or text to the JSON form. Never throws. */
export function dataValueFromY(value: unknown): DataValue {
  // Subclasses first: XmlHook extends Map, XmlText extends Text, XmlElement
  // extends XmlFragment.
  if (value instanceof Y.XmlHook) return hookFromY(value);
  if (value instanceof Y.XmlText || value instanceof Y.XmlElement)
    return xmlNodeFromY(value);
  if (value instanceof Y.Text) {
    const attributes = attributesFromY(value);
    return attributes
      ? { $y: "text", delta: deltaFromY(value), attributes }
      : { $y: "text", delta: deltaFromY(value) };
  }
  if (value instanceof Y.XmlFragment) {
    return { $y: "xmlFragment", children: value.toArray().map(xmlNodeFromY) };
  }
  if (value instanceof Y.Map) {
    const entries: { [key: string]: DataValue } = {};
    for (const [key, item] of value.entries()) setOwn(entries, key, dataValueFromY(item));
    return { $y: "map", entries };
  }
  if (value instanceof Y.Array)
    return { $y: "array", items: value.toArray().map(dataValueFromY) };
  if (value instanceof Y.AbstractType) {
    return { $y: "unsupported", note: `shared type ${value.constructor.name}` };
  }
  return plainFromY(value);
}

// ---------------------------------------------------------------------------
// From the JSON form to Yjs
// ---------------------------------------------------------------------------

function isTagged(value: unknown): value is YValue {
  return isPlainObject(value) && "$y" in value;
}

function setAttributes(
  node: Y.Text | Y.XmlElement,
  attributes: NodeAttributes | undefined,
): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    // Yjs's typing says string, but attributes hold any value, shared types included.
    node.setAttribute(key, dataValueToY(attributes[key]!) as string);
  }
}

function deltaToY(delta: readonly TextRun[]): object[] {
  return delta.map((run) => {
    let insert: unknown;
    if (typeof run.insert === "string") insert = run.insert;
    else if (isTagged(run.insert) && run.insert.$y === "json")
      insert = cloneJson(run.insert.value);
    else insert = dataValueToY(run.insert);
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
      hook.set(key, dataValueToY(node.entries[key]!));
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

/** Converts a JSON-form value to what is stored in a Y.Map, Y.Array or text. */
export function dataValueToY(input: DataValue): unknown {
  if (!isTagged(input)) return cloneJson(input);
  const value = input;
  switch (value.$y) {
    case "json":
      return cloneJson(value.value);
    case "any":
      return fromAnyTree(value.value);
    case "unsupported":
      return null;
    case "text": {
      const text = new Y.Text();
      text.applyDelta(deltaToY(value.delta));
      setAttributes(text, value.attributes);
      return text;
    }
    case "map": {
      const map = new Y.Map<unknown>();
      for (const key of Object.keys(value.entries))
        map.set(key, dataValueToY(value.entries[key]!));
      return map;
    }
    case "array": {
      const array = new Y.Array<unknown>();
      array.insert(0, value.items.map(dataValueToY));
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
    default:
      return null;
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

/** Reads a Y.Text in the JSON form. */
export function textFromY(text: Y.Text): {
  $y: "text";
  delta: TextRun[];
  attributes?: NodeAttributes;
} {
  const attributes = attributesFromY(text);
  return attributes
    ? { $y: "text", delta: deltaFromY(text), attributes }
    : { $y: "text", delta: deltaFromY(text) };
}
