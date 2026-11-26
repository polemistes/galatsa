// SPDX-License-Identifier: GPL-3.0-or-later

// Regression tests for the defects found in the third review, and for the
// decision that restoring counts as work. Each of these failed before the
// changes of that round (apart from the ones marked as guards, which pin down
// behaviour that no test did).

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { revisionDigest } from "../model/digest.ts";
import { copyFragment } from "../model/fragment.ts";
import { isValidOrderKey, keyAt, sortOrdered, type Ordered } from "../model/order.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { isRemoved, routeSteps, stopRegion } from "../model/route.ts";
import { FRAME_TYPE, SCHEMA_VERSION, type DocumentSnapshot } from "../model/types.ts";
import { importCopy, independentCopy, pasteFragment, tidyUp } from "./document-ops.ts";
import * as ops from "./ops.ts";
import { ORIGIN, raiseVersions, versionsOf } from "./schema.ts";
import { fromSnapshot, inspectDocument, toSnapshot, yLookup } from "./snapshot.ts";
import {
  canMerge,
  checkSync,
  forkDoc,
  neededVersion,
  syncDocs,
  syncHello,
} from "./sync.ts";
import { createUndoManager, trackWork } from "./track.ts";

/** The clock, without assuming a browser or Node. */
const now = (): number =>
  (globalThis as unknown as { performance: { now(): number } }).performance.now();
/** Bytes as text, one character per byte. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096)
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return out;
}

const SHAPE = "galatsa.shapes/shape";
const IMAGE = "galatsa.image/image";
const TEXT = "galatsa.text/text";
const H = `sha256-${"a".repeat(64)}` as const;
const RECT = { kind: "rect", space: null, x: 0, y: 0, w: 1, h: 1 } as const;
const ORDERS = [
  [1, 2],
  [2, 1],
] as const;

function base(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 100;
  ops.initDocument(doc, { id: "d" });
  return doc;
}
const vis = (doc: Y.Doc) => new Resolver(yLookup(doc)).drawOrder();
const world = (doc: Y.Doc, id: string) => new Resolver(yLookup(doc)).worldOrigin(id);
const stopGone = (doc: Y.Doc, id: string) => isRemoved(id, toSnapshot(doc).stops[id]!);
const shape = (id: string, parent: string | null = null, x = 1) => ({
  id,
  type: SHAPE,
  parent,
  x,
  y: x,
  size: { w: 5, h: 5 },
});
const frame = (id: string, x = 100) => ({
  id,
  type: FRAME_TYPE,
  x,
  y: x,
  size: { w: 300, h: 200 },
});

describe("review 3: every new visit to a stop is work on the stop", () => {
  for (const [ca, cb] of ORDERS) {
    const start = () => {
      const s = base();
      ops.addStop(s, { id: "S", view: RECT });
      ops.addRoute(s, { id: "R" });
      return s;
    };

    it(`redo of "add visit" keeps a stop that is removed concurrently (${ca}/${cb})`, () => {
      const s = start();
      const a = forkDoc(s, ca);
      const b = forkDoc(s, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      ops.insertRouteEntry(a, "R", "S");
      undo.undo();
      syncDocs(a, b);
      ops.removeStop(b, "S");
      undo.redo();
      syncDocs(a, b);
      expect(stopGone(a, "S")).toBe(false);
      expect(routeSteps(toSnapshot(b), "R").map((step) => step.stop)).toEqual(["S"]);
    });

    it(`undo of "remove visit" keeps the stop (${ca}/${cb})`, () => {
      const s = start();
      const entry = ops.insertRouteEntry(s, "R", "S");
      const a = forkDoc(s, ca);
      const b = forkDoc(s, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      ops.removeRouteEntry(a, "R", entry);
      syncDocs(a, b);
      ops.removeStop(b, "S");
      undo.undo();
      syncDocs(a, b);
      expect(stopGone(a, "S")).toBe(false);
    });

    it(`duplicating or restoring a route keeps the stops it visits (${ca}/${cb})`, () => {
      const s = start();
      ops.insertRouteEntry(s, "R", "S");
      ops.addStop(s, { id: "S2", view: RECT });
      ops.addRoute(s, { id: "R2" });
      ops.insertRouteEntry(s, "R2", "S2");
      ops.removeRoute(s, "R2");
      const a = forkDoc(s, ca);
      const b = forkDoc(s, cb);
      ops.removeRoute(b, "R");
      ops.removeStop(b, "S");
      ops.removeStop(b, "S2");
      const copy = pasteFragment(a, copyFragment(toSnapshot(a), [], [], ["R"]));
      ops.restoreRoute(a, "R2");
      syncDocs(a, b);
      const snapshot = toSnapshot(a);
      expect(stopGone(a, "S")).toBe(false);
      expect(stopGone(a, "S2")).toBe(false);
      expect(routeSteps(snapshot, copy.ids.get("R")!).length).toBe(1);
      expect(routeSteps(snapshot, "R2").length).toBe(1);
      expect(toSnapshot(b)).toEqual(snapshot);
    });

    it(`pointing a visit at another stop keeps that stop; reordering keeps none (${ca}/${cb})`, () => {
      const s = start();
      ops.addStop(s, { id: "S2", view: RECT });
      const entry = ops.insertRouteEntry(s, "R", "S");
      const a = forkDoc(s, ca);
      const b = forkDoc(s, cb);
      ops.removeStop(b, "S");
      ops.removeStop(b, "S2");
      ops.moveRouteEntry(a, "R", entry, 0);
      // What an editor does to retarget a visit: the same entry, another stop.
      const entries = a
        .getMap<Y.Map<unknown>>("routes")
        .get("R")!
        .get("entries") as Y.Map<unknown>;
      a.transact(
        () => entries.set(entry, { ...(entries.get(entry) as object), stop: "S2" }),
        ORIGIN.local,
      );
      syncDocs(a, b);
      expect(stopGone(a, "S")).toBe(true);
      expect(stopGone(a, "S2")).toBe(false);
    });
  }

  it("guard: a visit to a stop its user sees as removed does not bring it back", () => {
    const s = base();
    ops.addStop(s, { id: "S", view: RECT });
    ops.addRoute(s, { id: "R" });
    ops.removeStop(s, "S");
    ops.insertRouteEntry(s, "R", "S");
    expect(stopGone(s, "S")).toBe(true);
    expect(routeSteps(toSnapshot(s), "R")).toEqual([]);
  });
});

describe("review 3: restoring is work", () => {
  for (const [ca, cb] of ORDERS) {
    it(`a restore wins over an older delete that arrives later (${ca}/${cb})`, () => {
      const s = base();
      ops.addElement(s, frame("F"));
      ops.addElement(s, shape("X", "F"));
      ops.addStop(s, { id: "S", view: RECT });
      const a = forkDoc(s, ca);
      const b = forkDoc(s, 50);
      const c = forkDoc(s, cb);
      // C, offline, deletes the frame and removes the stop.
      ops.deleteElements(c, ["F"]);
      ops.removeStop(c, "S");
      ops.deleteElements(a, ["F"]);
      ops.removeStop(a, "S");
      syncDocs(a, b);
      // B takes both back, without knowing of C.
      ops.restoreElement(b, "F");
      ops.restoreStop(b, "S");
      syncDocs(a, b);
      syncDocs(a, c);
      syncDocs(b, c);
      syncDocs(a, b);
      expect(vis(a)).toEqual(["F", "X"]);
      expect(stopGone(a, "S")).toBe(false);
      expect(toSnapshot(c)).toEqual(toSnapshot(a));
    });

    it(`undoing a delete is a restore too (${ca}/${cb})`, () => {
      const s = base();
      ops.addElement(s, shape("X"));
      const a = forkDoc(s, ca);
      const c = forkDoc(s, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      ops.deleteElements(c, ["X"]);
      ops.deleteElements(a, ["X"]);
      undo.undo();
      syncDocs(a, c);
      expect(vis(a)).toEqual(["X"]);
      expect(vis(c)).toEqual(["X"]);
    });
  }

  it("guard: undoing one's own delete does not take back another user's delete one has seen", () => {
    const s = base();
    ops.addElement(s, frame("F"));
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    const undo = createUndoManager(a, { captureTimeout: 0 });
    ops.deleteElements(a, ["F"]);
    ops.deleteElements(b, ["F"]);
    syncDocs(a, b);
    undo.undo();
    syncDocs(a, b);
    expect(vis(b)).toEqual([]);
  });

  it("undo of a delete works after someone else restored it and undid that", () => {
    const s = base();
    ops.addElement(s, shape("X"));
    ops.addElement(s, shape("Y", null, 9));
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    const ua = createUndoManager(a, { captureTimeout: 0 });
    const ub = createUndoManager(b, { captureTimeout: 0 });
    ops.moveElement(b, "Y", 50, 50);
    ops.deleteElements(b, ["X"]);
    syncDocs(a, b);
    ops.restoreElement(a, "X");
    ua.undo();
    syncDocs(a, b);
    expect(vis(b)).toEqual(["Y"]);
    // One press undoes the delete: not nothing, and not the move before it.
    ub.undo();
    syncDocs(a, b);
    expect(vis(b)).toEqual(["X", "Y"]);
    expect(world(b, "Y")).toEqual({ x: 50, y: 50 });
    ub.redo();
    expect(vis(b)).toEqual(["Y"]);
    ub.undo();
    ub.undo();
    expect(world(b, "Y")).toEqual({ x: 9, y: 9 });
  });
});

describe("review 3: tidy up", () => {
  for (const reAdd of [false, true]) {
    it(`does not strand an asset that is ${reAdd ? "added again" : "duplicated"} concurrently`, () => {
      const start = base();
      ops.addAsset(start, H, { mediaType: "image/png", byteLength: 10 });
      ops.addElement(start, { ...shape("IMG"), type: IMAGE, data: { asset: H } });
      const a = forkDoc(start, 1);
      const b = forkDoc(start, 2);
      if (reAdd) {
        ops.addAsset(b, H, { mediaType: "image/png", byteLength: 10 });
        ops.addElement(b, { ...shape("IMG2"), type: IMAGE, data: { asset: H } });
      } else {
        pasteFragment(b, copyFragment(toSnapshot(b), ["IMG"]), { dx: 10, dy: 10 });
      }
      ops.deleteElements(a, ["IMG"]);
      expect(tidyUp(a).assets).toBe(1);
      expect(toSnapshot(a).assets).toEqual({});
      syncDocs(a, b);
      expect(toSnapshot(a).assets).toEqual({
        [H]: { mediaType: "image/png", byteLength: 10 },
      });
      expect(vis(a).length).toBe(1);
    });
  }

  it("removes the content of unknown root types", () => {
    const doc = base();
    const peer = forkDoc(doc, 7);
    peer.getMap("secret").set("payload", "x".repeat(1000));
    peer.getMap("secret").set("nested", new Y.Map([["deep", new Y.Text("hidden")]]));
    peer.getArray("more").push(["hidden"]);
    peer.getMap("elements"); // a known root keeps what belongs in it
    syncDocs(doc, peer);
    expect(inspectDocument(doc).problems).toEqual([
      "root secret: unknown root type",
      "root more: unknown root type",
    ]);
    expect(tidyUp(doc).other).toBe(2);
    expect(doc.getMap("secret").size).toBe(0);
    expect(doc.getArray("more").length).toBe(0);
    expect(inspectDocument(doc).problems).toEqual([]);
    expect(latin1(Y.encodeStateAsUpdate(forkDoc(doc, 9)))).not.toContain("xxxxxxxx");
  });

  for (const [ca, cb] of ORDERS) {
    it(`a frame removed with "keep contents" and tidied never comes back hollow (${ca}/${cb})`, () => {
      const s = base();
      ops.addElement(s, {
        ...frame("F"),
        name: "Intro",
        data: { fill: "#f00", clip: true },
      });
      ops.addElement(s, shape("X", "F"));
      const a = forkDoc(s, ca);
      const b = forkDoc(s, cb);
      const c = forkDoc(s, 9);
      const undo = createUndoManager(b, { captureTimeout: 0 });
      ops.dissolve(b, "F");
      syncDocs(a, b);
      syncDocs(a, c);
      tidyUp(a);
      // Undo after the tidy arrived, and an offline restore that did not know.
      syncDocs(a, b);
      undo.undo();
      ops.restoreElement(c, "F");
      syncDocs(a, b);
      syncDocs(a, c);
      syncDocs(a, b);
      const marker = toSnapshot(a).elements.F!;
      expect(marker).toMatchObject({ purged: true, name: "", data: {} });
      expect(vis(a)).toEqual(["X"]);
      expect(world(a, "X")).toEqual({ x: 101, y: 101 });
      expect(toSnapshot(b)).toEqual(toSnapshot(a));
    });
  }

  it("keeps a delete whose listed work has not arrived yet", () => {
    const s = base();
    ops.addElement(s, shape("X"));
    ops.addElement(s, frame("F"));
    ops.addElement(s, shape("Y", "F"));
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    const c = forkDoc(s, 3);
    ops.moveElement(c, "X", 5, 5);
    ops.moveElement(c, "Y", 6, 6);
    syncDocs(b, c);
    // B deletes both, having seen everything.
    ops.deleteElements(b, ["X", "F"]);
    // A receives B's changes before C's (they travel separately).
    const have = Y.encodeStateVector(a);
    const fromB = Y.diffUpdate(
      Y.encodeStateAsUpdate(b, have),
      Y.encodeStateVectorFromUpdate(Y.encodeStateAsUpdate(c, have)),
    );
    Y.applyUpdate(a, fromB, "sync");
    // To A, the deletes list revisions X and Y do not have yet: nothing of
    // them is hidden. Tidy up must not take that for a delete that failed.
    expect(vis(a)).toEqual(["X", "Y"]);
    tidyUp(a);
    syncDocs(a, c);
    syncDocs(a, b);
    syncDocs(b, c);
    expect(vis(a)).toEqual([]);
    expect(vis(c)).toEqual([]);
  });

  it("guard: rewrites nothing it keeps", () => {
    const s = base();
    ops.addElement(s, frame("F"));
    ops.addElement(s, frame("G", 500));
    ops.addElement(s, shape("X", "F"));
    ops.addElement(s, shape("Y", "G"));
    const b = forkDoc(s, 2);
    ops.addElement(b, shape("N", "G", 7));
    ops.deleteElements(s, ["G"]);
    ops.dissolve(s, "F");
    syncDocs(s, b);
    const items = (doc: Y.Doc) =>
      [...doc.getMap<Y.Map<unknown>>("elements").entries()].map(([id, record]) => [
        id,
        ...["type", "parent", "order", "pos", "rebase", "size", "dissolved", "rev"].map(
          (key) => {
            const item = record._map.get(key);
            return item ? `${item.id.client}:${item.id.clock}` : "-";
          },
        ),
      ]);
    const before = new Map(items(s).map(([id, ...rest]) => [id, rest.join(" ")]));
    tidyUp(s);
    expect(vis(s)).toEqual(["X", "N"]);
    for (const [id, ...rest] of items(s))
      expect(rest.join(" "), id).toBe(before.get(id as string));
    // Tidying again changes nothing at all.
    const state = Y.encodeStateAsUpdate(s);
    expect(tidyUp(s)).toEqual({
      elements: 0,
      containers: 0,
      stops: 0,
      routes: 0,
      assets: 0,
      other: 0,
    });
    expect(Y.encodeStateAsUpdate(s)).toEqual(state);
  });
});

describe("review 3: delete marks", () => {
  it("do not grow with the number of sessions that worked on what they list", () => {
    const s = base();
    ops.addElement(s, frame("F"));
    for (let i = 0; i < 200; i++) ops.addElement(s, shape(`E${i}`, "F", i));
    const snapshot = JSON.parse(JSON.stringify(toSnapshot(s))) as DocumentSnapshot;
    for (const id of Object.keys(snapshot.elements)) {
      const rev: Record<string, number> = {};
      for (let w = 0; w < 100; w++)
        rev[`w${String(w).padStart(10, "0")}.0`] = 1 + ((w * 7) % 8);
      snapshot.elements[id]!.rev = rev;
    }
    const mature = fromSnapshot(snapshot);
    const before = Y.encodeStateAsUpdate(mature).length;
    ops.deleteElements(mature, ["F"]);
    const mark = Object.values(toSnapshot(mature).elements.F!.deleted)[0]!;
    expect(Object.keys(mark.seen).length).toBe(201);
    expect(mark.seen.E7).toBe(revisionDigest(snapshot.elements.E7!.rev));
    // About 25 bytes for each element listed, whatever its history (it was 317 kB).
    expect(Y.encodeStateAsUpdate(mature).length - before).toBeLessThan(8000);
  });

  it("a mark that is there costs nothing per transaction, however much it lists", () => {
    const small = base();
    ops.addElement(small, frame("F"));
    ops.addElement(small, {
      ...shape("T", "F"),
      type: TEXT,
      data: { text: { $y: "text", delta: [] } },
    });
    ops.addElement(small, shape("E0", "F"));
    const snapshot = toSnapshot(small);
    for (let i = 1; i < 3000; i++) snapshot.elements[`E${i}`] = snapshot.elements.E0!;
    const s = fromSnapshot(snapshot);
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    // A delete of the frame that a concurrent rename defeats: the mark stays.
    ops.deleteElements(b, ["F"]);
    ops.renameElement(a, "F", "kept");
    syncDocs(a, b);
    expect(vis(a).length).toBe(3002);
    const marks = a.getMap<Y.Map<unknown>>("elements").get("F")!.get("deleted") as Y.Map<
      Y.Map<unknown>
    >;
    const stored = () => [...marks.values()][0]?.get("seen");
    expect(Object.keys(stored() as object).length).toBe(3002);
    const text = ops.dataMap(a, "T").get("text") as Y.Text;
    for (let i = 0; i < 20; i++)
      a.transact(() => text.insert(text.length, "a"), "binding");
    const start = now();
    for (let i = 0; i < 300; i++)
      a.transact(() => text.insert(text.length, "a"), "binding");
    for (let i = 0; i < 100; i++) ops.moveElement(a, "E7", i, i);
    const perStep = (now() - start) / 400;
    // It was 6.5 ms per step; this bound still fails if the mark is read again
    // on every transaction.
    expect(perStep).toBeLessThan(1);
    // Work on the frame itself removes the mark, which can never apply again.
    ops.renameElement(a, "F", "again");
    expect(toSnapshot(a).elements.F!.deleted).toEqual({});
  });

  it("guard: a revision never repeats, also when a writer's counter runs out", () => {
    const s = base();
    ops.addElement(s, shape("X"));
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      ops.moveElement(s, "X", i, i);
      const rev = toSnapshot(s).elements.X!.rev;
      const digest = revisionDigest(rev);
      expect(seen.has(digest), JSON.stringify(rev)).toBe(false);
      seen.add(digest);
    }
  });

  it("guard: writing the value that is already there is not work", () => {
    const s = base();
    ops.addElement(s, shape("X"));
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    ops.deleteElements(a, ["X"]);
    ops.setLocked(b, "X", false);
    ops.moveElement(b, "X", 1, 1);
    syncDocs(a, b);
    expect(vis(a)).toEqual([]);
  });
});

describe("review 3: commands that create", () => {
  it("creating inside another transaction is refused; a group of operations is one undo step", () => {
    const s = base();
    ops.addElement(s, shape("X", null, 500));
    const a = forkDoc(s, 1);
    const b = forkDoc(s, 2);
    const undo = createUndoManager(a, { captureTimeout: 0 });
    // Composed in one transaction, undo would delete the new frame for good.
    expect(() =>
      a.transact(() => {
        ops.addElement(a, frame("F", 400));
        ops.reparent(a, "X", "F");
      }, ORIGIN.local),
    ).toThrow(/group\(\)/);
    expect(a.getMap("elements").has("F")).toBe(false);
    expect(() => a.transact(() => ops.addStop(a, { view: RECT }))).toThrow(/group\(\)/);
    expect(() => a.transact(() => ops.group(a, ["X"]), "my-command")).toThrow(
      /group\(\)/,
    );
    expect(() =>
      a.transact(
        () => pasteFragment(a, copyFragment(toSnapshot(a), ["X"])),
        ORIGIN.local,
      ),
    ).toThrow(/group\(\)/);

    // The way to do it: one undo step, whatever the capture timeout.
    undo.group(() => {
      ops.addElement(a, frame("F", 400));
      ops.reparent(a, "X", "F");
      ops.renameElement(a, "F", "New");
    });
    expect(undo.undoStack.length).toBe(1);
    syncDocs(a, b);
    // Meanwhile B works inside the new frame.
    ops.addElement(b, shape("Y", "F", 10));
    ops.renameElement(b, "F", "B's name");
    undo.undo();
    syncDocs(a, b);
    // The frame is removed softly: B's work is where it was, and kept.
    expect(a.getMap("elements").has("F")).toBe(true);
    expect(toSnapshot(a).elements.F!.name).toBe("B's name");
    expect(vis(a)).toEqual(["X", "F", "Y"]);
    expect(world(a, "Y")).toEqual({ x: 410, y: 410 });
    expect(world(a, "X")).toEqual({ x: 500, y: 500 });
    expect(new Resolver(yLookup(a)).parentOf("X")).toBe(null);
    undo.redo();
    expect(new Resolver(yLookup(a)).parentOf("X")).toBe("F");
    expect(undo.undoStack.length).toBe(1);
  });
});

describe("review 3: importing a copy", () => {
  it("keeps what a frame stop shows when its frame is gone", () => {
    const s = base();
    ops.addElement(s, frame("F"));
    ops.addElement(s, frame("G", 1000));
    ops.addElement(s, frame("Live", 3000));
    for (const [id, target] of [
      ["S", "F"],
      ["S2", "G"],
      ["S3", "Live"],
    ] as const) {
      ops.addStop(s, { id, view: { kind: "frame", frame: target, padding: 0 } });
    }
    ops.addRoute(s, { id: "R" });
    for (const id of ["S3", "S", "S2", "S"]) ops.insertRouteEntry(s, "R", id);
    ops.deleteElements(s, ["F"]);
    ops.dissolve(s, "G");
    tidyUp(s);
    const snapshot = toSnapshot(s);
    const target = base();
    const copy = importCopy(target, snapshot, { dx: 10_000 });
    const imported = toSnapshot(target);
    const view = new Resolver(lookupFromRecord(imported.elements));
    const steps = routeSteps(imported, copy.ids.get("R")!);
    expect(steps.map((step) => step.stop)).toEqual(
      ["S3", "S", "S2", "S"].map((id) => copy.ids.get(id)),
    );
    const shown = (id: string) => {
      const region = stopRegion(imported, view, copy.ids.get(id)!)!;
      const origin = view.spaceOrigin(region.space);
      return {
        x: origin.x + region.rect.x,
        y: origin.y + region.rect.y,
        w: region.rect.w,
      };
    };
    expect(shown("S")).toEqual({ x: 10_100, y: 100, w: 300 });
    expect(shown("S2")).toEqual({ x: 11_000, y: 1000, w: 300 });
    expect(shown("S3")).toEqual({ x: 13_000, y: 3000, w: 300 });
    expect(imported.stops[copy.ids.get("S")!]!.view.kind).toBe("rect");
    expect(imported.stops[copy.ids.get("S3")!]!.view).toMatchObject({
      kind: "frame",
      frame: copy.ids.get("Live"),
    });
  });

  it("a document can be saved as an independent copy", () => {
    const s = base();
    ops.addElement(s, shape("X"));
    ops.addElement(s, shape("Gone"));
    ops.deleteElements(s, ["Gone"]);
    const copy = independentCopy(s);
    expect(toSnapshot(copy).id).not.toBe("d");
    expect(toSnapshot(copy).elements).toEqual(toSnapshot(s).elements);
    expect(canMerge(copy, s)).toBe(false);
    expect(Object.keys(toSnapshot(independentCopy(s, { purge: true })).elements)).toEqual(
      ["X"],
    );
  });
});

describe("review 3: versions, blank replicas, order keys, references", () => {
  it("the versions a document needs only ever rise", () => {
    const s = base();
    for (const [x, y] of ORDERS) {
      const a = forkDoc(s, x);
      const b = forkDoc(s, y);
      raiseVersions(a, { minReaderVersion: 3 });
      raiseVersions(b, { minReaderVersion: 2, schemaVersion: 5 });
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      for (const doc of [a, b]) {
        expect(neededVersion(doc)).toBe(3);
        expect(versionsOf(doc)).toEqual({ schemaVersion: 5, minReaderVersion: 3 });
        expect(toSnapshot(doc)).toMatchObject({ schemaVersion: 5, minReaderVersion: 3 });
        expect(inspectDocument(doc).problems).toEqual([]);
      }
      // A faulty writer that sets the old key to something lower changes nothing.
      a.getMap("meta").set("minReaderVersion", 1);
      expect(neededVersion(a)).toBe(3);
      // Raising to less than it is does nothing.
      const state = Y.encodeStateAsUpdate(a);
      raiseVersions(a, { minReaderVersion: 2 });
      expect(Y.encodeStateAsUpdate(a)).toEqual(state);
      expect(() => ops.moveElement(a, "X", 1, 1)).toThrow(/version/);
      void SCHEMA_VERSION;
    }
  });

  it("a replica that is not a document yet refuses operations, and can still join", () => {
    const server = base();
    ops.addElement(server, shape("X"));
    const client = new Y.Doc();
    trackWork(client);
    expect(() => ops.addElement(client, shape("Mine"))).toThrow(/not initialized/);
    expect(() => ops.addStop(client, { view: RECT })).toThrow(/not initialized/);
    expect(() => tidyUp(client)).toThrow(/not initialized/);
    expect(checkSync(client, syncHello(server))).toBe("ok");
    syncDocs(client, server);
    ops.moveElement(client, "X", 9, 9);
    syncDocs(client, server);
    expect(world(server, "X")).toEqual({ x: 9, y: 9 });
  });

  it("order keys never leave the syntax, however often something is inserted at one spot", () => {
    // The generator alone: it hands out valid keys or says that there is no room.
    let list: Ordered[] = [{ id: "a", order: keyAt([], 0) }];
    list.push({ id: "b", order: keyAt(list, 1) });
    let stopped = -1;
    for (let i = 0; i < 9000 && stopped < 0; i++) {
      let key: string;
      try {
        key = keyAt(list, 1);
      } catch {
        stopped = i;
        break;
      }
      expect(isValidOrderKey(key)).toBe(true);
      list = sortOrdered([...list, { id: `n${String(i).padStart(6, "0")}`, order: key }]);
      if (list.length > 6) list = [list[0]!, list[1]!, list[2]!, list[list.length - 1]!];
    }
    expect(stopped).toBeGreaterThan(5000);

    // The operations re-key a list before its keys get long.
    const s = base();
    for (const id of ["A", "B", "C"]) ops.addElement(s, shape(id));
    const long = `a5${"V".repeat(200)}`;
    s.transact(() => {
      s.getMap<Y.Map<unknown>>("elements").get("B")!.set("order", `${long}1`);
      s.getMap<Y.Map<unknown>>("elements").get("C")!.set("order", `${long}2`);
    }, "peer");
    ops.deleteElements(s, ["B"]);
    const other = forkDoc(s, 2);
    const revBefore = toSnapshot(s).elements.C!.rev;
    ops.addElement(s, { ...shape("N"), index: 1 });
    const elements = toSnapshot(s).elements;
    expect(vis(s)).toEqual(["A", "N", "C"]);
    for (const id of ["A", "B", "C", "N"])
      expect(elements[id]!.order.length).toBeLessThan(10);
    // Re-keying is not work on the elements it touches: B stays deleted, also
    // against a peer that did not see the re-keying.
    expect(elements.C!.rev).toEqual(revBefore);
    expect(new Resolver(yLookup(s)).isDeleted("B")).toBe(true);
    ops.bringToFront(other, "A");
    syncDocs(s, other);
    expect(new Resolver(yLookup(s)).isDeleted("B")).toBe(true);
    expect(inspectDocument(s).problems).toEqual([]);

    // The same for the visits of a route and for the list of routes.
    ops.addStop(s, { id: "S", view: RECT });
    ops.addRoute(s, { id: "R" });
    const first = ops.insertRouteEntry(s, "R", "S");
    const entries = s
      .getMap<Y.Map<unknown>>("routes")
      .get("R")!
      .get("entries") as Y.Map<unknown>;
    s.transact(() => entries.set(first, { stop: "S", order: `${long}1` }), "peer");
    s.transact(
      () => s.getMap<Y.Map<unknown>>("routes").get("R")!.set("order", `${long}1`),
      "peer",
    );
    ops.insertRouteEntry(s, "R", "S");
    ops.addRoute(s, { id: "R2" });
    const after = toSnapshot(s);
    expect(routeSteps(after, "R").map((step) => step.entry)[0]).toBe(first);
    for (const entry of Object.values(after.routes.R!.entries))
      expect(entry.order.length).toBeLessThan(10);
    expect(after.routes.R!.order.length).toBeLessThan(10);
    expect(inspectDocument(s).problems).toEqual([]);
  });

  it("references are a set: two users adding different ones both keep theirs", () => {
    const s = base();
    for (const id of ["A", "B", "C"]) ops.addElement(s, shape(id));
    ops.addElement(s, { ...shape("Link"), refs: ["A"] });
    for (const [x, y] of ORDERS) {
      const a = forkDoc(s, x);
      const b = forkDoc(s, y);
      ops.setRefs(a, "Link", ["A", "B"]);
      ops.setRefs(b, "Link", ["C", "A"]);
      syncDocs(a, b);
      expect(toSnapshot(a).elements.Link!.refs).toEqual(["A", "B", "C"]);
      ops.setRefs(a, "Link", ["C"]);
      syncDocs(a, b);
      expect(toSnapshot(b).elements.Link!.refs).toEqual(["C"]);
    }
  });
});
