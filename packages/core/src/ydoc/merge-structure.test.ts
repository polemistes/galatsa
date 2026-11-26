// SPDX-License-Identifier: GPL-3.0-or-later

// Concurrent structural edits: z-order, frames, groups, locking, deletion, shared
// stops and routes. Each test implements one row of the outcome tables in
// sections 4.3, 5.7 and 6.5 of docs/adr/0001-document-model-and-file-format.md.
// Every scenario runs twice with the client ids swapped, because Yjs decides
// same-key conflicts by client id, and the specified outcome must hold either way.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Resolver, type Point } from "../model/resolve.ts";
import { hiddenAt, routeSteps } from "../model/route.ts";
import { FRAME_TYPE, GROUP_TYPE, type DocumentSnapshot } from "../model/types.ts";
import {
  addElement,
  addRoute,
  addStop,
  bringToFront,
  deleteElements,
  dissolve,
  edit,
  group,
  initDocument,
  insertRouteEntry,
  moveElement,
  moveRouteEntry,
  removeRouteEntry,
  removeStop,
  renameStop,
  reparent,
  restoreElement,
  restoreStop,
  sendToBack,
  setLocked,
  setStopView,
  setVisibility,
  stopNotes,
  dataMap,
} from "./ops.ts";
import { toSnapshot, yLookup } from "./snapshot.ts";
import { forkDoc, syncDocs } from "./sync.ts";
import { seededOptions } from "./testing.ts";

const SHAPE = "galatsa.shapes/shape";
const TEXT = "galatsa.text/text";

/**
 * Base document:
 *   F  frame at (1000, 1000), 800 x 600, containing T (text) at local (10, 10)
 *   G  frame at (5000, 0), 800 x 600
 *   X, Y, Z  shapes at the root at (200, 200), (400, 200), (600, 200)
 *   Gr group at (3000, 3000) with members M1 at local (0, 0), M2 at (50, 0)
 *   S  stop showing F; S2 a rectangle stop
 *   R1 = [S, S2], R2 = [S2, S] (S and S2 are shared)
 */
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
  addElement(
    doc,
    { id: "G", type: FRAME_TYPE, x: 5000, y: 0, size: { w: 800, h: 600 } },
    o,
  );
  addElement(
    doc,
    {
      id: "T",
      type: TEXT,
      parent: "F",
      x: 10,
      y: 10,
      size: { w: 100, h: 20 },
      data: { text: { $y: "text", delta: [{ insert: "Hi\n" }] } },
    },
    o,
  );
  for (const [id, x] of [
    ["X", 200],
    ["Y", 400],
    ["Z", 600],
  ] as const) {
    addElement(doc, { id, type: SHAPE, x, y: 200, size: { w: 100, h: 100 } }, o);
  }
  addElement(doc, { id: "Gr", type: GROUP_TYPE, x: 3000, y: 3000 }, o);
  addElement(
    doc,
    { id: "M1", type: SHAPE, parent: "Gr", x: 0, y: 0, size: { w: 10, h: 10 } },
    o,
  );
  addElement(
    doc,
    { id: "M2", type: SHAPE, parent: "Gr", x: 50, y: 0, size: { w: 10, h: 10 } },
    o,
  );
  addStop(doc, { id: "S", view: { kind: "frame", frame: "F", padding: 0 } }, o);
  addStop(
    doc,
    { id: "S2", view: { kind: "rect", space: null, x: 0, y: 0, w: 100, h: 100 } },
    o,
  );
  addRoute(doc, { id: "R1" }, o);
  addRoute(doc, { id: "R2" }, o);
  insertRouteEntry(doc, "R1", "S", { ...o, id: "e1" });
  insertRouteEntry(doc, "R1", "S2", { ...o, id: "e2" });
  insertRouteEntry(doc, "R2", "S2", { ...o, id: "e3" });
  insertRouteEntry(doc, "R2", "S", { ...o, id: "e4" });
  return doc;
}

interface Merged {
  a: Y.Doc;
  b: Y.Doc;
  snapshot: DocumentSnapshot;
  resolver: Resolver;
}

/**
 * Runs `scenario` twice (client ids 1/2 and 2/1): forks the base, lets A and B act
 * concurrently, syncs, checks that both replicas agree, then runs `check`.
 */
function scenario(
  act: (a: Y.Doc, b: Y.Doc) => void,
  check: (merged: Merged) => void,
): void {
  for (const [ca, cb] of [
    [1, 2],
    [2, 1],
  ] as const) {
    const start = base();
    const a = forkDoc(start, ca);
    const b = forkDoc(start, cb);
    act(a, b);
    syncDocs(a, b);
    const snapshot = toSnapshot(a);
    expect(toSnapshot(b)).toEqual(snapshot);
    const resolver = new Resolver(yLookup(a));
    const other = new Resolver(yLookup(b));
    expect(other.drawOrder()).toEqual(resolver.drawOrder());
    for (const id of Object.keys(snapshot.elements)) {
      expect(other.worldOrigin(id)).toEqual(resolver.worldOrigin(id));
    }
    check({ a, b, snapshot, resolver });
  }
}

function close(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
}

/** Root children in drawing order, removed ones excluded. */
function rootOrder(r: Resolver): string[] {
  return r.children(null).filter((id) => !r.isGone(id));
}

describe("z-order (section 4.3)", () => {
  it("bring to front and send to back by different users both happen", () => {
    scenario(
      (a, b) => {
        bringToFront(a, "X");
        sendToBack(b, "Z");
      },
      ({ resolver }) => {
        const order = rootOrder(resolver);
        expect(order[0]).toBe("Z");
        expect(order[order.length - 1]).toBe("X");
      },
    );
  });

  it("two users bringing different elements to front: both end in front", () => {
    scenario(
      (a, b) => {
        bringToFront(a, "X");
        bringToFront(b, "Y");
      },
      ({ resolver }) => {
        const order = rootOrder(resolver);
        expect(new Set(order.slice(-2))).toEqual(new Set(["X", "Y"]));
      },
    );
  });

  it("two users moving the same element: one place, the same on both", () => {
    scenario(
      (a, b) => {
        bringToFront(a, "Y");
        sendToBack(b, "Y");
      },
      ({ resolver }) => {
        const order = rootOrder(resolver);
        expect(order.filter((id) => id === "Y")).toHaveLength(1);
        expect([order[0], order[order.length - 1]]).toContain("Y");
      },
    );
  });

  it("reorder and reparent of the same element: it ends in the new parent", () => {
    scenario(
      (a, b) => {
        sendToBack(a, "X");
        reparent(b, "X", "F");
      },
      ({ resolver }) => {
        expect(resolver.parentOf("X")).toBe("F");
        expect(resolver.children("F")).toContain("X");
        close(resolver.worldOrigin("X"), { x: 200, y: 200 });
      },
    );
  });
});

describe("frames and reparenting (section 5.7)", () => {
  it("move into a frame + concurrent move: in the frame, at the moved position", () => {
    scenario(
      (a, b) => {
        reparent(a, "X", "F");
        moveElement(b, "X", 1100, 1150);
      },
      ({ resolver }) => {
        expect(resolver.parentOf("X")).toBe("F");
        close(resolver.worldOrigin("X"), { x: 1100, y: 1150 });
        close(resolver.localPosition("X"), { x: 100, y: 150 });
      },
    );
  });

  it("move out of a frame + concurrent move of the frame: the element stays put", () => {
    scenario(
      (a, b) => {
        reparent(a, "T", null);
        moveElement(b, "F", 2000, 2000);
      },
      ({ resolver }) => {
        expect(resolver.parentOf("T")).toBe(null);
        close(resolver.worldOrigin("T"), { x: 1010, y: 1010 });
        close(resolver.worldOrigin("F"), { x: 2000, y: 2000 });
      },
    );
  });

  it("an element moved into a frame follows the frame afterwards", () => {
    const a = base();
    reparent(a, "X", "F");
    moveElement(a, "F", 1500, 1000);
    close(new Resolver(yLookup(a)).worldOrigin("X"), { x: 700, y: 200 });
  });

  it("an element moved out of a frame does not drift when the frame moves later", () => {
    const a = base();
    reparent(a, "T", "G");
    moveElement(a, "F", 0, 0);
    const r = new Resolver(yLookup(a));
    expect(r.get("T")!.rebase).not.toBe(null);
    close(r.worldOrigin("T"), { x: 1010, y: 1010 });
    moveElement(a, "G", 6000, 0);
    close(new Resolver(yLookup(a)).worldOrigin("T"), { x: 2010, y: 1010 });
  });

  it("frames moved into each other (a cycle): nothing disappears", () => {
    scenario(
      (a, b) => {
        reparent(a, "F", "G");
        reparent(b, "G", "F");
      },
      ({ resolver }) => {
        // Broken at the smaller id, "F", which goes to the root; G stays inside F.
        expect(resolver.parentOf("F")).toBe(null);
        expect(resolver.parentOf("G")).toBe("F");
        const drawn = resolver.drawOrder();
        for (const id of ["F", "G", "T"]) expect(drawn).toContain(id);
        close(resolver.worldOrigin("T"), { x: 1010, y: 1010 });
      },
    );
  });

  it("moved into two different frames: one parent, consistent position", () => {
    scenario(
      (a, b) => {
        reparent(a, "X", "F");
        reparent(b, "X", "G");
      },
      ({ resolver }) => {
        expect(["F", "G"]).toContain(resolver.parentOf("X"));
        close(resolver.worldOrigin("X"), { x: 200, y: 200 });
      },
    );
  });

  it("deleting a frame while someone moves a child out: the child survives", () => {
    scenario(
      (a, b) => {
        deleteElements(a, ["F"]);
        reparent(b, "T", null);
      },
      ({ resolver }) => {
        expect(resolver.isDeleted("F")).toBe(true);
        expect(resolver.isDeleted("T")).toBe(false);
        expect(resolver.drawOrder()).toContain("T");
        close(resolver.worldOrigin("T"), { x: 1010, y: 1010 });
      },
    );
  });

  it("deleting a frame while someone moves an element into it: the element survives in place", () => {
    scenario(
      (a, b) => {
        deleteElements(a, ["F"]);
        reparent(b, "X", "F");
      },
      ({ a, resolver }) => {
        expect(resolver.isDeleted("F")).toBe(true);
        expect(resolver.isDeleted("X")).toBe(false);
        expect(resolver.drawOrder()).toContain("X");
        // Shown where the frame was, in the frame's parent, at the same place.
        expect(resolver.logicalParentOf("X")).toBe(null);
        close(resolver.worldOrigin("X"), { x: 200, y: 200 });
        // Restoring F brings the frame back with X inside it.
        restoreElement(a, "F");
        const after = new Resolver(yLookup(a));
        expect(after.logicalParentOf("X")).toBe("F");
        close(after.worldOrigin("X"), { x: 200, y: 200 });
      },
    );
  });

  it("deleting a frame while someone edits an element inside it: that element survives", () => {
    scenario(
      (a, b) => {
        deleteElements(a, ["F"]);
        edit(b, () => (dataMap(b, "T").get("text") as Y.Text).insert(2, "!"), { touch: ["T"] });
      },
      ({ resolver, snapshot }) => {
        expect(resolver.isDeleted("F")).toBe(true);
        expect(resolver.isDeleted("T")).toBe(false);
        expect(resolver.logicalParentOf("T")).toBe(null);
        close(resolver.worldOrigin("T"), { x: 1010, y: 1010 });
        expect(JSON.stringify(snapshot.elements.T!.data.text)).toContain("Hi!");
      },
    );
  });

  it("deleting a frame with nobody working inside it deletes everything in it", () => {
    const a = base();
    deleteElements(a, ["F"]);
    const r = new Resolver(yLookup(a));
    expect(r.isDeleted("F")).toBe(true);
    expect(r.isDeleted("T")).toBe(true);
    expect(r.drawOrder()).not.toContain("T");
    restoreElement(a, "F");
    expect(new Resolver(yLookup(a)).drawOrder()).toContain("T");
  });

  it("three replicas: A moves X into G, B deletes G, C moves X: X survives in every order", () => {
    for (const ids of [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]] as const) {
      const start = base();
      const [a, b, c] = ids.map((id) => forkDoc(start, id)) as [Y.Doc, Y.Doc, Y.Doc];
      reparent(a, "X", "G");
      deleteElements(b, ["G"]);
      moveElement(c, "X", 300, 300);
      syncDocs(a, b);
      syncDocs(b, c);
      syncDocs(a, c);
      expect(toSnapshot(a)).toEqual(toSnapshot(c));
      const r = new Resolver(yLookup(a));
      expect(r.isDeleted("X")).toBe(false);
      expect(r.drawOrder()).toContain("X");
      close(r.worldOrigin("X"), { x: 300, y: 300 });
    }
  });
});

describe("groups (section 5.7)", () => {
  it("overlapping groupings: each element in exactly one group", () => {
    scenario(
      (a, b) => {
        group(a, ["X", "Y"], { id: "GA" });
        group(b, ["Y", "Z"], { id: "GB" });
      },
      ({ resolver }) => {
        const drawn = resolver.drawOrder();
        for (const id of ["X", "Y", "Z"])
          expect(drawn.filter((d) => d === id)).toHaveLength(1);
        expect(resolver.parentOf("X")).toBe("GA");
        expect(resolver.parentOf("Z")).toBe("GB");
        expect(["GA", "GB"]).toContain(resolver.parentOf("Y"));
        close(resolver.worldOrigin("X"), { x: 200, y: 200 });
        close(resolver.worldOrigin("Y"), { x: 400, y: 200 });
        close(resolver.worldOrigin("Z"), { x: 600, y: 200 });
      },
    );
  });

  it("grouping + concurrent move of a member: grouped, at the moved position", () => {
    scenario(
      (a, b) => {
        group(a, ["X", "Y"], { id: "GA" });
        moveElement(b, "X", 250, 260);
      },
      ({ resolver }) => {
        expect(resolver.parentOf("X")).toBe("GA");
        close(resolver.worldOrigin("X"), { x: 250, y: 260 });
      },
    );
  });

  it("ungroup + concurrent add to the group: every child stays visible and in place", () => {
    scenario(
      (a, b) => {
        dissolve(a, "Gr");
        reparent(b, "X", "Gr");
      },
      ({ resolver }) => {
        const drawn = resolver.drawOrder();
        expect(drawn).not.toContain("Gr");
        for (const id of ["M1", "M2", "X"]) expect(drawn).toContain(id);
        expect(resolver.logicalParentOf("X")).toBe(null);
        close(resolver.worldOrigin("X"), { x: 200, y: 200 });
        close(resolver.worldOrigin("M2"), { x: 3050, y: 3000 });
      },
    );
  });

  it("ungroup + concurrent move of the group: children end where the move put them", () => {
    scenario(
      (a, b) => {
        dissolve(a, "Gr");
        moveElement(b, "Gr", 4000, 3000);
      },
      ({ resolver }) => {
        close(resolver.worldOrigin("M1"), { x: 4000, y: 3000 });
        close(resolver.worldOrigin("M2"), { x: 4050, y: 3000 });
      },
    );
  });
});

describe("deletion and locking (section 5.7)", () => {
  it("delete + concurrent edit of the same element: the edit wins, the element stays", () => {
    scenario(
      (a, b) => {
        deleteElements(a, ["T"]);
        edit(b, () => (dataMap(b, "T").get("text") as Y.Text).insert(2, " there"), {
          touch: ["T"],
        });
        moveElement(b, "T", 20, 30);
      },
      ({ snapshot, resolver }) => {
        expect(resolver.isDeleted("T")).toBe(false);
        expect(JSON.stringify(snapshot.elements.T!.data.text)).toContain("Hi there");
        close(resolver.localPosition("T"), { x: 20, y: 30 });
      },
    );
  });

  it("delete + concurrent dissolve of the same group: dissolve wins, children kept", () => {
    scenario(
      (a, b) => {
        dissolve(a, "Gr");
        deleteElements(b, ["Gr"]);
      },
      ({ resolver }) => {
        expect(resolver.isDissolved("Gr")).toBe(true);
        for (const id of ["M1", "M2"]) {
          expect(resolver.isDeleted(id)).toBe(false);
          expect(resolver.drawOrder()).toContain(id);
        }
        close(resolver.worldOrigin("M2"), { x: 3050, y: 3000 });
      },
    );
  });
  it("lock + concurrent move: locked and moved", () => {
    scenario(
      (a, b) => {
        setLocked(a, "X", true);
        moveElement(b, "X", 0, 0);
      },
      ({ resolver }) => {
        expect(resolver.isLocked("X")).toBe(true);
        close(resolver.worldOrigin("X"), { x: 0, y: 0 });
      },
    );
  });

  it("a locked container locks its children until it is dissolved", () => {
    const a = base();
    setLocked(a, "Gr", true);
    expect(new Resolver(yLookup(a)).isLocked("M1")).toBe(true);
    dissolve(a, "Gr");
    expect(new Resolver(yLookup(a)).isLocked("M1")).toBe(false);
  });
});

describe("shared stops and routes (section 6.5)", () => {
  it("editing a shared stop from two routes: both edits show in both routes", () => {
    scenario(
      (a, b) => {
        renameStop(a, "S", "Opening");
        edit(b, () => stopNotes(b, "S").insert(0, "Say hello"), { touch: ["S"] });
      },
      ({ snapshot }) => {
        const stop = snapshot.stops.S!;
        expect(stop.name).toBe("Opening");
        expect(stop.notes.delta[0]?.insert).toBe("Say hello");
        expect(routeSteps(snapshot, "R1").map((s) => s.stop)).toEqual(["S", "S2"]);
        expect(routeSteps(snapshot, "R2").map((s) => s.stop)).toEqual(["S2", "S"]);
      },
    );
  });

  it("show and hide changes by different users on one stop are both kept", () => {
    scenario(
      (a, b) => {
        setVisibility(a, "S2", "X", "show");
        setVisibility(b, "S2", "Y", "hide");
      },
      ({ snapshot }) => {
        expect(snapshot.stops.S2!.visibility).toEqual({
          X: { action: "show" },
          Y: { action: "hide" },
        });
        // R1 = [S, S2]: X is hidden at S and shown at S2; Y is hidden from S2 on.
        expect([...hiddenAt(snapshot, "R1", 0)].sort()).toEqual(["X"]);
        expect([...hiddenAt(snapshot, "R1", 1)].sort()).toEqual(["Y"]);
      },
    );
  });

  it("show and hide of the same element on one stop: one wins, the same on both", () => {
    scenario(
      (a, b) => {
        setVisibility(a, "S2", "X", "show");
        setVisibility(b, "S2", "X", "hide");
      },
      ({ snapshot }) => {
        expect(["show", "hide"]).toContain(snapshot.stops.S2!.visibility.X?.action);
      },
    );
  });

  it("two view changes: one wins whole", () => {
    const viewA = { kind: "rect", space: null, x: 1, y: 1, w: 10, h: 10 } as const;
    const viewB = { kind: "frame", frame: "G", padding: 0.1 } as const;
    scenario(
      (a, b) => {
        setStopView(a, "S", viewA);
        setStopView(b, "S", viewB);
      },
      ({ snapshot }) => {
        expect([viewA, viewB]).toContainEqual(snapshot.stops.S!.view);
      },
    );
  });

  it("remove a stop + concurrent edit: the edit wins, the stop stays", () => {
    scenario(
      (a, b) => {
        removeStop(a, "S");
        renameStop(b, "S", "Kept");
      },
      ({ snapshot }) => {
        expect(snapshot.stops.S!.name).toBe("Kept");
        expect(routeSteps(snapshot, "R1").map((s) => s.stop)).toEqual(["S", "S2"]);
      },
    );
  });

  it("remove a stop with nobody working on it: skipped in every route until restored", () => {
    const a = base();
    removeStop(a, "S");
    expect(routeSteps(toSnapshot(a), "R1").map((s) => s.stop)).toEqual(["S2"]);
    restoreStop(a, "S");
    expect(routeSteps(toSnapshot(a), "R1").map((s) => s.stop)).toEqual(["S", "S2"]);
  });
  it("remove a stop + concurrent insert into a route: the stop stays (it was used)", () => {
    scenario(
      (a, b) => {
        removeStop(a, "S2");
        insertRouteEntry(b, "R2", "S2", { id: "e5" });
      },
      ({ snapshot }) => {
        expect(routeSteps(snapshot, "R2").map((s) => s.stop)).toEqual(["S2", "S", "S2"]);
      },
    );
  });
  it("two inserts at the same place in a route: both kept, same order", () => {
    scenario(
      (a, b) => {
        insertRouteEntry(a, "R1", "S", { id: "ea", index: 1 });
        insertRouteEntry(b, "R1", "S2", { id: "eb", index: 1 });
      },
      ({ snapshot }) => {
        const entries = routeSteps(snapshot, "R1").map((s) => s.entry);
        expect(entries).toHaveLength(4);
        expect(entries[0]).toBe("e1");
        expect(entries[3]).toBe("e2");
        expect(new Set(entries.slice(1, 3))).toEqual(new Set(["ea", "eb"]));
      },
    );
  });

  it("two moves of the same entry: one place, no duplicate", () => {
    scenario(
      (a, b) => {
        moveRouteEntry(a, "R1", "e1", 1);
        moveRouteEntry(b, "R1", "e1", 0);
      },
      ({ snapshot }) => {
        const entries = routeSteps(snapshot, "R1").map((s) => s.entry);
        expect(entries.sort()).toEqual(["e1", "e2"]);
      },
    );
  });

  it("remove an entry + concurrent move of it: the entry stays", () => {
    scenario(
      (a, b) => {
        removeRouteEntry(a, "R1", "e1");
        moveRouteEntry(b, "R1", "e1", 1);
      },
      ({ snapshot }) => {
        expect(routeSteps(snapshot, "R1").map((s) => s.entry)).toEqual(["e2", "e1"]);
      },
    );
  });
});
