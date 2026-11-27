// SPDX-License-Identifier: GPL-3.0-or-later

// Stops and routes read without the elements, and rectangle stops whose space
// is not a container of a fragment (docs/adr/0013-routes-and-stops.md).

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { copyFragment, type Fragment } from "../model/fragment.ts";
import { Resolver } from "../model/resolve.ts";
import { regionToWorld, stopRegion } from "../model/route.ts";
import { FRAME_TYPE } from "../model/types.ts";
import { pasteFragment } from "./document-ops.ts";
import * as ops from "./ops.ts";
import { stopsAndRoutesOf, toSnapshot, yLookup } from "./snapshot.ts";

const SHAPE = "galatsa.shapes/shape";

function base(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 7;
  ops.initDocument(doc, { id: "d" });
  return doc;
}

describe("stopsAndRoutesOf", () => {
  it("reads stops and routes as toSnapshot does", () => {
    const doc = base();
    ops.addElement(doc, {
      id: "F",
      type: FRAME_TYPE,
      x: 10,
      y: 10,
      size: { w: 100, h: 50 },
    });
    const a = ops.addStop(doc, { view: { kind: "frame", frame: "F", padding: 0.1 } });
    const b = ops.addStop(doc, {
      view: { kind: "rect", space: null, x: 1, y: 2, w: 3, h: 4 },
      name: "B",
      notes: [{ insert: "hello" }],
    });
    ops.setVisibility(doc, b, "F", "show");
    const r1 = ops.addRoute(doc, { name: "one" });
    const r2 = ops.addRoute(doc);
    ops.insertRouteEntry(doc, r1, a);
    ops.insertRouteEntry(doc, r1, b);
    ops.insertRouteEntry(doc, r2, b);
    ops.removeStop(doc, a);
    // A record the grammar leaves out is left out here too.
    doc.transact(() => doc.getMap("stops").set("not an id!", new Y.Map()));
    const snapshot = toSnapshot(doc);
    expect(stopsAndRoutesOf(doc)).toEqual({
      stops: snapshot.stops,
      routes: snapshot.routes,
    });
  });
});

describe("pasting rectangle stops", () => {
  /** A fragment of frame G (at 50, 50) with a stop in the given space. */
  function fragmentWith(space: string | null, extra?: Partial<Fragment>): Fragment {
    const doc = base();
    ops.addElement(doc, {
      id: "G",
      type: FRAME_TYPE,
      x: 50,
      y: 50,
      size: { w: 200, h: 100 },
    });
    ops.addElement(doc, { id: "S", type: SHAPE, x: 60, y: 60, size: { w: 5, h: 5 } });
    const stop = ops.addStop(doc, {
      id: "T",
      view: { kind: "rect", space: null, x: 0, y: 0, w: 10, h: 10 },
    });
    const fragment = copyFragment(toSnapshot(doc), ["G", "S"], [stop]);
    return {
      ...fragment,
      stops: {
        T: {
          ...fragment.stops["T"]!,
          view: { kind: "rect", space, x: 5, y: 6, w: 10, h: 10 },
        },
      },
      ...extra,
    };
  }

  function pastedRegion(fragment: Fragment) {
    const target = base();
    ops.addElement(target, {
      id: "P",
      type: FRAME_TYPE,
      x: 1000,
      y: 1000,
      size: { w: 500, h: 500 },
    });
    // An element of the target with the id the fragment names.
    ops.addElement(target, {
      id: "elsewhere",
      type: FRAME_TYPE,
      x: -500,
      y: -500,
      size: { w: 9, h: 9 },
    });
    const { ids } = pasteFragment(target, fragment, { parent: "P", dx: 3, dy: 4 });
    const snapshot = toSnapshot(target);
    const id = ids.get("T")!;
    const r = new Resolver(yLookup(target));
    const region = stopRegion(snapshot, r, id)!;
    return { view: snapshot.stops[id]!.view, world: regionToWorld(r, region), ids };
  }

  it("keeps a stop in the space of a pasted frame, renamed", () => {
    const { view, ids } = pastedRegion(fragmentWith("G"));
    expect(view).toMatchObject({ kind: "rect", space: ids.get("G"), x: 5, y: 6 });
  });

  it("reads a stop in no space, an outside space or a non-container in the paste's target", () => {
    const expected = pastedRegion(fragmentWith(null));
    expect(expected.view).toMatchObject({ space: "P", x: 8, y: 10 });
    expect(expected.world).toMatchObject({ x: 1008, y: 1010 });
    for (const space of ["elsewhere", "S", "missingElement00000000"]) {
      const { view, world } = pastedRegion(fragmentWith(space));
      expect(view).toEqual(expected.view);
      expect(world).toEqual(expected.world);
    }
  });

  it("copies a stop in the space of a shape in the roots' space", () => {
    const doc = base();
    ops.addElement(doc, { id: "S", type: SHAPE, x: 60, y: 60, size: { w: 5, h: 5 } });
    ops.addElement(doc, {
      id: "G",
      type: FRAME_TYPE,
      x: 50,
      y: 50,
      size: { w: 200, h: 100 },
    });
    // A shape is not a space: the rectangle is read in the root's space.
    const stop = ops.addStop(doc, {
      view: { kind: "rect", space: "S", x: 70, y: 80, w: 10, h: 10 },
    });
    const fragment = copyFragment(toSnapshot(doc), ["S", "G"], [stop]);
    expect(fragment.stops[stop]!.view).toMatchObject({ space: null, x: 70, y: 80 });
  });
});
