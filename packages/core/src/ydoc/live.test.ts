// SPDX-License-Identifier: GPL-3.0-or-later

// The live resolver of a Y.Doc (section 11 of
// docs/adr/0001-document-model-and-file-format.md): what it reports for local
// changes, other replicas' updates (also out of causal order), undo and redo,
// tidy up and loading, and how long an update takes in a large document. Every
// case is also checked after every transaction against a new resolution of the
// whole document (watchLiveResolver).

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ResolvedChanges } from "../model/live.ts";
import { Resolver } from "../model/resolve.ts";
import { FRAME_TYPE, type DocumentSnapshot, type Element } from "../model/types.ts";
import { tidyUp } from "./document-ops.ts";
import { watchLiveResolver } from "./live-check.ts";
import { currentResolver, liveResolver } from "./live.ts";
import * as ops from "./ops.ts";
import { fromSnapshot, toSnapshot, yLookup } from "./snapshot.ts";
import { forkDoc, syncDocs, syncInto } from "./sync.ts";
import { createUndoManager } from "./track.ts";

const now = (): number =>
  (globalThis as unknown as { performance: { now(): number } }).performance.now();

const SHAPE = "galatsa.shapes/shape";

const failures: string[] = [];
const stops: (() => void)[] = [];
/** Watches a document's live resolver; failures are checked after each test. */
function watch(doc: Y.Doc, name: string): ResolvedChanges[] {
  const reports: ResolvedChanges[] = [];
  stops.push(watchLiveResolver(doc, (m) => failures.push(`${name}: ${m}`)));
  stops.push(liveResolver(doc).subscribe((c) => reports.push(c)));
  return reports;
}
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  expect(failures.splice(0)).toEqual([]);
});

function base(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 100;
  ops.initDocument(doc, { id: "d" });
  return doc;
}

const frame = (id: string, x: number, parent: string | null = null) => ({
  id,
  type: FRAME_TYPE,
  parent,
  x,
  y: x,
  size: { w: 300, h: 200 },
});
const shape = (id: string, parent: string | null, x = 5) => ({
  id,
  type: SHAPE,
  parent,
  x,
  y: x,
  size: { w: 5, h: 5 },
});

const union = (reports: ResolvedChanges[], key: "added" | "changed" | "removed") =>
  new Set(reports.flatMap((r) => [...r[key]]));

describe("the live resolver of a Y.Doc", () => {
  it("is one per document and follows local changes", () => {
    const doc = base();
    const reports = watch(doc, "doc");
    expect(liveResolver(doc)).toBe(liveResolver(doc));
    ops.addElement(doc, frame("F", 100));
    ops.addElement(doc, shape("X", "F"));
    expect(union(reports, "added")).toEqual(new Set(["F", "X"]));
    reports.length = 0;
    ops.moveElement(doc, "F", 200, 200);
    // The frame moved, and with it the world position of what is inside.
    expect(union(reports, "changed")).toEqual(new Set(["F", "X"]));
    expect(liveResolver(doc).worldOrigin("X")).toEqual({ x: 205, y: 205 });
    reports.length = 0;
    ops.deleteElements(doc, ["F"]);
    expect(union(reports, "changed")).toEqual(new Set(["F", "X"]));
    expect(liveResolver(doc).isGone("X")).toBe(true);
    expect(reports.some((r) => r.drawOrder)).toBe(true);
  });

  it("does not report the recording of work", () => {
    const doc = base();
    ops.addElement(doc, shape("X", null));
    const reports = watch(doc, "doc");
    ops.moveElement(doc, "X", 9, 9);
    // The move and its recording are two transactions; only the move counts.
    expect(reports.length).toBe(1);
    expect([...reports[0]!.changed]).toEqual(["X"]);
    expect(reports[0]!.drawOrder).toBe(false);
  });

  it("follows other replicas, also when a parent arrives after its child", () => {
    const start = base();
    const [a, b, c] = [1, 2, 3].map((client) => forkDoc(start, client)) as [
      Y.Doc,
      Y.Doc,
      Y.Doc,
    ];
    const reports = watch(c, "c");
    watch(a, "a");
    ops.addElement(b, frame("F", 100));
    syncInto(a, b);
    ops.addElement(a, shape("X", "F"));
    // C gets A's own changes without B's frame.
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    const live = liveResolver(c);
    expect(live.parentOf("X")).toBe(null);
    expect(live.worldOrigin("X")).toEqual({ x: 5, y: 5 });
    reports.length = 0;
    syncInto(c, b);
    expect(live.parentOf("X")).toBe("F");
    expect(live.worldOrigin("X")).toEqual({ x: 105, y: 105 });
    expect(union(reports, "added")).toEqual(new Set(["F"]));
    expect(union(reports, "changed")).toEqual(new Set(["X"]));
    expect(reports.some((r) => r.containers.has(null))).toBe(true);
  });

  it("follows a parent cycle and positions converted through another space", () => {
    const start = base();
    ops.addElement(start, frame("H", 100));
    ops.addElement(start, frame("F", 10, "H"));
    ops.addElement(start, frame("G", 1000));
    const a = forkDoc(start, 1);
    const b = forkDoc(start, 2);
    watch(a, "a");
    watch(b, "b");
    ops.reparent(a, "F", "G");
    ops.reparent(b, "G", "F");
    syncDocs(a, b);
    // Broken at F, which goes to the root; its position, written in H, is
    // converted from H (section 5.3, rule 3), so it follows H.
    const live = liveResolver(a);
    expect(live.parentOf("F")).toBe(null);
    expect(live.parentOf("G")).toBe("F");
    const reports = watch(a, "a again");
    ops.moveElement(a, "H", 150, 150);
    expect(union(reports, "changed")).toEqual(new Set(["H", "F", "G"]));
    reports.length = 0;
    ops.reparent(a, "G", null);
    expect(live.parentOf("F")).toBe("G");
    syncDocs(a, b);
    expect(new Resolver(yLookup(b)).parentOf("F")).toBe("G");
  });

  it("follows undo, redo and tidy up", () => {
    const doc = base();
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    ops.addElement(doc, frame("F", 100));
    ops.addElement(doc, shape("X", "F"));
    ops.addElement(doc, shape("Y", "F"));
    const reports = watch(doc, "doc");
    ops.deleteElements(doc, ["F"]);
    undo.undo();
    expect(liveResolver(doc).isGone("X")).toBe(false);
    undo.redo();
    expect(liveResolver(doc).isGone("X")).toBe(true);
    reports.length = 0;
    tidyUp(doc);
    // The shapes are deleted from the document; the frame becomes a place marker.
    expect(union(reports, "removed")).toEqual(new Set(["X", "Y"]));
    expect(union(reports, "changed")).toEqual(new Set(["F"]));
  });

  it("follows loading, into an empty document it already watches", () => {
    const source = base();
    ops.addElement(source, frame("F", 100));
    ops.addElement(source, shape("X", "F"));
    const doc = new Y.Doc();
    const reports = watch(doc, "doc");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    expect(union(reports, "added")).toEqual(new Set(["F", "X"]));
    const loaded = new Y.Doc();
    const more = watch(loaded, "loaded");
    fromSnapshot(toSnapshot(source), loaded);
    expect(union(more, "added")).toEqual(new Set(["F", "X"]));
  });

  it("is used by the operations only when it is up to date", () => {
    const doc = base();
    ops.addElement(doc, shape("X", null));
    expect(currentResolver(doc)).not.toBe(liveResolver(doc));
    const live = liveResolver(doc);
    expect(currentResolver(doc)).toBe(live);
    doc.transact(() => {
      expect(currentResolver(doc)).toBe(live);
      ops.moveElement(doc, "X", 3, 3);
      // A write in the open transaction: the live resolver does not show it yet.
      expect(currentResolver(doc)).not.toBe(live);
    });
    expect(currentResolver(doc)).toBe(live);
  });
});

/** A document of `frames` frames with `per` shapes each, built in one load. */
function largeDocument(frames: number, per: number): Y.Doc {
  const template = base();
  ops.addElement(template, frame("F", 0));
  ops.addElement(template, shape("X", "F"));
  const snapshot = toSnapshot(template);
  const elements: { [id: string]: Element } = {};
  const blank = { rev: {}, deleted: {} };
  for (let f = 0; f < frames; f++) {
    const id = `F${f}`;
    elements[id] = {
      ...snapshot.elements.F!,
      ...blank,
      order: `a${f.toString(36)}`,
      pos: { x: f * 400, y: 0, space: null },
    };
    for (let i = 0; i < per; i++) {
      elements[`X${f}_${i}`] = {
        ...snapshot.elements.X!,
        ...blank,
        parent: id,
        order: `a${i.toString(36)}`,
        pos: { x: i % 30, y: Math.floor(i / 30), space: id },
      };
    }
  }
  const big: DocumentSnapshot = { ...snapshot, elements };
  return fromSnapshot(big);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("the live resolver in a document of 5000 elements in 50 frames", () => {
  it("takes in a move in well under a millisecond", () => {
    const doc = largeDocument(50, 99);
    const live = liveResolver(doc);
    expect([...live.ids()].length).toBe(5000);
    // Time spent in the live resolver itself, per transaction.
    let spent = 0;
    const update = live.update.bind(live);
    live.update = (touched) => {
      const t = now();
      const changes = update(touched);
      spent += now() - t;
      return changes;
    };
    const measure = (fn: (i: number) => void, rounds: number): number[] => {
      const times: number[] = [];
      for (let i = 0; i < rounds; i++) {
        spent = 0;
        fn(i);
        times.push(spent);
      }
      return times;
    };
    // Warm up.
    measure((i) => ops.moveElement(doc, "X3_4", i, i), 50);
    const leaf = measure((i) => ops.moveElement(doc, `X${i % 50}_${i % 99}`, i, i), 300);
    const frameMove = measure((i) => ops.moveElement(doc, `F${i % 50}`, i * 3, 7), 300);
    expect(median(leaf)).toBeLessThan(1);
    expect(median(frameMove)).toBeLessThan(1);
    // The result is still right.
    const fresh = new Resolver(yLookup(doc));
    for (const id of ["X7_7", "F7", "X49_98"])
      expect(live.worldOrigin(id)).toEqual(fresh.worldOrigin(id));
    expect(live.drawOrder()).toEqual(fresh.drawOrder());
  });
});
