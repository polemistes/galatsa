// SPDX-License-Identifier: GPL-3.0-or-later

// The generic data encoding (section 3.4) and the snapshot conversion (section 2)
// of docs/adr/0001-document-model-and-file-format.md.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { InvalidDocumentError, validateSnapshot } from "../model/grammar.ts";
import type { DataValue, ElementData } from "../model/types.ts";
import { valueFromY, valueToY } from "./encode.ts";
import { addElement, initDocument, setData } from "./ops.ts";
import { fromSnapshot, toSnapshot } from "./snapshot.ts";
import { MergeIdentityError, forkDoc, syncDocs } from "./sync.ts";
import { buildSampleDocument } from "./testing.ts";

/** Every kind of value, as an element of an unknown type would carry. */
const EVERYTHING: ElementData = {
  number: -0.5,
  string: "plain",
  nothing: null,
  list: [1, "two", { three: 3 }, [{ $y: "not a tag inside plain JSON" }]],
  object: { nested: { deep: true } },
  escaped: { $y: "json", value: { $y: "text", delta: "this is plain data" } },
  text: {
    $y: "text",
    delta: [
      { insert: "Bold", attributes: { bold: true } },
      { insert: " and an embed " },
      { insert: { formula: "x^2" } },
      { insert: "\n", attributes: { align: "center" } },
    ],
  },
  map: {
    $y: "map",
    entries: {
      a: 1,
      inner: { $y: "map", entries: { t: { $y: "text", delta: [{ insert: "deep" }] } } },
    },
  },
  array: {
    $y: "array",
    items: [
      1,
      { $y: "text", delta: [{ insert: "in array" }] },
      { $y: "array", items: [] },
      { $y: "json", value: { $y: 5 } },
    ],
  },
  xml: {
    $y: "xmlFragment",
    children: [
      {
        $y: "xmlElement",
        name: "paragraph",
        attributes: { level: 1, style: { x: 1 } },
        children: [
          {
            $y: "xmlText",
            delta: [{ insert: "tree text", attributes: { italic: true } }],
          },
        ],
      },
      { $y: "xmlElement", name: "empty", attributes: {}, children: [] },
    ],
  },
  xmlElementAlone: {
    $y: "xmlElement",
    name: "figure",
    attributes: { src: "a" },
    children: [],
  },
  xmlTextAlone: { $y: "xmlText", delta: [{ insert: "lone" }] },
};

function roundTrip(data: ElementData): ElementData {
  const doc = new Y.Doc();
  const map = doc.getMap<unknown>("m");
  for (const [k, v] of Object.entries(data)) map.set(k, valueToY(v));
  // Through an update, as another replica would receive it.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const out: ElementData = {};
  for (const [k, v] of other.getMap<unknown>("m").entries()) out[k] = valueFromY(v);
  return out;
}

describe("generic data encoding", () => {
  it("round-trips every shared type, embeds, attributes and the $y escape", () => {
    expect(roundTrip(EVERYTHING)).toEqual(EVERYTHING);
  });

  it("escapes plain objects that carry a $y key", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("m");
    map.set("raw", { $y: "text", note: "stored as plain JSON by some extension" });
    const value = valueFromY(map.get("raw")) as DataValue;
    expect(value).toEqual({
      $y: "json",
      value: { $y: "text", note: "stored as plain JSON by some extension" },
    });
  });

  it("encodes values JSON cannot express losslessly, and rejects them as plain JSON input", () => {
    const sample = buildSampleDocument();
    expect(() => setData(sample, "shape", "bad", Number.NaN)).toThrow(
      InvalidDocumentError,
    );
    const doc = new Y.Doc();
    const m = doc.getMap<unknown>("m");
    m.set("bin", new Uint8Array([1, 2, 3]));
    m.set("u", undefined);
    m.set("nested", { list: [new Uint8Array([9]), undefined, 1] });
    const bin = valueFromY(m.get("bin"));
    expect(bin).toEqual({ $y: "any", value: { b: "AQID" } });
    expect(valueToY(bin)).toEqual(new Uint8Array([1, 2, 3]));
    expect(valueFromY(m.get("u"))).toEqual({ $y: "any", value: { u: 1 } });
    const nested = valueFromY(m.get("nested"));
    expect(valueToY(nested)).toEqual({ list: [new Uint8Array([9]), undefined, 1] });
  });
});

describe("snapshot conversion", () => {
  it("converts the sample document to JSON and back without change", () => {
    const doc = buildSampleDocument();
    const snapshot = toSnapshot(doc);
    expect(validateSnapshot(snapshot)).toEqual([]);
    expect(toSnapshot(fromSnapshot(snapshot))).toEqual(snapshot);
  });

  it("keeps an element of an unknown type unchanged", () => {
    const doc = new Y.Doc();
    initDocument(doc, { id: "d" });
    addElement(doc, {
      id: "u",
      type: "someone.else/widget",
      typeVersion: 7,
      x: 1,
      y: 2,
      size: { w: 3, h: 4 },
      data: EVERYTHING,
    });
    const snapshot = toSnapshot(doc);
    expect(snapshot.elements.u!.data).toEqual(EVERYTHING);
    expect(toSnapshot(fromSnapshot(snapshot)).elements.u).toEqual(snapshot.elements.u);
  });

  it("gives a rebuilt document fresh identity: it refuses to merge with the original", () => {
    const original = buildSampleDocument();
    const rebuilt = fromSnapshot(toSnapshot(original));
    const fork = forkDoc(original);
    expect(() => syncDocs(fork, rebuilt)).toThrow(MergeIdentityError);
  });
});
