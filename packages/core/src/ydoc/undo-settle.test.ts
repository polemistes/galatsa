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
    it(`fills a hole before judging the undo, so the element stays deleted (clients ${clients.join("/")})`, () => {
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
      const hidden = r(b).isGone(x);
      undoB.undo();
      sync();
      for (const doc of [a, b]) {
        expect(r(doc).isGone(y)).toBe(true);
        if (hidden) expect(r(doc).isGone(x)).toBe(true);
      }
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
