// SPDX-License-Identifier: GPL-3.0-or-later

// Two replicas edit the same element concurrently, then exchange updates. For
// every element type: edits to different parts are all kept, and a conflict on
// the same key converges to one of the two values on both replicas. Section 3.4
// and 15 of docs/adr/0001-document-model-and-file-format.md.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DocumentSnapshot, Json } from "../model/types.ts";
import {
  dataMap,
  edit,
  moveElement,
  renameElement,
  resizeElement,
  rotateElement,
  setData,
} from "./ops.ts";
import { toSnapshot } from "./snapshot.ts";
import { forkDoc, syncDocs } from "./sync.ts";
import { SAMPLE, buildSampleDocument } from "./testing.ts";

/** Two replicas of the sample document with fixed client ids. */
function replicas(): [Y.Doc, Y.Doc] {
  const base = buildSampleDocument();
  return [forkDoc(base, 1), forkDoc(base, 2)];
}

/** Syncs both ways and checks that the replicas agree; returns the merged state. */
function merge(a: Y.Doc, b: Y.Doc): DocumentSnapshot {
  syncDocs(a, b);
  const sa = toSnapshot(a);
  expect(toSnapshot(b)).toEqual(sa);
  return sa;
}

function data(snapshot: DocumentSnapshot, id: string): Record<string, unknown> {
  return snapshot.elements[id]!.data as Record<string, unknown>;
}

function text(value: unknown): string {
  const delta = (value as { delta: Array<{ insert: unknown }> }).delta;
  return delta.map((run) => (typeof run.insert === "string" ? run.insert : "")).join("");
}

describe("concurrent edits of each element type", () => {
  it("frame: rename and recolour are both kept; concurrent resizes converge", () => {
    const [a, b] = replicas();
    renameElement(a, SAMPLE.frame, "Opening");
    setData(b, SAMPLE.frame, "fill", "#000000");
    resizeElement(a, SAMPLE.frame, 1000, 500);
    resizeElement(b, SAMPLE.frame, 2000, 1000);
    const s = merge(a, b);
    const frame = s.elements[SAMPLE.frame]!;
    expect(frame.name).toBe("Opening");
    expect(frame.data.fill).toBe("#000000");
    expect([
      { w: 1000, h: 500 },
      { w: 2000, h: 1000 },
    ]).toContainEqual((frame as { size: unknown }).size);
  });

  it("group: move and rename are both kept", () => {
    const [a, b] = replicas();
    moveElement(a, SAMPLE.group, 3100, 50);
    renameElement(b, SAMPLE.group, "Pair");
    const s = merge(a, b);
    expect(s.elements[SAMPLE.group]!.pos).toEqual({ x: 3100, y: 50, space: null });
    expect(s.elements[SAMPLE.group]!.name).toBe("Pair");
  });

  it("text: concurrent typing at both ends, formatting and a style change are all kept", () => {
    const [a, b] = replicas();
    edit(a, () => (dataMap(a, SAMPLE.text).get("text") as Y.Text).insert(0, "Well, "));
    edit(b, () => {
      const t = dataMap(b, SAMPLE.text).get("text") as Y.Text;
      t.insert(t.length - 1, "!");
      t.format(6, 5, { italic: true });
    });
    setData(b, SAMPLE.text, "fontSize", 64);
    const s = merge(a, b);
    const d = data(s, SAMPLE.text);
    expect(text(d.text)).toBe("Well, Hello world!\n");
    expect(JSON.stringify(d.text)).toContain('"italic":true');
    expect(JSON.stringify(d.text)).toContain('"bold":true');
    expect(d.fontSize).toBe(64);
  });

  it("text: concurrent typing at the same place keeps both insertions", () => {
    const [a, b] = replicas();
    edit(a, () => (dataMap(a, SAMPLE.text).get("text") as Y.Text).insert(5, " there"));
    edit(b, () => (dataMap(b, SAMPLE.text).get("text") as Y.Text).insert(5, " dear"));
    const s = merge(a, b);
    const merged = text(data(s, SAMPLE.text).text);
    expect(merged).toContain(" there");
    expect(merged).toContain(" dear");
    expect(merged.startsWith("Hello")).toBe(true);
  });

  it("shape: fill and stroke changed by different users are both kept", () => {
    const [a, b] = replicas();
    setData(a, SAMPLE.shape, "fill", "#123456");
    setData(b, SAMPLE.shape, "stroke", "#654321");
    const s = merge(a, b);
    expect(data(s, SAMPLE.shape).fill).toBe("#123456");
    expect(data(s, SAMPLE.shape).stroke).toBe("#654321");
  });

  it("image: crop and opacity are both kept; two crops never mix", () => {
    const [a, b] = replicas();
    setData(a, SAMPLE.image, "crop", { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    setData(b, SAMPLE.image, "opacity", 0.5);
    let s = merge(a, b);
    expect(data(s, SAMPLE.image).crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(data(s, SAMPLE.image).opacity).toBe(0.5);

    const cropA: Json = { x: 0, y: 0, w: 0.3, h: 0.3 };
    const cropB: Json = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    setData(a, SAMPLE.image, "crop", cropA);
    setData(b, SAMPLE.image, "crop", cropB);
    s = merge(a, b);
    expect([cropA, cropB]).toContainEqual(data(s, SAMPLE.image).crop);
  });

  it("freehand: strokes drawn at the same time by two users are all kept", () => {
    const [a, b] = replicas();
    edit(a, () =>
      (dataMap(a, SAMPLE.freehand).get("strokes") as Y.Array<unknown>).push([
        { points: [1, 1, 2, 2], color: "#f00", width: 1 },
      ]),
    );
    edit(b, () =>
      (dataMap(b, SAMPLE.freehand).get("strokes") as Y.Array<unknown>).push([
        { points: [3, 3, 4, 4], color: "#0f0", width: 1 },
      ]),
    );
    const s = merge(a, b);
    const items = (
      data(s, SAMPLE.freehand).strokes as { items: Array<{ color: string }> }
    ).items;
    expect(items).toHaveLength(3);
    expect(items.map((stroke) => stroke.color).sort()).toEqual([
      "#000000",
      "#0f0",
      "#f00",
    ]);
  });

  it("table: a new row, a new column and a cell edit made at the same time are all kept", () => {
    const [a, b] = replicas();
    edit(a, () => {
      const d = dataMap(a, SAMPLE.table);
      (d.get("rows") as Y.Map<unknown>).set("r2", { order: "a1", size: 30 });
      const cell = new Y.Text();
      (d.get("cells") as Y.Map<unknown>).set("r2:c1", cell);
      cell.insert(0, "A2");
    });
    edit(b, () => {
      const d = dataMap(b, SAMPLE.table);
      (d.get("cols") as Y.Map<unknown>).set("c2", { order: "a1", size: 100 });
      ((d.get("cells") as Y.Map<unknown>).get("r1:c1") as Y.Text).insert(2, "!");
    });
    const s = merge(a, b);
    const d = data(s, SAMPLE.table) as Record<
      string,
      { entries: Record<string, unknown> }
    >;
    expect(Object.keys(d.rows!.entries).sort()).toEqual(["r1", "r2"]);
    expect(Object.keys(d.cols!.entries).sort()).toEqual(["c1", "c2"]);
    expect(text(d.cells!.entries["r1:c1"])).toBe("A1!");
    expect(text(d.cells!.entries["r2:c1"])).toBe("A2");
  });

  it("chart: values of different categories, a new series and options are all kept", () => {
    const [a, b] = replicas();
    edit(a, () => {
      const s1 = (dataMap(a, SAMPLE.chart).get("series") as Y.Map<Y.Map<unknown>>).get(
        "s1",
      )!;
      (s1.get("values") as Y.Map<unknown>).set("c1", 10);
    });
    edit(b, () => {
      const series = dataMap(b, SAMPLE.chart).get("series") as Y.Map<Y.Map<unknown>>;
      (series.get("s1")!.get("values") as Y.Map<unknown>).set("c2", 20);
      const s2 = new Y.Map<unknown>();
      series.set("s2", s2);
      s2.set("name", "Costs");
      s2.set("order", "a1");
      s2.set("values", new Y.Map<unknown>());
    });
    setData(b, SAMPLE.chart, "options", { legend: false });
    const s = merge(a, b);
    const series = (
      data(s, SAMPLE.chart).series as {
        entries: Record<string, { entries: Record<string, unknown> }>;
      }
    ).entries;
    expect((series.s1!.entries.values as { entries: unknown }).entries).toEqual({
      c1: 10,
      c2: 20,
    });
    expect(series.s2!.entries.name).toBe("Costs");
    expect(data(s, SAMPLE.chart).options).toEqual({ legend: false });
  });

  it("map: a new feature, a label edit and a view change are all kept", () => {
    const [a, b] = replicas();
    edit(a, () => {
      const f2 = new Y.Map<unknown>();
      (dataMap(a, SAMPLE.map).get("features") as Y.Map<unknown>).set("f2", f2);
      f2.set("kind", "battle");
      f2.set("geometry", { type: "Point", coordinates: [5, 5] });
    });
    edit(b, () => {
      const f1 = (dataMap(b, SAMPLE.map).get("features") as Y.Map<Y.Map<unknown>>).get(
        "f1",
      )!;
      (f1.get("label") as Y.Text).insert(4, " (capital)");
    });
    setData(b, SAMPLE.map, "view", {
      projection: "mercator",
      center: [11, 61],
      scale: 2000,
    });
    const s = merge(a, b);
    const features = (
      data(s, SAMPLE.map).features as {
        entries: Record<string, { entries: Record<string, unknown> }>;
      }
    ).entries;
    expect(Object.keys(features).sort()).toEqual(["f1", "f2"]);
    expect(text(features.f1!.entries.label)).toBe("Oslo (capital)");
    expect(data(s, SAMPLE.map).view).toEqual({
      projection: "mercator",
      center: [11, 61],
      scale: 2000,
    });
  });

  it("media: trim and loop are both kept; two trims never mix", () => {
    const [a, b] = replicas();
    setData(a, SAMPLE.media, "trim", { start: 2, end: 8 });
    setData(b, SAMPLE.media, "loop", true);
    let s = merge(a, b);
    expect(data(s, SAMPLE.media).trim).toEqual({ start: 2, end: 8 });
    expect(data(s, SAMPLE.media).loop).toBe(true);
    setData(a, SAMPLE.media, "trim", { start: 1, end: 2 });
    setData(b, SAMPLE.media, "trim", { start: 5, end: 9 });
    s = merge(a, b);
    expect([
      { start: 1, end: 2 },
      { start: 5, end: 9 },
    ]).toContainEqual(data(s, SAMPLE.media).trim);
  });

  it("envelope: a move, a resize and a rotation by different users are all kept", () => {
    const [a, b] = replicas();
    moveElement(a, SAMPLE.shape, 2100, 10);
    resizeElement(b, SAMPLE.shape, 300, 150);
    rotateElement(b, SAMPLE.shape, Math.PI / 4);
    const s = merge(a, b);
    const shape = s.elements[SAMPLE.shape] as {
      pos: unknown;
      size: unknown;
      rot: number;
    };
    expect(shape.pos).toEqual({ x: 2100, y: 10, space: null });
    expect(shape.size).toEqual({ w: 300, h: 150 });
    expect(shape.rot).toBeCloseTo(Math.PI / 4);
  });

  it("envelope: two concurrent moves give one of the two positions, never a mix", () => {
    const [a, b] = replicas();
    moveElement(a, SAMPLE.shape, 1, 2);
    moveElement(b, SAMPLE.shape, 3, 4);
    const s = merge(a, b);
    expect([
      { x: 1, y: 2, space: null },
      { x: 3, y: 4, space: null },
    ]).toContainEqual(s.elements[SAMPLE.shape]!.pos);
  });
});
