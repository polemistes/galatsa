// SPDX-License-Identifier: GPL-3.0-or-later

// Regression tests for the defects found in the first review of
// docs/adr/0001-document-model-and-file-format.md. Each test names the section
// whose guarantee it checks.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { copyFragment } from "../model/fragment.ts";
import { Resolver, type Point } from "../model/resolve.ts";
import { hiddenAt, isHiddenBy, stopRegion, regionToWorld } from "../model/route.ts";
import { FRAME_TYPE } from "../model/types.ts";
import { validateSnapshot } from "../model/validate.ts";
import { pasteFragment, tidyUp } from "./document-ops.ts";
import {
  addElement,
  addRoute,
  addStop,
  bringToFront,
  dataMap,
  deleteElements,
  dissolve,
  edit,
  group,
  initDocument,
  insertRouteEntry,
  moveElement,
  reparent,
  setVisibility,
} from "./ops.ts";
import { createUndoManager, roots } from "./schema.ts";
import { fromSnapshot, hiddenContent, lineageOf, toSnapshot, yLookup } from "./snapshot.ts";
import { MergeIdentityError, forkDoc, syncDocs } from "./sync.ts";
import { seededOptions } from "./testing.ts";

const SHAPE = "galatsa.shapes/shape";
const ORDERS = [
  [1, 2],
  [2, 1],
] as const;

const resolve = (d: Y.Doc) => new Resolver(yLookup(d));

function close(actual: Point, expected: Point, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function base(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 100;
  const o = seededOptions(7);
  initDocument(doc, { id: "base" }, o);
  addElement(doc, { id: "F", type: FRAME_TYPE, x: 1000, y: 1000, size: { w: 800, h: 600 } }, o);
  addElement(doc, { id: "G", type: FRAME_TYPE, x: 5000, y: 0, size: { w: 800, h: 600 } }, o);
  addElement(doc, { id: "X", type: SHAPE, parent: "F", x: 10, y: 10, size: { w: 10, h: 10 } }, o);
  addElement(doc, { id: "Y", type: SHAPE, x: 400, y: 200, size: { w: 10, h: 10 } }, o);
  return doc;
}

describe("rebase: a move and a reparent both survive (section 5.3)", () => {
  for (const [ca, cb] of ORDERS) {
    it(`reparent back into the space the position was written in, clients ${ca}/${cb}`, () => {
      const d = base();
      reparent(d, "X", null);
      moveElement(d, "F", 1100, 1000);
      const a = forkDoc(d, ca);
      const b = forkDoc(d, cb);
      reparent(a, "X", "F");
      moveElement(b, "X", 50, 50);
      syncDocs(a, b);
      expect(toSnapshot(a)).toEqual(toSnapshot(b));
      expect(resolve(a).parentOf("X")).toBe("F");
      close(resolve(a).worldOrigin("X"), { x: 50, y: 50 });
    });

    it(`pending rebase + move + reparent: no drift with the old group, clients ${ca}/${cb}`, () => {
      const d = base();
      group(d, ["Y"], { id: "Gr" });
      const a = forkDoc(d, ca);
      const b = forkDoc(d, cb);
      moveElement(a, "Y", 10, 10);
      reparent(b, "Y", "G");
      syncDocs(a, b);
      const r = resolve(a);
      expect(r.parentOf("Y")).toBe("G");
      // A's move (10, 10 inside the group at 400, 200) survives.
      close(r.worldOrigin("Y"), { x: 410, y: 210 });
      moveElement(a, "Gr", 9999, 9999);
      close(resolve(a).worldOrigin("Y"), { x: 410, y: 210 });
    });

    it(`chains: two reparents in a row + a concurrent move, clients ${ca}/${cb}`, () => {
      const d = base();
      const a = forkDoc(d, ca);
      const b = forkDoc(d, cb);
      reparent(a, "X", "G");
      reparent(a, "X", null);
      moveElement(b, "X", 20, 30);
      syncDocs(a, b);
      const r = resolve(a);
      expect(r.parentOf("X")).toBe(null);
      close(r.worldOrigin("X"), { x: 1020, y: 1030 });
      moveElement(a, "F", 0, 0);
      moveElement(a, "G", 0, 0);
      close(resolve(a).worldOrigin("X"), { x: 1020, y: 1030 });
    });
  }
});

describe("merge identity (section 9.3)", () => {
  it("documents built from the same snapshot refuse to merge instead of losing edits", () => {
    const snapshot = toSnapshot(base());
    const a = fromSnapshot(snapshot);
    const b = fromSnapshot(snapshot);
    expect(lineageOf(a)).not.toBe(lineageOf(b));
    expect(() => syncDocs(a, b)).toThrow(MergeIdentityError);
    const fork = forkDoc(a, 9);
    expect(() => syncDocs(a, fork)).not.toThrow();
  });
});

describe("the JSON form is total and lossless (section 3.4)", () => {
  const cases: Array<[string, (d: Y.Doc) => void]> = [
    ["a shared map embedded in text", (d) => {
      const t = new Y.Text();
      dataMap(d, "E").set("t", t);
      t.insert(0, "ab");
      t.insertEmbed(1, new Y.Map());
    }],
    ["an undefined value", (d) => dataMap(d, "E").set("u", undefined)],
    ["binary data", (d) => dataMap(d, "E").set("b", new Uint8Array([1, 2, 255]))],
    ["binary nested in plain data", (d) => dataMap(d, "E").set("n", { a: [new Uint8Array([7])], u: undefined })],
    ["an attribute on XML text (Lexical style)", (d) => {
      const f = new Y.XmlFragment();
      dataMap(d, "E").set("x", f);
      const t = new Y.XmlText();
      f.insert(0, [t]);
      t.insert(0, "hi");
      t.setAttribute("__type", "paragraph");
    }],
    ["an attribute on text", (d) => {
      const t = new Y.Text();
      dataMap(d, "E").set("t", t);
      t.insert(0, "hi");
      t.setAttribute("dir", "rtl");
    }],
    ["a shared type as an XML attribute", (d) => {
      const f = new Y.XmlFragment();
      dataMap(d, "E").set("x", f);
      const e = new Y.XmlElement("p");
      f.insert(0, [e]);
      e.setAttribute("m", new Y.Map() as unknown as string);
    }],
    ["an XML hook", (d) => {
      const f = new Y.XmlFragment();
      dataMap(d, "E").set("x", f);
      const hook = new Y.XmlHook("h");
      f.insert(0, [hook as unknown as Y.XmlElement]);
      hook.set("k", 1);
    }],
    ["XML text embedded in XML text (Lexical)", (d) => {
      const t = new Y.XmlText();
      dataMap(d, "E").set("root", t);
      t.insertEmbed(0, new Y.XmlText());
    }],
    ["a data key named __proto__", (d) => dataMap(d, "E").set("__proto__", { a: 1 })],
    ["a nested __proto__ key in plain data", (d) => dataMap(d, "E").set("k", JSON.parse('{"__proto__": {"a": 1}, "b": 2}'))],
    ["an element id __proto__", (d) => {
      addElement(d, { id: "__proto__", type: "other.ext/thing", x: 0, y: 0, size: { w: 1, h: 1 } });
    }],
  ];
  for (const [name, change] of cases) {
    it(`never throws, and round-trips locally: ${name}`, () => {
      const d = new Y.Doc();
      initDocument(d, { id: "d" });
      addElement(d, { id: "E", type: "other.ext/thing", x: 0, y: 0, size: { w: 1, h: 1 } });
      edit(d, () => change(d));
      const s = toSnapshot(d);
      expect(toSnapshot(fromSnapshot(s))).toEqual(s);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    });
  }

  it("keeps an element id __proto__ as an own key", () => {
    const d = new Y.Doc();
    initDocument(d, { id: "d" });
    addElement(d, { id: "__proto__", type: FRAME_TYPE, x: 0, y: 0, size: { w: 1, h: 1 } });
    const s = toSnapshot(d);
    expect(Object.keys(s.elements)).toEqual(["__proto__"]);
    expect(JSON.stringify(s.elements)).toContain('"__proto__"');
  });

  it("a peer injecting an odd value does not break saving for anyone", () => {
    const a = new Y.Doc();
    initDocument(a, { id: "d" });
    addElement(a, { id: "E", type: "other.ext/thing", x: 0, y: 0, size: { w: 1, h: 1 } });
    const b = forkDoc(a, 77);
    edit(b, () => {
      const t = new Y.Text();
      dataMap(b, "E").set("t", t);
      t.insertEmbed(0, new Y.Map());
      dataMap(b, "E").set("bin", new Uint8Array([1]));
    });
    syncDocs(a, b);
    const s = toSnapshot(a);
    expect(validateSnapshot(s)).toEqual([]);
    expect(toSnapshot(fromSnapshot(s))).toEqual(s);
  });
});

describe("undo never hard-deletes records (section 10)", () => {
  it("undoing a grouping while someone adds to the group keeps the addition in place", () => {
    const d = new Y.Doc();
    d.clientID = 100;
    initDocument(d, { id: "u" });
    addElement(d, { id: "X", type: SHAPE, x: 100, y: 100, size: { w: 10, h: 10 } });
    addElement(d, { id: "Y", type: SHAPE, x: 300, y: 100, size: { w: 10, h: 10 } });
    const a = forkDoc(d, 1);
    const undo = createUndoManager(a, 0);
    group(a, ["X", "Y"], { id: "G" });
    const b = forkDoc(a, 2);
    addElement(b, { id: "Z", type: SHAPE, parent: "G", x: 50, y: 50, size: { w: 10, h: 10 } });
    const before = resolve(b).worldOrigin("Z");
    undo.undo();
    syncDocs(a, b);
    const r = resolve(a);
    expect(roots(a).elements.has("G")).toBe(true);
    expect(r.isGone("G")).toBe(true);
    expect(r.drawOrder()).toEqual(expect.arrayContaining(["X", "Y", "Z"]));
    close(r.worldOrigin("Z"), before);
    close(r.worldOrigin("X"), { x: 100, y: 100 });
  });

  it("undoing a creation while someone edits the element keeps their work", () => {
    const d = base();
    const a = forkDoc(d, 1);
    const undo = createUndoManager(a, 0);
    addElement(a, {
      id: "T",
      type: "galatsa.text/text",
      x: 0,
      y: 0,
      size: { w: 10, h: 10 },
      data: { text: { $y: "text", delta: [{ insert: "hi" }] } },
    });
    const b = forkDoc(a, 2);
    edit(b, () => (dataMap(b, "T").get("text") as Y.Text).insert(2, " -- written offline"), {
      touch: ["T"],
    });
    undo.undo();
    syncDocs(a, b);
    expect(roots(a).elements.has("T")).toBe(true);
    expect(resolve(a).isDeleted("T")).toBe(false);
    expect((dataMap(a, "T").get("text") as Y.Text).toString()).toBe("hi -- written offline");
  });

  it("undo and redo of a creation, with nobody else involved", () => {
    const a = base();
    const undo = createUndoManager(a, 0);
    addElement(a, { id: "T", type: SHAPE, x: 0, y: 0, size: { w: 1, h: 1 } });
    undo.undo();
    expect(roots(a).elements.has("T")).toBe(true);
    expect(resolve(a).isDeleted("T")).toBe(true);
    undo.redo();
    expect(resolve(a).isDeleted("T")).toBe(false);
  });
});

describe("precision of operations (section 7.3)", () => {
  it("reparenting and grouping deep inside a frame far from the origin stay exact", () => {
    const d = new Y.Doc();
    initDocument(d, { id: "p" });
    addElement(d, { id: "Far", type: FRAME_TYPE, x: 2 ** 60, y: 0, size: { w: 1, h: 1 } });
    addElement(d, { id: "A", type: FRAME_TYPE, parent: "Far", x: 0, y: 0, size: { w: 1e-6, h: 1e-6 } });
    addElement(d, { id: "B", type: FRAME_TYPE, parent: "Far", x: 0, y: 0, size: { w: 1e-6, h: 1e-6 } });
    addElement(d, { id: "X", type: SHAPE, parent: "A", x: 3e-7, y: 3e-7, size: { w: 1e-8, h: 1e-8 } });
    addElement(d, { id: "Y", type: SHAPE, parent: "A", x: 5e-7, y: 5e-7, size: { w: 1e-8, h: 1e-8 } });
    reparent(d, "X", "B");
    expect(resolve(d).localPosition("X")).toEqual({ x: 3e-7, y: 3e-7 });
    group(d, ["Y"], { id: "Gr" });
    expect(resolve(d).localPosition("Gr")).toEqual({ x: 5e-7, y: 5e-7 });
    expect(resolve(d).localPosition("Y")).toEqual({ x: 0, y: 0 });
    expect(resolve(d).positionIn("Y", "Far")).toEqual({ x: 5e-7, y: 5e-7 });
  });
});

describe("gone containers in operations (section 4.2, 6.4)", () => {
  function ungrouped(): Y.Doc {
    const d = base();
    group(d, ["Y"], { id: "Gr" });
    addElement(d, { id: "W", type: SHAPE, x: 0, y: 0, size: { w: 1, h: 1 } });
    dissolve(d, "Gr");
    return d;
  }

  it("bring to front moves a former group member in front of everything the user sees", () => {
    const d = ungrouped();
    bringToFront(d, "Y");
    const r = resolve(d);
    expect(r.logicalChildren(null).at(-1)).toBe("Y");
    close(r.worldOrigin("Y"), { x: 400, y: 200 });
  });

  it("a former group member can be grouped with an element it now sits beside", () => {
    const d = ungrouped();
    const g = group(d, ["Y", "W"]);
    const r = resolve(d);
    expect(r.parentOf("Y")).toBe(g);
    close(r.worldOrigin("Y"), { x: 400, y: 200 });
  });

  it("a stop that hides a dissolved group no longer hides its former members", () => {
    const d = ungrouped();
    const stop = addStop(d, { view: { kind: "rect", space: null, x: 0, y: 0, w: 1, h: 1 } });
    const route = addRoute(d);
    insertRouteEntry(d, route, stop);
    setVisibility(d, stop, "Gr", "hide");
    const s = toSnapshot(d);
    const hidden = hiddenAt(s, route, 0);
    expect(hidden.has("Gr")).toBe(true);
    expect(isHiddenBy(resolve(d), hidden, "Y")).toBe(false);
  });

  it("a move never rewrites a parent that has not arrived yet", () => {
    const d = base();
    const peer = forkDoc(d, 5);
    addElement(peer, { id: "H", type: FRAME_TYPE, x: 10, y: 10, size: { w: 1, h: 1 } });
    reparent(peer, "Y", "H");
    // Deliver only the reparent, not the record of H.
    const late = new Y.Doc();
    late.clientID = 6;
    Y.applyUpdate(late, Y.encodeStateAsUpdate(d));
    const element = roots(peer).elements.get("Y")!;
    edit(late, () => {
      const map = roots(late).elements.get("Y")!;
      map.set("parent", element.get("parent"));
    }, { origin: "simulated-delivery" });
    moveElement(late, "Y", 1, 2);
    expect(roots(late).elements.get("Y")!.get("parent")).toBe("H");
  });
});

describe("tidy up and paste (sections 3.5, 5.8)", () => {
  it("tidy up removes what is gone and keeps what the user sees", () => {
    const d = base();
    addElement(d, { id: "Z", type: SHAPE, parent: "G", x: 5, y: 5, size: { w: 1, h: 1 } });
    const stop = addStop(d, { view: { kind: "frame", frame: "G", padding: 0.1 } });
    deleteElements(d, ["G"]);
    reparent(d, "Y", "F");
    group(d, ["X"], { id: "Gx" });
    dissolve(d, "Gx");
    const before = resolve(d);
    const order = before.drawOrder();
    const world = Object.fromEntries(order.map((id) => [id, before.worldOrigin(id)]));
    const region = regionToWorld(before, stopRegion(toSnapshot(d), before, stop)!);
    const summary = tidyUp(d);
    expect(summary.elements).toBe(3);
    const after = resolve(d);
    expect(after.drawOrder()).toEqual(order);
    for (const id of order) close(after.worldOrigin(id), world[id]!);
    const s = toSnapshot(d);
    expect(validateSnapshot(s)).toEqual([]);
    expect(Object.keys(s.elements).sort()).toEqual(["F", "X", "Y"]);
    expect(s.stops[stop]!.view.kind).toBe("rect");
    expect(regionToWorld(after, stopRegion(s, after, stop)!)).toEqual(region);
  });

  it("paste gives new ids and remaps references inside data of unknown types", () => {
    const d = base();
    addElement(d, {
      id: "C",
      type: "other.ext/connector",
      parent: "F",
      x: 0,
      y: 0,
      size: { w: 1, h: 1 },
      refs: ["X", "Y"],
      data: { from: "X", to: "Y", label: { $y: "text", delta: [{ insert: "X" }] } },
    });
    const stop = addStop(d, { view: { kind: "frame", frame: "F", padding: 0 } });
    setVisibility(d, stop, "X", "show");
    const fragment = copyFragment(toSnapshot(d), ["F"], [stop]);
    const undo = createUndoManager(d, 0);
    const { ids } = pasteFragment(d, fragment, { dx: 5000, dy: 0 });
    const s = toSnapshot(d);
    const f2 = ids.get("F")!;
    const x2 = ids.get("X")!;
    const c2 = s.elements[ids.get("C")!]!;
    expect(c2.parent).toBe(f2);
    // X was pasted, so its reference is remapped; Y was not, so it stays.
    expect(c2.data.from).toBe(x2);
    expect(c2.data.to).toBe("Y");
    expect(c2.refs).toEqual([x2, "Y"]);
    // Text is user content, never remapped.
    expect(c2.data.label).toEqual({ $y: "text", delta: [{ insert: "X" }] });
    const s2 = s.stops[ids.get(stop)!]!;
    expect(s2.view).toEqual({ kind: "frame", frame: f2, padding: 0 });
    expect(Object.keys(s2.visibility)).toEqual([x2]);
    close(resolve(d).worldOrigin(x2), { x: 6010, y: 1010 });
    undo.undo();
    expect(resolve(d).isDeleted(f2)).toBe(true);
    expect(roots(d).elements.has(f2)).toBe(true);
  });

  it("a document read from JSON has no hidden content", () => {
    const d = fromSnapshot(toSnapshot(base()));
    expect(hiddenContent(d)).toEqual([]);
    d.getMap("secretRoot").set("payload", 1);
    roots(d).elements.get("X")!.set("smuggled", 1);
    expect(hiddenContent(d)).toEqual(["root secretRoot", "elements.X.smuggled"]);
  });
});

