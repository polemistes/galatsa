// SPDX-License-Identifier: GPL-3.0-or-later

// Regression tests for the defects found in the second review. Each of these
// failed before the change that introduced the path rule for deletes, the work
// tracker, the shared grammar and place markers left by tidy up.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { copyFragment } from "../model/fragment.ts";
import { InvalidDocumentError, MAX_DEPTH, nestingDepth, validateSnapshot } from "../model/grammar.ts";
import { Resolver } from "../model/resolve.ts";
import { hiddenAt, routeSteps } from "../model/route.ts";
import { FRAME_TYPE, SCHEMA_VERSION } from "../model/types.ts";
import { importCopy, pasteFragment, tidyUp } from "./document-ops.ts";
import {
  addElement,
  addRoute,
  addStop,
  dataMap,
  deleteElements,
  dissolve,
  group,
  initDocument,
  insertRouteEntry,
  moveElement,
  moveRouteEntry,
  removeStop,
  renameElement,
  reparent,
  resizeElement,
  setLocked,
  stopNotes,
} from "./ops.ts";
import { NewerVersionError } from "./schema.ts";
import { fromSnapshot, inspectDocument, toSnapshot, yLookup } from "./snapshot.ts";
import {
  MergeIdentityError,
  canMerge,
  checkSync,
  forkDoc,
  syncDocs,
  syncHello,
  watchVersion,
} from "./sync.ts";
import { seededOptions } from "./testing.ts";
import { createUndoManager } from "./track.ts";

const SHAPE = "galatsa.shapes/shape";
const TEXT = "galatsa.text/text";
const ORDERS = [
  [1, 2],
  [2, 1],
] as const;
const R = (d: Y.Doc) => new Resolver(yLookup(d));
const visible = (d: Y.Doc, id: string) => !R(d).isGone(id);
const BINDING = "editor-binding";

/** Frame F at (1000, 1000) holding shapes X and Y and a text T. */
function base(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 100;
  const o = seededOptions(7);
  initDocument(doc, { id: "base" }, o);
  addElement(
    doc,
    { id: "F", type: FRAME_TYPE, x: 1000, y: 1000, size: { w: 800, h: 600 } },
    o,
  );
  for (const [id, x] of [
    ["X", 10],
    ["Y", 50],
  ] as const) {
    addElement(
      doc,
      { id, type: SHAPE, parent: "F", x, y: 10, size: { w: 10, h: 10 } },
      o,
    );
  }
  addElement(
    doc,
    {
      id: "T",
      type: TEXT,
      parent: "F",
      x: 90,
      y: 10,
      size: { w: 10, h: 10 },
      data: { text: { $y: "text", delta: [{ insert: "hi" }] } },
    },
    o,
  );
  return doc;
}

function pair(doc: Y.Doc, ca: number, cb: number): [Y.Doc, Y.Doc] {
  return [forkDoc(doc, ca), forkDoc(doc, cb)];
}

describe("review 2: a delete spares work anywhere between the element and the deleted container", () => {
  for (const [ca, cb] of ORDERS) {
    it(`A deletes F, B moves group G inside F: G keeps its members (${ca}/${cb})`, () => {
      const d = base();
      group(d, ["X", "Y"], { id: "G" });
      const [a, b] = pair(d, ca, cb);
      deleteElements(a, ["F"]);
      moveElement(b, "G", 300, 300);
      syncDocs(a, b);
      expect(toSnapshot(a)).toEqual(toSnapshot(b));
      const r = R(a);
      expect(r.isGone("F")).toBe(true);
      expect(r.isGone("T")).toBe(true);
      expect(r.drawOrder()).toEqual(["G", "X", "Y"]);
      // Placed where the frame was: the group at B's position inside F.
      expect(r.worldOrigin("G")).toEqual({ x: 1300, y: 1300 });
      expect(r.logicalParentOf("G")).toBe(null);
    });

    it(`A deletes F, B moves subframe SF inside F: SF keeps its contents (${ca}/${cb})`, () => {
      const d = base();
      const o = seededOptions(3);
      addElement(
        d,
        { id: "SF", type: FRAME_TYPE, parent: "F", x: 200, y: 200, size: { w: 100, h: 100 } },
        o,
      );
      addElement(
        d,
        { id: "Z", type: SHAPE, parent: "SF", x: 5, y: 5, size: { w: 10, h: 10 } },
        o,
      );
      const [a, b] = pair(d, ca, cb);
      deleteElements(a, ["F"]);
      moveElement(b, "SF", 300, 300);
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["SF", "Z"]);
      expect(R(a).worldOrigin("Z")).toEqual({ x: 1305, y: 1305 });
    });

    it(`A deletes F, B ungroups G inside F: the members stay (${ca}/${cb})`, () => {
      const d = base();
      group(d, ["X", "Y"], { id: "G" });
      const [a, b] = pair(d, ca, cb);
      deleteElements(a, ["F"]);
      dissolve(b, "G");
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["X", "Y"]);
    });

    it(`A deletes F, B edits X deep inside: only X stays (${ca}/${cb})`, () => {
      const d = base();
      group(d, ["X", "Y"], { id: "G" });
      const [a, b] = pair(d, ca, cb);
      deleteElements(a, ["F"]);
      renameElement(b, "X", "kept");
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["X"]);
      expect(R(a).worldOrigin("X")).toEqual({ x: 1010, y: 1010 });
    });

    it(`two users delete the same frame: everything is gone (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      deleteElements(a, ["F"]);
      deleteElements(b, ["F"]);
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual([]);
    });

    it(`B adds N to F and deletes F, A deletes F too: N is deleted in both orders (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      addElement(b, { id: "N", type: SHAPE, parent: "F", x: 1, y: 1, size: { w: 1, h: 1 } });
      deleteElements(b, ["F"]);
      deleteElements(a, ["F"]);
      syncDocs(a, b);
      // B's delete saw N. Both deletes are kept, so it does not depend on which wins.
      expect(R(a).drawOrder()).toEqual([]);
    });

    it(`locking counts as work: X survives a concurrent delete (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      deleteElements(a, ["X"]);
      setLocked(b, "X", true);
      syncDocs(a, b);
      expect(visible(a, "X")).toBe(true);
    });

    it(`an edit made without seeing the delete wins, whichever revision write wins (${ca}/${cb})`, () => {
      // B edits X and A sees it. A deletes X. C, who saw neither, edits X.
      const d = base();
      const a = forkDoc(d, 50);
      const [b, c] = pair(d, ca, cb);
      renameElement(b, "X", "b");
      syncDocs(a, b);
      deleteElements(a, ["X"]);
      moveElement(c, "X", 33, 33);
      syncDocs(a, b);
      syncDocs(a, c);
      syncDocs(a, b);
      expect(toSnapshot(b)).toEqual(toSnapshot(a));
      expect(visible(a, "X")).toBe(true);
      expect(R(a).localPosition("X")).toEqual({ x: 33, y: 33 });
    });
  }
});

describe("review 2: work is detected automatically", () => {
  for (const [ca, cb] of ORDERS) {
    it(`typing through an editor binding survives a concurrent delete (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      deleteElements(a, ["F"]);
      // What an editor binding does: its own transaction with its own origin.
      b.transact(() => (dataMap(b, "T").get("text") as Y.Text).insert(2, " there"), BINDING);
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["T"]);
      expect(toSnapshot(a).elements.T!.data.text).toEqual({
        $y: "text",
        delta: [{ insert: "hi there" }],
      });
    });

    it(`typing into speaker notes keeps a stop that is removed concurrently (${ca}/${cb})`, () => {
      const d = base();
      addStop(d, { id: "S", view: { kind: "frame", frame: "F", padding: 0 } });
      const [a, b] = pair(d, ca, cb);
      removeStop(a, "S");
      b.transact(() => stopNotes(b, "S").insert(0, "note"), BINDING);
      syncDocs(a, b);
      const snapshot = toSnapshot(a);
      expect(hiddenAt(snapshot, "none", 0).size).toBe(0);
      addRoute(a, { id: "R" });
      insertRouteEntry(a, "R", "S");
      expect(routeSteps(toSnapshot(a), "R").map((s) => s.stop)).toEqual(["S"]);
    });

    it(`adding a stop to a route keeps it, reordering a route does not (${ca}/${cb})`, () => {
      const d = base();
      for (const id of ["S1", "S2"])
        addStop(d, { id, view: { kind: "frame", frame: "F", padding: 0 } });
      addRoute(d, { id: "R" });
      insertRouteEntry(d, "R", "S1", { id: "e1" });
      insertRouteEntry(d, "R", "S2", { id: "e2" });
      addRoute(d, { id: "R2" });
      const [a, b] = pair(d, ca, cb);
      removeStop(a, "S1");
      removeStop(a, "S2");
      insertRouteEntry(b, "R2", "S1", { id: "e3" });
      moveRouteEntry(b, "R", "e2", 0);
      syncDocs(a, b);
      const snapshot = toSnapshot(a);
      expect(routeSteps(snapshot, "R").map((s) => s.stop)).toEqual(["S1"]);
      expect(routeSteps(snapshot, "R2").map((s) => s.stop)).toEqual(["S1"]);
    });
  }

  it("typing does not break text into one CRDT item per character", () => {
    const d = base();
    const text = dataMap(d, "T").get("text") as Y.Text;
    const before = Y.encodeStateAsUpdate(d).length;
    for (let i = 0; i < 500; i++) d.transact(() => text.insert(text.length, "x"), BINDING);
    // 500 characters typed one transaction at a time stay well under 4 bytes each.
    expect(Y.encodeStateAsUpdate(d).length - before).toBeLessThan(2000);
  });
});

describe("review 2: undo and delete", () => {
  for (const [ca, cb] of ORDERS) {
    it(`undoing an edit of something deleted meanwhile does not bring it back (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      moveElement(a, "X", 20, 20);
      syncDocs(a, b);
      deleteElements(b, ["X"]);
      syncDocs(a, b);
      expect(visible(a, "X")).toBe(false);
      undo.undo();
      syncDocs(a, b);
      expect(visible(a, "X")).toBe(false);
      expect(visible(b, "X")).toBe(false);
      expect(toSnapshot(a)).toEqual(toSnapshot(b));
    });

    it(`an undo made without seeing the delete counts as an edit (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      moveElement(a, "X", 20, 20);
      syncDocs(a, b);
      deleteElements(b, ["X"]);
      undo.undo();
      syncDocs(a, b);
      expect(visible(a, "X")).toBe(true);
      expect(R(a).localPosition("X")).toEqual({ x: 10, y: 10 });
    });

    it(`A deletes F, B deletes X, A undoes: X stays deleted (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      deleteElements(a, ["F"]);
      deleteElements(b, ["X"]);
      syncDocs(a, b);
      undo.undo();
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["F", "Y", "T"]);
      expect(R(b).drawOrder()).toEqual(["F", "Y", "T"]);
    });
  }

  for (const [ca, cb] of ORDERS) {
    it(`undoing a move that won over a concurrent move puts the element back, not at the origin (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      const undo = createUndoManager(a, { captureTimeout: 0 });
      moveElement(a, "X", 20, 20);
      reparent(a, "Y", null);
      moveElement(b, "X", 30, 30);
      reparent(b, "Y", null);
      syncDocs(a, b);
      undo.undo();
      undo.undo();
      syncDocs(a, b);
      // Yjs alone leaves the keys without any value here when A's write had won.
      expect(inspectDocument(a).problems).toEqual([]);
      expect(toSnapshot(a)).toEqual(toSnapshot(b));
      const at = R(a).localPosition("X");
      expect([10, 30]).toContain(at.x);
      expect(["F", null]).toContain(R(a).parentOf("Y"));
      expect(R(a).worldOrigin("Y")).toEqual({ x: 1050, y: 1010 });
    });
  }

  it("redo of a delete deletes again although the element was edited in between", () => {
    const [a, b] = pair(base(), 1, 2);
    const undo = createUndoManager(a, { captureTimeout: 0 });
    deleteElements(a, ["F"]);
    undo.undo();
    syncDocs(a, b);
    renameElement(b, "X", "edited");
    addElement(b, { id: "N", type: SHAPE, parent: "F", x: 1, y: 1, size: { w: 1, h: 1 } });
    syncDocs(a, b);
    undo.redo();
    expect(R(a).drawOrder()).toEqual([]);
    undo.undo();
    expect(R(a).drawOrder()).toEqual(["F", "X", "Y", "T", "N"]);
    undo.redo();
    syncDocs(a, b);
    expect(R(b).drawOrder()).toEqual([]);
  });

  it("undo of a creation removes the element after it was edited, and redo restores it", () => {
    const d = base();
    const undo = createUndoManager(d, { captureTimeout: 0 });
    addElement(d, { id: "N", type: SHAPE, x: 1, y: 1, size: { w: 1, h: 1 } });
    moveElement(d, "N", 5, 5);
    renameElement(d, "N", "n");
    undo.undo();
    undo.undo();
    expect(visible(d, "N")).toBe(true);
    undo.undo();
    expect(visible(d, "N")).toBe(false);
    expect(d.getMap("elements").has("N")).toBe(true);
    undo.redo();
    expect(visible(d, "N")).toBe(true);
    undo.redo();
    undo.redo();
    expect(toSnapshot(d).elements.N!.name).toBe("n");
  });

  it("undo covers the origins of editor bindings", () => {
    const d = base();
    const undo = createUndoManager(d, { captureTimeout: 0, origins: [BINDING] });
    const text = dataMap(d, "T").get("text") as Y.Text;
    d.transact(() => text.insert(2, "!"), BINDING);
    expect(text.toString()).toBe("hi!");
    undo.undo();
    expect(text.toString()).toBe("hi");
  });

  it("undo never writes a revision back", () => {
    const d = base();
    const undo = createUndoManager(d, { captureTimeout: 0 });
    const before = toSnapshot(d).elements.X!.rev;
    moveElement(d, "X", 20, 20);
    const moved = toSnapshot(d).elements.X!.rev;
    expect(moved).not.toEqual(before);
    undo.undo();
    const undone = toSnapshot(d).elements.X!.rev;
    expect(undone).not.toEqual(before);
    expect(undone).not.toEqual(moved);
  });
});

describe("review 2: tidy up leaves place markers", () => {
  it("a child added offline to a frame that was deleted and tidied stays in place", () => {
    const [a, b] = pair(base(), 1, 2);
    deleteElements(a, ["F"]);
    const summary = tidyUp(a);
    expect(summary).toMatchObject({ elements: 3, containers: 1 });
    expect(Object.keys(toSnapshot(a).elements)).toEqual(["F"]);
    addElement(
      b,
      { id: "N", type: SHAPE, parent: "F", x: 10, y: 10, size: { w: 5, h: 5 } },
      seededOptions(9),
    );
    expect(R(b).worldOrigin("N")).toEqual({ x: 1010, y: 1010 });
    syncDocs(a, b);
    expect(toSnapshot(a)).toEqual(toSnapshot(b));
    expect(R(a).drawOrder()).toEqual(["N"]);
    expect(R(a).worldOrigin("N")).toEqual({ x: 1010, y: 1010 });
  });

  for (const [ca, cb] of ORDERS) {
    it(`dissolve and tidy up against an offline move of a child (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      dissolve(a, "F");
      tidyUp(a);
      moveElement(b, "X", 20, 20);
      syncDocs(a, b);
      expect(R(a).worldOrigin("X")).toEqual({ x: 1020, y: 1020 });
      expect(R(a).drawOrder()).toEqual(["X", "Y", "T"]);
    });

    it(`an offline delete of something that was tidied around still works (${ca}/${cb})`, () => {
      const [a, b] = pair(base(), ca, cb);
      deleteElements(a, ["Y"]);
      tidyUp(a);
      deleteElements(b, ["X"]);
      syncDocs(a, b);
      expect(R(a).drawOrder()).toEqual(["F", "T"]);
    });
  }

  it("the marker of a purged frame holds no content, and tidy up changes nothing visible", () => {
    const d = base();
    renameElement(d, "F", "Secret");
    addStop(d, { id: "S", view: { kind: "frame", frame: "F", padding: 0 } });
    addElement(d, { id: "Q", type: SHAPE, x: 5, y: 5, size: { w: 1, h: 1 } });
    const b = forkDoc(d, 9);
    addElement(b, { id: "N", type: SHAPE, parent: "F", x: 3, y: 3, size: { w: 1, h: 1 } });
    deleteElements(d, ["F"]);
    syncDocs(d, b);
    const before = R(d);
    const order = before.drawOrder();
    const places = order.map((id) => before.worldOrigin(id));
    tidyUp(d);
    const after = R(d);
    expect(after.drawOrder()).toEqual(order);
    expect(order.map((id) => after.worldOrigin(id))).toEqual(places);
    const marker = toSnapshot(d).elements.F!;
    expect(marker).toMatchObject({ name: "", dissolved: true, data: {}, deleted: {} });
    expect(JSON.stringify(toSnapshot(d))).not.toContain("Secret");
    expect(inspectDocument(d).problems).toEqual([]);
  });
});

describe("review 2: operations cannot write what a file cannot hold", () => {
  it("a negative size is refused and nothing is written", () => {
    const d = base();
    const before = toSnapshot(d);
    expect(() => resizeElement(d, "X", -20, 10)).toThrow(InvalidDocumentError);
    expect(() => resizeElement(d, "X", Number.NaN, 10)).toThrow(InvalidDocumentError);
    expect(() => moveElement(d, "X", Infinity, 0)).toThrow(InvalidDocumentError);
    expect(toSnapshot(d)).toEqual(before);
  });

  it("ids outside the id syntax are refused, __proto__ included", () => {
    const d = base();
    for (const id of ["__proto__", "has space", "", "x".repeat(65)]) {
      expect(() =>
        addElement(d, { id, type: SHAPE, x: 0, y: 0, size: { w: 1, h: 1 } }),
      ).toThrow(InvalidDocumentError);
      expect(() =>
        addStop(d, { id, view: { kind: "frame", frame: "F", padding: 0 } }),
      ).toThrow(InvalidDocumentError);
    }
    expect(() =>
      addElement(d, { type: "Not A Type", x: 0, y: 0, size: { w: 1, h: 1 } }),
    ).toThrow(InvalidDocumentError);
    expect(() => addElement(d, { type: SHAPE, x: 0, y: 0 })).toThrow(InvalidDocumentError);
    expect(() =>
      addElement(d, { id: "X", type: SHAPE, x: 0, y: 0, size: { w: 1, h: 1 } }),
    ).toThrow(/exists/);
    expect(validateSnapshot(toSnapshot(d))).toEqual([]);
  });

  it("whatever a peer writes, the snapshot is valid and reads back the same", () => {
    const d = base();
    const x = d.getMap("elements").get("X") as Y.Map<unknown>;
    d.transact(() => {
      x.set("size", { w: -5, h: "wide" });
      x.set("typeVersion", 0);
      x.set("dissolved", true);
      x.set("deleted", {});
      x.set("refs", ["has space", "ok"]);
      x.set("pos", { x: Number.NaN, y: 0, space: "a b" });
      x.set("future", 1);
      const bad = new Y.Map<unknown>();
      d.getMap("elements").set("bad id!", bad);
      bad.set("type", "a/b");
      const typeless = new Y.Map<unknown>();
      d.getMap("elements").set("typeless", typeless);
      d.getMap("stops").set("S", "not a map");
      d.getMap("assets").set("not-an-asset", { mediaType: 5 });
    }, "remote-peer");
    const { snapshot, problems } = inspectDocument(d);
    expect(validateSnapshot(snapshot)).toEqual([]);
    expect(snapshot.elements.X).toMatchObject({
      size: { w: 0, h: 0 },
      typeVersion: 1,
      dissolved: false,
      deleted: {},
      refs: ["ok"],
      pos: { x: 0, y: 0, space: null },
    });
    expect(Object.keys(snapshot.elements).sort()).toEqual(["F", "T", "X", "Y"]);
    expect(snapshot.stops).toEqual({});
    expect(snapshot.assets).toEqual({});
    expect(problems.length).toBeGreaterThan(8);
    expect(toSnapshot(fromSnapshot(snapshot))).toEqual(snapshot);
    // Tidy up removes what the grammar has no place for.
    expect(tidyUp(d).other).toBeGreaterThan(0);
    expect(d.getMap("elements").has("bad id!")).toBe(false);
    expect(
      inspectDocument(d).problems.filter((p) => /unknown|not a valid id|not an object/.test(p)),
    ).toEqual([]);
  });

  it("deep nesting from a peer is cut, not thrown on", () => {
    for (const depth of [150, 6000]) {
      const d = base();
      d.transact(() => {
        let cur = dataMap(d, "X");
        for (let i = 0; i < depth; i++) {
          const next = new Y.Map<unknown>();
          cur.set("k", next);
          cur = next;
        }
        cur.set("leaf", 1);
      }, "remote-peer");
      const snapshot = toSnapshot(d);
      expect(validateSnapshot(snapshot)).toEqual([]);
      expect(nestingDepth(snapshot, 10_000)).toBeLessThanOrEqual(MAX_DEPTH);
      expect(JSON.stringify(snapshot)).toContain("nested too deep");
      expect(toSnapshot(fromSnapshot(snapshot))).toEqual(snapshot);
    }
  });
});

describe("review 2: every replica reads the same JSON form", () => {
  it("odd embeds and formatting attributes read as Yjs delivers them", () => {
    const d = base();
    d.transact(() => {
      const t = new Y.Text();
      dataMap(d, "X").set("t", t);
      t.insert(0, "abcd");
      t.insertEmbed(1, { src: "img", alt: undefined } as unknown as object);
      t.format(2, 2, { k: new Uint8Array([1, 2]) as unknown as string });
      t.insertEmbed(0, [1, 2] as unknown as object);
      dataMap(d, "X").set("plain", { a: undefined, big: 2n ** 70n, date: new Date(0) });
      dataMap(d, "X").set("lone", "a\uD800b");
    });
    const peer = forkDoc(d, 77);
    expect(toSnapshot(peer)).toEqual(toSnapshot(d));
    expect(toSnapshot(d).elements.X!.data.t).toEqual({
      $y: "text",
      delta: [
        { insert: [1, 2] },
        { insert: "a" },
        { insert: { src: "img" } },
        { insert: "bc", attributes: { k: { 0: 1, 1: 2 } } },
        { insert: "d" },
      ],
    });
    expect(validateSnapshot(toSnapshot(d))).toEqual([]);
    expect(toSnapshot(fromSnapshot(toSnapshot(d)))).toEqual(toSnapshot(d));
  });

  it("a key named __proto__ in a data map is kept; nested in a plain value it is left out everywhere", () => {
    const d = base();
    d.transact(() => {
      dataMap(d, "X").set("__proto__", { a: 1 });
      dataMap(d, "X").set("nested", JSON.parse('{"__proto__": {"b": 1}, "c": 2}'));
    });
    const peer = forkDoc(d, 78);
    const data = toSnapshot(d).elements.X!.data;
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(data.nested).toEqual({ c: 2 });
    expect(toSnapshot(peer)).toEqual(toSnapshot(d));
  });
});

describe("review 2: paste and reparent", () => {
  it("paste goes in front of the former members of a dissolved group", () => {
    const d = new Y.Doc();
    d.clientID = 5;
    const o = seededOptions(2);
    initDocument(d, { id: "p" }, o);
    for (const [id, x] of [
      ["A", 0],
      ["B", 10],
      ["C", 20],
    ] as const)
      addElement(d, { id, type: SHAPE, x, y: 0, size: { w: 5, h: 5 } }, o);
    group(d, ["B", "C"], { ...o, id: "G" });
    dissolve(d, "G");
    const result = pasteFragment(d, copyFragment(toSnapshot(d), ["A"]), { dx: 100 }, o);
    expect(R(d).drawOrder()).toEqual(["A", "B", "C", result.ids.get("A")]);
  });

  it("three users reparent X into different frames, a fourth moves it: every order agrees", () => {
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
      [0, 3, 1, 2],
      [3, 1, 2, 0],
    ];
    const results = new Set<string>();
    for (const p of orders) {
      const d = base();
      const o = seededOptions(5);
      for (const [i, x] of [
        [1, 3000],
        [2, 6000],
        [3, 9000],
      ] as const)
        addElement(
          d,
          { id: `F${i}`, type: FRAME_TYPE, x, y: 500, size: { w: 100, h: 100 } },
          o,
        );
      const reps = [11, 12, 13, 14].map((c) => forkDoc(d, c));
      reparent(reps[0]!, "X", "F1");
      reparent(reps[1]!, "X", "F2");
      reparent(reps[2]!, "X", "F3");
      moveElement(reps[3]!, "X", 77, 88);
      for (let round = 0; round < 2; round++)
        for (let k = 1; k < 4; k++) syncDocs(reps[p[0]!]!, reps[p[k]!]!);
      const r = R(reps[0]!);
      const w = r.worldOrigin("X");
      results.add(`${r.parentOf("X")} ${w.x},${w.y}`);
      for (const rep of reps) expect(toSnapshot(rep)).toEqual(toSnapshot(reps[0]!));
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toMatch(/ 1077,1088$/);
  });
});

describe("review 2: versions and merge identity while syncing", () => {
  it("a replica that needs a newer version is not synced with, written to or left unnoticed", () => {
    const d = base();
    const newer = forkDoc(d, 2);
    // A newer client starts using something this version cannot read.
    newer.transact(() => {
      newer.getMap("meta").set("minReaderVersion", SCHEMA_VERSION + 1);
      newer.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1);
      (newer.getMap("elements").get("X") as Y.Map<unknown>).set("orbit", { speed: 2 });
    }, "newer-client");
    expect(checkSync(d, syncHello(newer))).toBe("needs-newer-version");
    expect(() => syncDocs(d, newer)).toThrow(NewerVersionError);
    expect(toSnapshot(d).elements.X).toEqual(toSnapshot(base()).elements.X);

    // If the change arrives anyway (the session was already open), this replica
    // is told at once and refuses to write.
    let told = 0;
    const stop = watchVersion(d, (needed) => (told = needed));
    expect(told).toBe(0);
    Y.applyUpdate(d, Y.encodeStateAsUpdate(newer), "provider");
    expect(told).toBe(SCHEMA_VERSION + 1);
    expect(() => moveElement(d, "X", 1, 1)).toThrow(NewerVersionError);
    expect(() => deleteElements(d, ["X"])).toThrow(NewerVersionError);
    expect(() => tidyUp(d)).toThrow(NewerVersionError);
    // Nothing of the newer client's content was dropped from the shared state.
    expect((d.getMap("elements").get("X") as Y.Map<unknown>).get("orbit")).toEqual({
      speed: 2,
    });
    stop();
  });

  it("a blank replica can join; unrelated documents cannot", () => {
    const d = base();
    const blank = new Y.Doc();
    expect(syncHello(blank)).toEqual({ lineage: "", minReaderVersion: 1, blank: true });
    expect(canMerge(blank, d)).toBe(true);
    syncDocs(blank, d);
    expect(toSnapshot(blank)).toEqual(toSnapshot(d));
    moveElement(blank, "X", 3, 4);
    syncDocs(d, blank);
    expect(R(d).localPosition("X")).toEqual({ x: 3, y: 4 });

    const other = fromSnapshot(toSnapshot(d));
    expect(canMerge(d, other)).toBe(false);
    expect(() => syncDocs(d, other)).toThrow(MergeIdentityError);
    // A document without a lineage that is not blank is never merged.
    const odd = new Y.Doc();
    odd.getMap("elements").set("Q", new Y.Map());
    expect(canMerge(odd, d)).toBe(false);
    expect(inspectDocument(new Y.Doc()).problems).toEqual([]);
  });

  it("when merge identity is lost, the other copy's work can be imported as new content", () => {
    const d = base();
    addStop(d, { id: "S", view: { kind: "rect", space: null, x: 900, y: 900, w: 500, h: 500 } });
    addRoute(d, { id: "R", name: "Talk" });
    insertRouteEntry(d, "R", "S");
    // The file was reopened without its Yjs state: a new lineage.
    const mine = fromSnapshot(toSnapshot(d));
    // Meanwhile someone worked offline on a copy with the old lineage.
    const theirs = forkDoc(d, 4);
    addElement(theirs, { id: "N", type: SHAPE, parent: "F", x: 70, y: 70, size: { w: 5, h: 5 } });
    renameElement(theirs, "X", "their name");
    deleteElements(theirs, ["Y"]);
    expect(() => syncDocs(mine, theirs)).toThrow(MergeIdentityError);

    const before = toSnapshot(mine);
    const result = importCopy(mine, toSnapshot(theirs), { dx: 2000 });
    const after = toSnapshot(mine);
    // Nothing of mine changed.
    for (const id of Object.keys(before.elements))
      expect(after.elements[id]).toEqual(before.elements[id]);
    // Everything visible of theirs arrived, beside mine, with new ids.
    const r = R(mine);
    const copy = (id: string) => result.ids.get(id)!;
    expect(r.drawOrder()).toEqual(["F", "X", "Y", "T", copy("F"), copy("X"), copy("T"), copy("N")]);
    expect(after.elements[copy("X")]!.name).toBe("their name");
    expect(r.worldOrigin(copy("N"))).toEqual({ x: 3070, y: 1070 });
    expect(result.ids.has("Y")).toBe(false);
    const stop = after.stops[copy("S")]!;
    expect(stop.view).toEqual({ kind: "rect", space: null, x: 2900, y: 900, w: 500, h: 500 });
    expect(after.routes[copy("R")]!.name).toBe("Talk");
    expect(routeSteps(after, copy("R")).map((step) => step.stop)).toEqual([copy("S")]);
    // One undo removes the import again (softly).
    const undo = createUndoManager(mine, { captureTimeout: 0 });
    importCopy(mine, toSnapshot(theirs), { dx: 4000 });
    undo.undo();
    expect(R(mine).drawOrder().length).toBe(8);
  });
});
