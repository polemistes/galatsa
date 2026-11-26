// SPDX-License-Identifier: GPL-3.0-or-later

// Lossless conversion between element data values in the JSON form (plain JSON or
// "$y"-tagged shared types) and Yjs values. It needs no knowledge of the element
// type, which is what lets elements from missing extensions survive a round trip
// untouched. Section 3.4 of docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import type {
  DataValue,
  Json,
  JsonObject,
  TextRun,
  YXmlElementValue,
  YValue,
  YXmlNode,
} from "../model/types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep copy of a JSON value; rejects anything that is not JSON. */
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
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = cloneJson(item);
    }
    return out;
  }
  throw new Error(`Not a JSON value: ${String(value)}`);
}

function deltaToY(delta: readonly TextRun[]): object[] {
  return delta.map((run) => {
    const insert = typeof run.insert === "string" ? run.insert : cloneJson(run.insert);
    return run.attributes
      ? { insert, attributes: cloneJson(run.attributes) }
      : { insert };
  });
}

function deltaFromY(text: Y.Text): TextRun[] {
  const delta = text.toDelta() as Array<{ insert: unknown; attributes?: unknown }>;
  return delta.map((op) => {
    if (typeof op.insert !== "string" && !isPlainObject(op.insert)) {
      throw new Error("Shared text may only embed plain JSON objects");
    }
    const insert =
      typeof op.insert === "string" ? op.insert : (cloneJson(op.insert) as JsonObject);
    const run: TextRun = { insert };
    if (op.attributes !== undefined)
      run.attributes = cloneJson(op.attributes) as JsonObject;
    return run;
  });
}

function xmlNodeToY(node: YXmlNode): Y.XmlElement | Y.XmlText {
  if (node.$y === "xmlText") {
    const text = new Y.XmlText();
    text.applyDelta(deltaToY(node.delta));
    return text;
  }
  return xmlElementToY(node);
}

function xmlElementToY(node: YXmlElementValue): Y.XmlElement {
  const element = new Y.XmlElement(node.name);
  for (const [key, value] of Object.entries(node.attributes)) {
    // Y.XmlElement's typing only allows strings, but any JSON value is stored.
    element.setAttribute(key, cloneJson(value) as string);
  }
  element.insert(0, node.children.map(xmlNodeToY));
  return element;
}

function xmlNodeFromY(node: unknown): YXmlNode {
  if (node instanceof Y.XmlText) return { $y: "xmlText", delta: deltaFromY(node) };
  if (node instanceof Y.XmlElement) {
    const attributes: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(node.getAttributes())) {
      attributes[key] = cloneJson(value);
    }
    return {
      $y: "xmlElement",
      name: node.nodeName,
      attributes,
      children: node.toArray().map(xmlNodeFromY),
    };
  }
  throw new Error("Unsupported XML node in a shared fragment");
}

/** Converts a JSON-form data value to what is stored in a Y.Map or Y.Array. */
export function dataValueToY(input: DataValue): unknown {
  if (!isPlainObject(input) || !("$y" in input)) return cloneJson(input);
  const value = input as unknown as YValue;
  switch (value.$y) {
    case "json":
      return cloneJson(value.value);
    case "text": {
      const text = new Y.Text();
      text.applyDelta(deltaToY(value.delta));
      return text;
    }
    case "map": {
      const map = new Y.Map<unknown>();
      for (const [key, item] of Object.entries(value.entries))
        map.set(key, dataValueToY(item));
      return map;
    }
    case "array": {
      const array = new Y.Array<unknown>();
      array.insert(0, value.items.map(dataValueToY));
      return array;
    }
    case "xmlFragment": {
      const fragment = new Y.XmlFragment();
      fragment.insert(0, value.children.map(xmlNodeToY));
      return fragment;
    }
    case "xmlElement":
    case "xmlText":
      return xmlNodeToY(value);
    default:
      throw new Error(
        `Unknown shared type tag ${JSON.stringify((value as { $y: unknown }).$y)}`,
      );
  }
}

/** Converts a value read from a Y.Map or Y.Array to the JSON form. */
export function dataValueFromY(value: unknown): DataValue {
  // Subclasses first: XmlText extends Text, XmlElement extends XmlFragment.
  if (value instanceof Y.XmlText || value instanceof Y.XmlElement)
    return xmlNodeFromY(value);
  if (value instanceof Y.Text) return { $y: "text", delta: deltaFromY(value) };
  if (value instanceof Y.XmlFragment) {
    return { $y: "xmlFragment", children: value.toArray().map(xmlNodeFromY) };
  }
  if (value instanceof Y.Map) {
    const entries: { [key: string]: DataValue } = {};
    for (const [key, item] of value.entries()) entries[key] = dataValueFromY(item);
    return { $y: "map", entries };
  }
  if (value instanceof Y.Array)
    return { $y: "array", items: value.toArray().map(dataValueFromY) };
  if (value instanceof Y.AbstractType)
    throw new Error("Unsupported shared type in element data");
  const json = cloneJson(value);
  // A plain object with a "$y" key of its own must be escaped to stay plain.
  if (isPlainObject(json) && "$y" in json) return { $y: "json", value: json };
  return json;
}

/** Converts a JSON-form shared text to a Y.Text (not yet attached to a document). */
export function textToY(delta: readonly TextRun[]): Y.Text {
  const text = new Y.Text();
  text.applyDelta(deltaToY(delta));
  return text;
}

/** Reads a Y.Text as a list of runs. */
export function textFromY(text: Y.Text): TextRun[] {
  return deltaFromY(text);
}
