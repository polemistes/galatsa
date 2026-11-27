// SPDX-License-Identifier: GPL-3.0-or-later

// Each basic command against the real document model: what it does, that it
// is one undo step with its own name, and what it refuses (locked elements,
// elements of a missing extension, types that forbid it, bad arguments).

import { GROUP_TYPE, type ElementId, type Fragment } from "@galatsa/core";
import { forkDoc, setLocked, syncDocs } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import { BASICS, DUPLICATE_OFFSET, readFragment, type PasteOutcome } from "./index.ts";
import {
  MISSING_TYPE,
  SHAPE_TYPE,
  setupBasics,
  visibleState,
  type BasicsSetup,
} from "./testing.ts";

const DISABLED = { ok: false, reason: "disabled" };

function world(t: BasicsSetup, id: ElementId) {
  return t.resolver().worldOrigin(id);
}

function order(t: BasicsSetup, parent: ElementId | null = null): ElementId[] {
  return t.resolver().logicalChildren(parent);
}

function steps(t: BasicsSetup): number {
  return t.undo.undoStack.length;
}

/** Runs a command that must be refused, and checks that nothing changed. */
function refused(t: BasicsSetup, id: string, args?: unknown): void {
  const before = visibleState(t.doc);
  const count = steps(t);
  expect(t.host.commands.isEnabled(id, t.env(), args)).toBe(false);
  expect(t.run(id, args)).toEqual(DISABLED);
  expect(visibleState(t.doc)).toEqual(before);
  expect(steps(t)).toBe(count);
}

/** Counts the document updates (transactions that changed something) during `fn`. */
function updates(t: BasicsSetup, fn: () => void): number {
  let count = 0;
  const count1 = () => (count += 1);
  t.doc.on("update", count1);
  try {
    fn();
  } finally {
    t.doc.off("update", count1);
  }
  return count;
}

describe("the basics extension", () => {
  it("loads, and offers its commands per mode with their shortcuts", () => {
    const t = setupBasics();
    const quick = t.host.commands.list("quick").map((c) => c.id);
    expect(quick).toEqual(
      expect.arrayContaining([
        BASICS.move,
        BASICS.resize,
        BASICS.group,
        BASICS.delete,
        BASICS.undo,
        BASICS.redo,
        BASICS.selectAll,
      ]),
    );
    expect(quick).not.toContain(BASICS.lock);
    expect(quick).not.toContain(BASICS.bringForward);
    const { map, conflicts } = t.host.commands.shortcuts("advanced");
    expect(conflicts).toEqual([]);
    expect(map.get("Mod+z")).toBe(BASICS.undo);
    expect(map.get("Mod+Shift+z")).toBe(BASICS.redo);
    expect(map.get("Mod+g")).toBe(BASICS.group);
  });

  it("names undo steps after the command, in both languages", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    t.must(BASICS.move, { ids: [a], dx: 5, dy: 0 });
    const history = t.host.commands.history(t.env());
    const step = history.undoStep();
    expect(step).toEqual({ command: BASICS.move, label: "galatsa.basics:move.step" });
    const name = () =>
      t.i18n.t("galatsa.basics:undo.named", { step: t.i18n.t(step!.label!) });
    expect(name()).toBe("Undo move");
    t.i18n.setLocale("nb");
    expect(name()).toBe("Angre flytting");
    t.must(BASICS.undo);
    expect(history.redoStep()).toEqual(step);
  });
});

describe("move", () => {
  it("moves elements by an offset in one transaction and one undo step", () => {
    const t = setupBasics();
    const ids = [t.shape(0, 0), t.shape(20, 0), t.shape(40, 0)];
    const n = updates(t, () => t.must(BASICS.move, { ids, dx: 5, dy: 7 }));
    expect(n).toBeLessThanOrEqual(2); // the move and the work tracker's revisions
    expect(ids.map((id) => world(t, id))).toEqual([
      { x: 5, y: 7 },
      { x: 25, y: 7 },
      { x: 45, y: 7 },
    ]);
    expect(steps(t)).toBe(4);
    t.must(BASICS.undo);
    expect(world(t, ids[2]!)).toEqual({ x: 40, y: 0 });
  });

  it("moves what is inside a moved container once, with the container", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    t.must(BASICS.move, { ids: [f, inner], dx: 100, dy: 0 });
    expect(world(t, f)).toEqual({ x: 100, y: 0 });
    expect(world(t, inner)).toEqual({ x: 110, y: 10 });
  });

  it("moves elements of a missing extension, with their data unchanged", () => {
    const t = setupBasics();
    const m = t.missing(0, 0);
    const data = t.element(m).data;
    t.must(BASICS.move, { ids: [m], dx: 3, dy: 4 });
    expect(world(t, m)).toEqual({ x: 3, y: 4 });
    expect(t.element(m).data).toEqual(data);
    expect(t.element(m).type).toBe(MISSING_TYPE);
  });

  it("refuses locked elements, elements in a locked frame, gone elements and bad arguments", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const f = t.frame(100, 0);
    const inner = t.shape(110, 10, 10, 10, f);
    const gone = t.shape(50, 50);
    t.must(BASICS.delete, { ids: [gone] });
    t.must(BASICS.lock, { ids: [f] });
    refused(t, BASICS.move, { ids: [f], dx: 1, dy: 1 });
    refused(t, BASICS.move, { ids: [inner], dx: 1, dy: 1 });
    refused(t, BASICS.move, { ids: [a, inner], dx: 1, dy: 1 });
    refused(t, BASICS.move, { ids: [gone], dx: 1, dy: 1 });
    refused(t, BASICS.move, { ids: ["nothing"], dx: 1, dy: 1 });
    refused(t, BASICS.move, { ids: [a], dx: 0, dy: 0 });
    refused(t, BASICS.move, { ids: [a], dx: Number.NaN, dy: 1 });
    refused(t, BASICS.move, { ids: [], dx: 1, dy: 1 });
    refused(t, BASICS.move);
  });
});

describe("resize", () => {
  it("sets the size, and the position when given, as one step", () => {
    const t = setupBasics();
    const a = t.shape(0, 0, 10, 10);
    const n = updates(t, () =>
      t.must(BASICS.resize, { id: a, w: 30, h: 20, x: -5, y: -5 }),
    );
    expect(n).toBeLessThanOrEqual(2);
    expect(t.element(a).size).toEqual({ w: 30, h: 20 });
    expect(world(t, a)).toEqual({ x: -5, y: -5 });
    t.must(BASICS.undo);
    expect(t.element(a).size).toEqual({ w: 10, h: 10 });
    expect(world(t, a)).toEqual({ x: 0, y: 0 });
    const f = t.frame(0, 100);
    t.must(BASICS.resize, { id: f, w: 50, h: 60 });
    expect(t.element(f).size).toEqual({ w: 50, h: 60 });
  });

  it("refuses elements of a missing extension, types that forbid it, groups and locked elements", () => {
    const t = setupBasics();
    const m = t.missing(0, 0);
    const r = t.rigid(20, 0);
    const a = t.shape(40, 0);
    const b = t.shape(60, 0);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, b] });
    const c = t.shape(80, 0);
    setLocked(t.doc, c, true);
    refused(t, BASICS.resize, { id: m, w: 5, h: 5 });
    refused(t, BASICS.resize, { id: r, w: 5, h: 5 });
    refused(t, BASICS.resize, { id: g, w: 5, h: 5 });
    refused(t, BASICS.resize, { id: c, w: 5, h: 5 });
    refused(t, BASICS.resize, { id: a, w: -1, h: 5 });
    refused(t, BASICS.resize, { id: a, w: 5, h: 5, x: 1 });
  });

  it("takes the corner in the space of the container the user sees, also for a former group member", () => {
    const t = setupBasics();
    const x = t.shape(100, 100, 10, 10);
    const y = t.shape(200, 100, 10, 10);
    const g = t.must<ElementId>(BASICS.group, { ids: [x, y] });
    t.must(BASICS.ungroup, { ids: [g] });
    // X is stored in the dissolved group's space, and seen at the root.
    expect(t.resolver().parentOf(x)).toBe(g);
    t.must(BASICS.resize, { id: x, w: 20, h: 20, x: 90, y: 95 });
    expect(world(t, x)).toEqual({ x: 90, y: 95 });
    expect(t.element(x).size).toEqual({ w: 20, h: 20 });
  });
});

describe("scale", () => {
  it("keeps proportions in a group and moves elements of a missing extension without resizing them", () => {
    const t = setupBasics();
    const a = t.shape(0, 0, 10, 10);
    const m = t.missing(20, 0, 10, 10);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, m] });
    t.must(BASICS.scale, { ids: [g], anchor: { x: 0, y: 0 }, factor: 2 });
    expect(t.element(a).size).toEqual({ w: 20, h: 20 });
    expect(world(t, a)).toEqual({ x: 0, y: 0 });
    // The placeholder keeps its size; its centre goes where the scaled centre would.
    expect(t.element(m).size).toEqual({ w: 10, h: 10 });
    expect(world(t, m)).toEqual({ x: 45, y: 5 });
    expect(steps(t)).toBe(4);
  });

  it("refuses a selection of nothing but placeholders, locked elements and bad factors", () => {
    const t = setupBasics();
    const m = t.missing(0, 0);
    const a = t.shape(20, 0);
    refused(t, BASICS.scale, { ids: [m], anchor: { x: 0, y: 0 }, factor: 2 });
    refused(t, BASICS.scale, { ids: [a], anchor: { x: 0, y: 0 }, factor: 0 });
    refused(t, BASICS.scale, { ids: [a], anchor: { x: 0, y: 0 }, factor: 1 });
    refused(t, BASICS.scale, { ids: [a], factor: 2 });
    setLocked(t.doc, a, true);
    refused(t, BASICS.scale, { ids: [a], anchor: { x: 0, y: 0 }, factor: 2 });
  });

  it("refuses scaling a group with a locked member", () => {
    const t = setupBasics();
    const x = t.shape(0, 0, 10, 10);
    const y = t.shape(20, 0, 10, 10);
    const g = t.must<ElementId>(BASICS.group, { ids: [x, y] });
    t.must(BASICS.lock, { ids: [x] });
    refused(t, BASICS.scale, { ids: [g], anchor: { x: 0, y: 0 }, factor: 2 });
    expect(t.element(x).size).toEqual({ w: 10, h: 10 });
  });

  it("scales what is still shown inside a dissolved group or a deleted frame in a scaled group", () => {
    const t = setupBasics();
    const x = t.shape(0, 0, 10, 10);
    const inner = t.must<ElementId>(BASICS.group, { ids: [x] });
    const f = t.frame(100, 0, 50, 50);
    const z = t.shape(110, 10, 10, 10, f);
    const y = t.shape(200, 0, 10, 10);
    const g = t.must<ElementId>(BASICS.group, { ids: [inner, f, y] });
    t.must(BASICS.ungroup, { ids: [inner] });
    // Another user deletes F while this one, not knowing, moves Z: Z survives.
    const other = setupBasics({ doc: forkDoc(t.doc) });
    other.must(BASICS.delete, { ids: [f] });
    t.must(BASICS.move, { ids: [z], dx: 1, dy: 0 });
    syncDocs(t.doc, other.doc);
    const r0 = t.resolver();
    expect([r0.isGone(f), r0.isGone(z), r0.logicalParentOf(x)]).toEqual([true, false, g]);
    t.must(BASICS.scale, { ids: [g], anchor: { x: 0, y: 0 }, factor: 2 });
    const r = t.resolver();
    expect(t.element(x).size).toEqual({ w: 20, h: 20 });
    expect(r.worldOrigin(x)).toEqual({ x: 0, y: 0 });
    expect(t.element(y).size).toEqual({ w: 20, h: 20 });
    expect(r.worldOrigin(y)).toEqual({ x: 400, y: 0 });
    expect(t.element(z).size).toEqual({ w: 20, h: 20 });
    expect(r.worldOrigin(z)).toEqual({ x: 422, y: 20 });
  });
});

describe("rotate", () => {
  it("sets or adds a rotation, kept in [0, 2π), in one step", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const b = t.shape(20, 0);
    t.must(BASICS.rotate, { ids: [a, b], rot: 1 });
    expect([t.element(a).rot, t.element(b).rot]).toEqual([1, 1]);
    t.must(BASICS.rotate, { ids: [a], by: -2 });
    expect(t.element(a).rot).toBeCloseTo(2 * Math.PI - 1);
    t.must(BASICS.undo);
    expect(t.element(a).rot).toBe(1);
  });

  it("refuses frames, groups, elements of a missing extension, rigid types and locked elements", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const a = t.shape(200, 0);
    const b = t.shape(220, 0);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, b] });
    const m = t.missing(300, 0);
    const r = t.rigid(400, 0);
    const c = t.shape(500, 0);
    setLocked(t.doc, c, true);
    for (const id of [f, g, m, r, c]) refused(t, BASICS.rotate, { ids: [id], rot: 1 });
    refused(t, BASICS.rotate, { ids: [a], rot: 1, by: 1 });
    refused(t, BASICS.rotate, { ids: [a] });
  });
});

describe("reparent", () => {
  it("moves elements into a frame and out again without moving them on the canvas", () => {
    const t = setupBasics();
    const f = t.frame(100, 100, 200, 200);
    const a = t.shape(150, 150);
    const b = t.shape(170, 150);
    t.must(BASICS.reparent, { ids: [b, a], target: f });
    expect(t.resolver().parentOf(a)).toBe(f);
    expect(world(t, a)).toEqual({ x: 150, y: 150 });
    // Their order among each other is kept.
    expect(order(t, f)).toEqual([a, b]);
    t.must(BASICS.move, { ids: [f], dx: 10, dy: 0 });
    expect(world(t, a)).toEqual({ x: 160, y: 150 });
    t.must(BASICS.reparent, { ids: [a], target: null });
    expect(t.resolver().parentOf(a)).toBeNull();
    expect(world(t, a)).toEqual({ x: 160, y: 150 });
    t.must(BASICS.undo);
    expect(t.resolver().parentOf(a)).toBe(f);
  });

  it("refuses locked or gone targets, non-containers, cycles, locked elements and no-ops", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.frame(10, 10, 20, 20, f);
    const a = t.shape(200, 0);
    const locked = t.frame(300, 0);
    const gone = t.frame(500, 0);
    t.must(BASICS.delete, { ids: [gone] });
    setLocked(t.doc, locked, true);
    refused(t, BASICS.reparent, { ids: [a], target: locked });
    refused(t, BASICS.reparent, { ids: [a], target: gone });
    refused(t, BASICS.reparent, { ids: [f], target: a });
    refused(t, BASICS.reparent, { ids: [f], target: inner });
    refused(t, BASICS.reparent, { ids: [f], target: f });
    refused(t, BASICS.reparent, { ids: [a], target: null });
    refused(t, BASICS.reparent, { ids: [locked], target: f });
  });
});

describe("z-order", () => {
  it("brings to front and sends to back, keeping the order of several", () => {
    const t = setupBasics();
    const [a, b, c, d] = [t.shape(0, 0), t.shape(1, 0), t.shape(2, 0), t.shape(3, 0)];
    t.must(BASICS.bringToFront, { ids: [b, a] });
    expect(order(t)).toEqual([c, d, a, b]);
    t.must(BASICS.sendToBack, { ids: [b, d] });
    expect(order(t)).toEqual([d, b, c, a]);
    t.must(BASICS.undo);
    expect(order(t)).toEqual([c, d, a, b]);
  });

  it("moves one step, with a run of chosen elements moving together", () => {
    const t = setupBasics();
    const [a, b, c, d] = [t.shape(0, 0), t.shape(1, 0), t.shape(2, 0), t.shape(3, 0)];
    t.must(BASICS.bringForward, { ids: [a, b] });
    expect(order(t)).toEqual([c, a, b, d]);
    t.must(BASICS.bringForward, { ids: [a, b] });
    expect(order(t)).toEqual([c, d, a, b]);
    // At the front: nothing to do.
    refused(t, BASICS.bringForward, { ids: [a, b] });
    t.must(BASICS.sendBackward, { ids: [b] });
    expect(order(t)).toEqual([c, d, b, a]);
    // A run at the back cannot move back.
    refused(t, BASICS.sendBackward, { ids: [c, d] });
    t.must(BASICS.sendBackward, { ids: [d, a] });
    expect(order(t)).toEqual([d, c, a, b]);
  });

  it("refuses what would change nothing and locked elements", () => {
    const t = setupBasics();
    const [a, b] = [t.shape(0, 0), t.shape(1, 0)];
    refused(t, BASICS.bringToFront, { ids: [b] });
    refused(t, BASICS.sendToBack, { ids: [a] });
    refused(t, BASICS.sendBackward, { ids: [a] });
    setLocked(t.doc, a, true);
    refused(t, BASICS.bringToFront, { ids: [a] });
  });
});

describe("group and ungroup", () => {
  it("groups elements as one undo step, and undo dissolves the group", () => {
    const t = setupBasics();
    const [a, b, c] = [t.shape(0, 0), t.shape(20, 0), t.shape(40, 0)];
    const g = t.must<ElementId>(BASICS.group, { ids: [a, c] });
    expect(t.element(g).type).toBe(GROUP_TYPE);
    expect(order(t, g)).toEqual([a, c]);
    expect(order(t)).toEqual([b, g]);
    expect(t.services.state.selection).toEqual([g]);
    expect(world(t, c)).toEqual({ x: 40, y: 0 });
    expect(steps(t)).toBe(4);
    t.must(BASICS.undo);
    expect(t.resolver().isGone(g)).toBe(true);
    expect(order(t)).toEqual([a, b, c]);
  });

  it("ungroups, leaving the members in place and selected", () => {
    const t = setupBasics();
    const [a, b] = [t.shape(0, 0), t.shape(20, 0)];
    const g = t.must<ElementId>(BASICS.group, { ids: [a, b] });
    t.must(BASICS.move, { ids: [g], dx: 5, dy: 5 });
    t.must(BASICS.ungroup, { ids: [g] });
    expect(t.resolver().isGone(g)).toBe(true);
    expect(order(t)).toEqual([a, b]);
    expect(world(t, b)).toEqual({ x: 25, y: 5 });
    expect(t.services.state.selection).toEqual([a, b]);
  });

  it("groups elements of a missing extension", () => {
    const t = setupBasics();
    const m = t.missing(0, 0);
    const a = t.shape(20, 0);
    const g = t.must<ElementId>(BASICS.group, { ids: [m, a] });
    expect(order(t, g)).toEqual([m, a]);
  });

  it("refuses elements in different containers, locked elements and non-groups", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    const a = t.shape(200, 0);
    const b = t.shape(220, 0);
    refused(t, BASICS.group, { ids: [inner, a] });
    setLocked(t.doc, b, true);
    refused(t, BASICS.group, { ids: [a, b] });
    refused(t, BASICS.ungroup, { ids: [f] });
    refused(t, BASICS.ungroup, { ids: [a] });
    setLocked(t.doc, b, false);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, b] });
    setLocked(t.doc, g, true);
    refused(t, BASICS.ungroup, { ids: [g] });
  });
});

describe("lock and unlock", () => {
  it("locks elements so that commands refuse them until unlocked", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    t.services.selection.set([a]);
    t.must(BASICS.lock, { ids: [a] });
    expect(t.element(a).locked).toBe(true);
    expect(t.services.state.selection).toEqual([]);
    refused(t, BASICS.move, { ids: [a], dx: 1, dy: 0 });
    refused(t, BASICS.delete, { ids: [a] });
    refused(t, BASICS.lock, { ids: [a] });
    t.must(BASICS.unlock, { ids: [a] });
    expect(t.element(a).locked).toBe(false);
    t.must(BASICS.move, { ids: [a], dx: 1, dy: 0 });
    t.must(BASICS.undo);
    t.must(BASICS.undo);
    expect(t.element(a).locked).toBe(true);
  });

  it("refuses unlocking what is not locked itself, or sits in a locked container", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    const a = t.shape(200, 0);
    refused(t, BASICS.unlock, { ids: [a] });
    t.must(BASICS.lock, { ids: [inner] });
    t.must(BASICS.lock, { ids: [f] });
    refused(t, BASICS.unlock, { ids: [inner] });
    refused(t, BASICS.lock, { ids: [inner] });
    t.must(BASICS.unlock, { ids: [f] });
    t.must(BASICS.unlock, { ids: [inner] });
  });
});

describe("delete", () => {
  it("deletes elements with their contents as one step, and undo brings them back", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    const m = t.missing(200, 0);
    t.services.selection.set([f, inner, m]);
    t.must(BASICS.delete, { ids: [f, inner, m] });
    const r = t.resolver();
    expect([r.isGone(f), r.isGone(inner), r.isGone(m)]).toEqual([true, true, true]);
    expect(t.services.state.selection).toEqual([]);
    t.must(BASICS.undo);
    expect(order(t)).toEqual([f, m]);
    expect(order(t, f)).toEqual([inner]);
    refused(t, BASICS.delete, { ids: ["nothing"] });
  });

  it("deletes a group with a locked member, member included (decided by the users)", () => {
    const t = setupBasics();
    const x = t.shape(0, 0);
    const y = t.shape(20, 0);
    const g = t.must<ElementId>(BASICS.group, { ids: [x, y] });
    t.must(BASICS.lock, { ids: [x] });
    refused(t, BASICS.delete, { ids: [x] });
    t.must(BASICS.delete, { ids: [g] });
    expect(t.resolver().isGone(x)).toBe(true);
  });
});

describe("duplicate", () => {
  it("copies elements with their contents in front of the originals, as one step", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    const a = t.shape(200, 0);
    const before = steps(t);
    const { ids } = t.must<PasteOutcome>(BASICS.duplicate, { ids: [f], dx: 5, dy: 5 });
    expect(ids).toHaveLength(1);
    const copy = ids[0]!;
    expect(order(t)).toEqual([f, a, copy]);
    expect(world(t, copy)).toEqual({ x: 5, y: 5 });
    const [innerCopy] = order(t, copy);
    expect(t.element(innerCopy!).type).toBe(SHAPE_TYPE);
    expect(t.element(innerCopy!).data).toEqual(t.element(inner).data);
    expect(t.services.state.selection).toEqual([copy]);
    expect(steps(t)).toBe(before + 1);
    t.must(BASICS.undo);
    expect(order(t)).toEqual([f, a]);
  });

  it("offsets the copies by a few screen pixels when no offset is given", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    t.services.state.camera = { ...t.services.state.camera, zoom: 4 };
    const { ids } = t.must<PasteOutcome>(BASICS.duplicate, { ids: [a] });
    const step = DUPLICATE_OFFSET / 4;
    expect(world(t, ids[0]!)).toEqual({ x: step, y: step });
  });

  it("duplicates locked elements into unlocked copies, and elements of a missing extension, but not into a locked frame", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    setLocked(t.doc, a, true);
    const m = t.missing(20, 0);
    const { ids } = t.must<PasteOutcome>(BASICS.duplicate, { ids: [a, m] });
    expect(t.element(a).locked).toBe(true);
    expect(t.element(ids[0]!).locked).toBe(false);
    expect(t.element(ids[1]!).data).toEqual(t.element(m).data);
    const f = t.frame(100, 0);
    const inner = t.shape(110, 10, 10, 10, f);
    setLocked(t.doc, f, true);
    refused(t, BASICS.duplicate, { ids: [inner] });
  });
});

describe("copy and paste", () => {
  it("copies into a fragment without an undo step, and pastes it as one", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const m = t.missing(20, 0);
    const before = steps(t);
    const state = visibleState(t.doc);
    const fragment = t.must<Fragment>(BASICS.copy, { ids: [a, m] });
    expect(steps(t)).toBe(before);
    expect(visibleState(t.doc)).toEqual(state);
    // As the clipboard would carry it.
    const text = JSON.parse(JSON.stringify(fragment)) as unknown;
    const f = t.frame(100, 100);
    const pasted = t.must<PasteOutcome>(BASICS.paste, {
      fragment: text,
      parent: f,
      dx: 1,
      dy: 2,
    });
    expect(pasted.ids).toHaveLength(2);
    expect(order(t, f)).toEqual(pasted.ids);
    expect(world(t, pasted.ids[0]!)).toEqual({ x: 101, y: 102 });
    expect(t.element(pasted.ids[1]!).data).toEqual(t.element(m).data);
    expect(t.services.state.selection).toEqual(pasted.ids);
    expect(steps(t)).toBe(before + 2);
    t.must(BASICS.undo);
    expect(order(t, f)).toEqual([]);
  });

  it("refuses fragments that do not read cleanly, and locked targets", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const fragment = t.must<Fragment>(BASICS.copy, { ids: [a] });
    const id = fragment.roots[0]!;
    const element = fragment.elements[id]!;
    const variants: unknown[] = [
      null,
      "text",
      { ...fragment, roots: [] },
      { ...fragment, roots: ["other"] },
      { ...fragment, extra: 1 },
      // An element outside the roots could not be removed by undo.
      {
        ...fragment,
        elements: { ...fragment.elements, orphan: { ...element, parent: "elsewhere" } },
      },
      { ...fragment, elements: { [id]: { ...element, parent: "elsewhere" } } },
      { ...fragment, elements: { [id]: { ...element, size: { w: -1, h: 1 } } } },
      // Data that the shape's own reader would change.
      { ...fragment, elements: { [id]: { ...element, data: { fill: 5 } } } },
    ];
    for (const variant of variants) refused(t, BASICS.paste, { fragment: variant });
    expect(readFragment(variants[5]).problems).toEqual([
      "elements.orphan: is not inside one of the roots",
    ]);
    const f = t.frame(100, 0);
    setLocked(t.doc, f, true);
    refused(t, BASICS.paste, { fragment, parent: f });
    t.must(BASICS.paste, { fragment });
  });

  it("refuses elements whose parent in the fragment is not a frame or group, so a paste can always be undone", () => {
    const t = setupBasics();
    const s = t.shape(0, 0);
    const c = t.shape(30, 0);
    const m = t.missing(60, 0);
    const fragment = t.must<Fragment>(BASICS.copy, { ids: [s, c, m] });
    const [first, second, third] = fragment.roots as [string, string, string];
    const under = (child: string, parent: string): unknown => ({
      ...fragment,
      roots: fragment.roots.filter((id) => id !== child),
      elements: {
        ...fragment.elements,
        [child]: {
          ...fragment.elements[child]!,
          parent,
          pos: { ...fragment.elements[child]!.pos, space: parent },
        },
      },
    });
    // Under a shape, and under an element of a missing extension.
    for (const variant of [under(second, first), under(second, third)]) {
      refused(t, BASICS.paste, { fragment: variant });
      expect(readFragment(variant).problems).toEqual([
        `elements.${second}: is not inside one of the roots`,
      ]);
    }
  });

  it("refuses frame and group data that is not theirs", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const fragment = t.must<Fragment>(BASICS.copy, { ids: [f] });
    const id = fragment.roots[0]!;
    const withData = (data: unknown): unknown => ({
      ...fragment,
      elements: { [id]: { ...fragment.elements[id]!, data } },
    });
    const junk = withData({ clip: "yes", fill: 5, junk: { a: 1 } });
    refused(t, BASICS.paste, { fragment: junk });
    expect(readFragment(junk).problems).toEqual([
      `elements.${id}.data: clip: must be a boolean`,
      `elements.${id}.data: fill: must be a colour or null`,
      `elements.${id}.data: junk: not a key of a frame`,
    ]);
    t.must(BASICS.paste, {
      fragment: withData({ clip: true, fill: "#fff", stroke: null }),
    });
  });
});

describe("undo, redo and select all", () => {
  it("undo and redo are commands without steps of their own, refused when there is nothing to do", () => {
    const t = setupBasics();
    refused(t, BASICS.undo);
    refused(t, BASICS.redo);
    const a = t.shape(0, 0);
    expect(t.must(BASICS.undo)).toBe(true);
    expect(t.resolver().isGone(a)).toBe(true);
    expect(t.must(BASICS.redo)).toBe(true);
    expect(t.resolver().isGone(a)).toBe(false);
    // Not during a gesture.
    const gesture = t.host.commands.beginGesture(t.env());
    refused(t, BASICS.undo);
    gesture.cancel();
    expect(t.host.commands.isEnabled(BASICS.undo, t.env())).toBe(true);
  });

  it("select all selects what can be selected, except locked elements, without an undo step", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const b = t.shape(20, 0);
    const c = t.shape(40, 0);
    setLocked(t.doc, b, true);
    const before = steps(t);
    t.must(BASICS.selectAll);
    expect(t.services.state.selection).toEqual([a, c]);
    expect(steps(t)).toBe(before);
  });

  it("commands of several operations are one undo step (grouping, duplicating, pasting)", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const b = t.shape(20, 0);
    const before = visibleState(t.doc);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, b] });
    t.must(BASICS.duplicate, { ids: [g] });
    t.must(BASICS.paste, { fragment: t.must<Fragment>(BASICS.copy, { ids: [g] }) });
    expect(steps(t)).toBe(5);
    t.must(BASICS.undo);
    t.must(BASICS.undo);
    t.must(BASICS.undo);
    expect(visibleState(t.doc)).toEqual(before);
  });
});
