// SPDX-License-Identifier: GPL-3.0-or-later

// How the undo manager finishes an undo or redo before the work tracker judges
// it (section 10): holes are filled first, and a change of container is kept
// back where it would take an element out of another user's delete or move it
// on the canvas without the step moving it.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Resolver } from "../model/resolve.ts";
import { FRAME_TYPE } from "../model/types.ts";
import * as ops from "./ops.ts";
import { yLookup } from "./snapshot.ts";
import { forkDoc, syncDocs } from "./sync.ts";
import { createUndoManager } from "./track.ts";
import { liveResolver } from "./live.ts";

function pair(clients: readonly [number, number] = [1, 2]) {
  const a = new Y.Doc();
  a.clientID = clients[0];
  ops.initDocument(a);
  const b = forkDoc(a, clients[1]);
  const undoA = createUndoManager(a, { captureTimeout: 0 });
  const undoB = createUndoManager(b, { captureTimeout: 0 });
  const r = (doc: Y.Doc) => new Resolver(yLookup(doc));
  return { a, b, undoA, undoB, r, sync: () => syncDocs(a, b) };
}

const box = (x: number, y: number, parent: string | null = null, type = "x.y/z") => ({
  type,
  x,
  y,
  size: { w: 10, h: 10 },
  parent,
});

describe("undo after another user's delete", () => {
  it("leaves an element deleted with its frame when the undo takes back moving it in", () => {
    const { a, b, undoB, r, sync } = pair();
    const f = ops.addElement(a, {
      ...box(100, 0),
      type: FRAME_TYPE,
      size: { w: 100, h: 100 },
    });
    const x = ops.addElement(a, box(0, 0));
    sync();
    undoB.clear();
    ops.reparent(b, x, f);
    sync();
    ops.deleteElements(a, [f]);
    sync();
    undoB.undo();
    sync();
    for (const doc of [a, b]) expect(r(doc).isGone(x)).toBe(true);
    undoB.redo();
    sync();
    for (const doc of [a, b]) expect(r(doc).isGone(x)).toBe(true);
  });

  it("leaves the members of a deleted group deleted when the grouping is undone", () => {
    const { a, b, undoB, r, sync } = pair();
    const x = ops.addElement(a, box(0, 0));
    const y = ops.addElement(a, box(50, 0));
    sync();
    undoB.clear();
    const g = ops.group(b, [x, y]);
    sync();
    ops.deleteElements(a, [g]);
    sync();
    undoB.undo();
    sync();
    for (const doc of [a, b]) {
      expect(r(doc).isGone(x)).toBe(true);
      expect(r(doc).isGone(y)).toBe(true);
    }
  });

  for (const clients of [
    [1, 2],
    [2, 1],
  ] as const)
    it(`fills a hole within the undo, before judging it: the element is back in its frame and stays deleted (clients ${clients.join("/")})`, () => {
      const { a, b, undoB, r, sync } = pair(clients);
      const frame = (x: number, parent: string | null) =>
        ops.addElement(a, { ...box(x, 0, parent, FRAME_TYPE), size: { w: 300, h: 300 } });
      const f = frame(0, null);
      const l = frame(10, f);
      const x = ops.addElement(a, box(20, 20, l));
      const y = ops.addElement(a, box(60, 20, l));
      sync();
      undoB.clear();
      // Concurrently: A moves X out to the root, B groups X and Y.
      ops.reparent(a, x, null);
      ops.group(b, [x, y]);
      sync();
      ops.deleteElements(a, [f]);
      sync();
      // When B's grouping won X's parent, undoing it cannot put back X's parent
      // (A's concurrent write is on record): a hole, which is filled with L.
      const grouped = r(b).parentOf(x) !== null;
      expect(r(b).isGone(x)).toBe(grouped);
      undoB.undo();
      sync();
      for (const doc of [a, b]) {
        expect(r(doc).isGone(y)).toBe(true);
        if (grouped) {
          // Judged with the hole, X would have looked as if at the root, out of
          // the delete, and been held back in the group instead.
          expect(r(doc).parentOf(x)).toBe(l);
          expect(r(doc).isGone(x)).toBe(true);
        }
      }
    });

  for (const clients of [
    [1, 2],
    [2, 1],
  ] as const)
    it(`a filled hole is part of the step, so redo puts the value back too (clients ${clients.join("/")})`, () => {
      const { a, b, undoB, r, sync } = pair(clients);
      const l = ops.addElement(a, {
        ...box(0, 0, null, FRAME_TYPE),
        size: { w: 300, h: 300 },
      });
      const x = ops.addElement(a, box(20, 20, l));
      const y = ops.addElement(a, box(60, 20, l));
      sync();
      undoB.clear();
      ops.reparent(a, x, null);
      const g = ops.group(b, [x, y]);
      sync();
      if (r(b).parentOf(x) !== g) return; // A's move won: no hole to fill
      undoB.undo();
      sync();
      expect(r(b).parentOf(x)).toBe(l);
      undoB.redo();
      sync();
      for (const doc of [a, b]) expect(r(doc).parentOf(x)).toBe(g);
    });

  it("still restores what the user's own delete hid", () => {
    const { a, undoA, r } = pair();
    const f = ops.addElement(a, {
      ...box(0, 0),
      type: FRAME_TYPE,
      size: { w: 100, h: 100 },
    });
    const x = ops.addElement(a, box(10, 10, f));
    undoA.clear();
    ops.deleteElements(a, [f]);
    undoA.undo();
    expect([r(a).isGone(f), r(a).isGone(x)]).toEqual([false, false]);
  });
});

describe("undo after another user's move", () => {
  it("leaves the members of a group where the other user moved the group", () => {
    const { a, b, undoA, r, sync } = pair();
    const x = ops.addElement(a, box(0, 0));
    const y = ops.addElement(a, box(50, 0));
    undoA.clear();
    const g = ops.group(a, [x, y]);
    sync();
    ops.moveElement(b, g, 100, 0);
    sync();
    undoA.undo();
    sync();
    for (const doc of [a, b]) {
      expect(r(doc).isGone(g)).toBe(true);
      expect(r(doc).worldOrigin(x)).toEqual({ x: 100, y: 0 });
      expect(r(doc).worldOrigin(y)).toEqual({ x: 150, y: 0 });
    }
  });

  it("moves elements back when nobody else moved anything", () => {
    const { a, undoA, r } = pair();
    const f = ops.addElement(a, {
      ...box(100, 0),
      type: FRAME_TYPE,
      size: { w: 100, h: 100 },
    });
    const x = ops.addElement(a, box(0, 0));
    undoA.clear();
    ops.reparent(a, x, f);
    undoA.undo();
    expect([r(a).parentOf(x), r(a).worldOrigin(x)]).toEqual([null, { x: 0, y: 0 }]);
  });
});

// An undone change of container that would move something on the canvas is
// done, with a rebase that keeps the place, rather than held back: a held-back
// undo would never be done, its writes would block later undos and redos of the
// same keys, and what it left in a container could disappear with it.
describe("an undone change of container is done, keeping the element's place", () => {
  function trio(clients: readonly [number, number, number] = [1, 2, 3]) {
    const a = new Y.Doc();
    a.clientID = clients[0];
    ops.initDocument(a);
    const b = forkDoc(a, clients[1]);
    const c = forkDoc(a, clients[2]);
    const undoA = createUndoManager(a, { captureTimeout: 0 });
    const undoB = createUndoManager(b, { captureTimeout: 0 });
    const r = (doc: Y.Doc) => new Resolver(yLookup(doc));
    const sync = (...docs: Y.Doc[]) => {
      const all = docs.length > 0 ? docs : [a, b, c];
      for (const x of all) for (const y of all) if (x !== y) syncDocs(x, y);
    };
    return { a, b, c, undoA, undoB, r, sync };
  }
  const frameAt = (x: number, y: number, parent: string | null = null, w = 100) => ({
    type: FRAME_TYPE,
    x,
    y,
    size: { w, h: w },
    parent,
  });

  it("then undoing the creation of the frame keeps an element that was there before", () => {
    const { a, b, undoB, r, sync } = trio();
    const x = ops.addElement(a, box(120, 20));
    sync();
    undoB.clear();
    const f = ops.addElement(b, frameAt(100, 0)); // B: create F
    ops.reparent(b, x, f); // B: X into F
    sync();
    ops.moveElement(a, f, 100, 300); // A moves F, and X with it
    sync();
    undoB.undo(); // X leaves F, where A's move put it
    sync();
    expect([r(b).parentOf(x), r(b).worldOrigin(x)]).toEqual([null, { x: 120, y: 320 }]);
    undoB.undo(); // F goes; X is not in it
    sync();
    for (const doc of [a, b]) {
      expect(r(doc).isGone(f)).toBe(true);
      expect(r(doc).isGone(x)).toBe(false);
    }
  });

  it("then undoing a grouping keeps an element moved into the group", () => {
    const { a, b, undoB, r, sync } = trio();
    const x = ops.addElement(a, box(0, 0));
    const y = ops.addElement(a, box(50, 0));
    const z = ops.addElement(a, box(200, 0));
    sync();
    undoB.clear();
    const g = ops.group(b, [x, y]);
    ops.reparent(b, z, g);
    sync();
    ops.moveElement(a, g, 100, 100);
    sync();
    undoB.undo();
    undoB.undo();
    sync();
    for (const doc of [a, b]) {
      const v = r(doc);
      expect([v.isGone(x), v.isGone(y), v.isGone(z)]).toEqual([false, false, false]);
      expect(v.worldOrigin(z)).toEqual({ x: 300, y: 100 });
    }
  });

  it("undoing a move out of a frame after the other user moved the frame puts the element back in it, where it is", () => {
    const { a, b, undoB, r, sync } = trio();
    const f = ops.addElement(a, frameAt(0, 0, null, 200));
    const x = ops.addElement(a, box(10, 10, f));
    sync();
    undoB.clear();
    ops.reparent(b, x, null);
    sync();
    ops.moveElement(a, f, 0, 300);
    sync();
    undoB.undo();
    sync();
    for (const doc of [a, b]) {
      expect(r(doc).parentOf(x)).toBe(f);
      expect(r(doc).worldOrigin(x)).toEqual({ x: 10, y: 10 });
    }
    // And it moves with F from now on.
    ops.moveElement(a, f, 0, 0);
    sync();
    expect(r(b).worldOrigin(x)).toEqual({ x: 10, y: -290 });
  });

  it("undo and redo keep working after the other user takes their move back", () => {
    const { a, b, undoA, undoB, r, sync } = trio();
    const f = ops.addElement(a, frameAt(100, 0));
    const x = ops.addElement(a, box(120, 20));
    sync();
    undoA.clear();
    undoB.clear();
    ops.reparent(b, x, f);
    sync();
    ops.moveElement(a, f, 100, 300);
    sync();
    undoB.undo(); // X leaves F, at (120, 320)
    sync();
    undoA.undo(); // F goes back; X is no longer in it
    sync();
    expect(r(b).worldOrigin(x)).toEqual({ x: 120, y: 320 });
    // Redo puts X into F again, and, like the move into a frame it makes again,
    // does not move it on the canvas.
    undoB.redo();
    sync();
    expect([r(b).parentOf(x), r(b).worldOrigin(x)]).toEqual([f, { x: 120, y: 320 }]);
    ops.moveElement(a, f, 200, 0); // X moves with F now
    sync();
    expect(r(b).worldOrigin(x)).toEqual({ x: 220, y: 320 });
    undoB.undo(); // X leaves F again, where it is
    sync();
    for (const doc of [a, b])
      expect([r(doc).parentOf(x), r(doc).worldOrigin(x)]).toEqual([
        null,
        { x: 220, y: 320 },
      ]);
  });

  it("an older undo of the same element still works after a newer one kept the place", () => {
    const { a, b, undoA, undoB, r, sync } = trio();
    const f = ops.addElement(a, frameAt(100, 0, null, 300));
    const x = ops.addElement(a, box(0, 0));
    const y = ops.addElement(a, box(120, 20, f));
    sync();
    undoA.clear();
    undoB.clear();
    ops.reparent(b, x, f); // B: X into F
    const g = ops.group(b, [x, y]); // B: group X and Y
    sync();
    ops.moveElement(a, g, 50, 50); // A moves the group
    sync();
    undoB.undo(); // the grouping: X and Y stay where A's move put them
    sync();
    const at = r(b).worldOrigin(x);
    undoA.undo(); // the group is gone, so A's undo moves nothing
    sync();
    undoB.undo(); // X out of F, where it is
    sync();
    for (const doc of [a, b]) {
      expect(r(doc).logicalParentOf(x)).toBe(null);
      expect(r(doc).worldOrigin(x)).toEqual(at);
    }
  });

  // A held-back change is the user's own undo writing over a concurrent move,
  // like any undo against a concurrent move of the same key: which one wins is
  // Yjs's choice, the same on every replica. The third user's work survives.
  for (const clients of [
    [1, 2, 3],
    [3, 2, 1],
  ] as const)
    it(`a third user's concurrent move of an element whose undo is held back survives the delete (clients ${clients.join("/")})`, () => {
      const { a, b, c, undoB, r, sync } = trio(clients);
      const f = ops.addElement(a, frameAt(100, 0));
      const x = ops.addElement(a, box(0, 0));
      sync();
      undoB.clear();
      undoB.stopCapturing();
      ops.edit(b, () => {
        ops.reparent(b, x, f);
        ops.moveElement(b, x, 10, 10);
      });
      sync();
      ops.deleteElements(a, [f]);
      sync(a, b);
      undoB.undo(); // after receiving the delete: X stays in F, deleted
      expect(r(b).isGone(x)).toBe(true);
      ops.moveElement(c, x, 50, 50); // C, knowing neither, moves X
      sync();
      const places = [a, b, c].map((doc) => r(doc).worldOrigin(x));
      for (const doc of [a, b, c]) expect(r(doc).isGone(x)).toBe(false);
      expect(places[1]).toEqual(places[0]);
      expect(places[2]).toEqual(places[0]);
      expect([
        { x: 150, y: 50 },
        { x: 110, y: 10 },
      ]).toContainEqual(places[0]);
    });

  it("leaves the live resolver equal to a fresh one", () => {
    const { a, b, undoB, r, sync } = trio();
    const live = liveResolver(b);
    const f = ops.addElement(a, frameAt(100, 0));
    const x = ops.addElement(a, box(120, 20));
    const y = ops.addElement(a, box(150, 20));
    sync();
    undoB.clear();
    const g = ops.group(b, [x, y]);
    ops.reparent(b, g, f);
    sync();
    ops.moveElement(a, f, 100, 300);
    sync();
    const same = () => {
      const fresh = r(b);
      for (const id of fresh.ids()) {
        expect(live.parentOf(id)).toBe(fresh.parentOf(id));
        expect(live.worldOrigin(id)).toEqual(fresh.worldOrigin(id));
        expect(live.isGone(id)).toBe(fresh.isGone(id));
      }
    };
    undoB.undo();
    same();
    undoB.undo();
    same();
    undoB.redo();
    same();
    undoB.redo();
    same();
  });
});
