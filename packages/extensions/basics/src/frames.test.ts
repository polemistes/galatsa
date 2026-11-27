// SPDX-License-Identifier: GPL-3.0-or-later

// Frames and stacking (docs/adr/0014-stacking-and-frames.md): a frame around
// elements and a drawn one, removing a frame but keeping its contents,
// naming, moving into and out of frames by command and by a move with a
// target (a drag), z-order inside a frame, and frame stops following their
// frame. Every command is one undo step that undo takes back whole.

import { FRAME_TYPE, regionToWorld, stopRegion, type ElementId } from "@galatsa/core";
import { addStop, setLocked, stopsAndRoutesOf } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import { BASICS, FRAME_PADDING, MAX_NAME_LENGTH, elementName, frameAt } from "./index.ts";
import { setupBasics, visibleState, type BasicsSetup } from "./testing.ts";

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

function refused(t: BasicsSetup, id: string, args?: unknown): void {
  const before = visibleState(t.doc);
  const count = steps(t);
  expect(t.host.commands.isEnabled(id, t.env(), args)).toBe(false);
  expect(t.run(id, args)).toEqual(DISABLED);
  expect(visibleState(t.doc)).toEqual(before);
  expect(steps(t)).toBe(count);
}

/** Runs a command that must make exactly one undo step, which undo takes back and redo brings back. */
function oneStep<R>(t: BasicsSetup, id: string, args?: unknown): R {
  const before = visibleState(t.doc);
  const count = steps(t);
  const value = t.must<R>(id, args);
  const after = visibleState(t.doc);
  expect(steps(t)).toBe(count + 1);
  t.must(BASICS.undo);
  expect(visibleState(t.doc)).toEqual(before);
  t.must(BASICS.redo);
  expect(visibleState(t.doc)).toEqual(after);
  return value;
}

describe("a frame around elements", () => {
  it("is put around them with a margin, in the frontmost one's slot, as one step", () => {
    const t = setupBasics();
    const back = t.shape(-50, -50, 10, 10);
    const a = t.shape(0, 0, 100, 50);
    const between = t.shape(500, 500);
    const b = t.shape(100, 50, 100, 50);
    const front = t.shape(600, 600);
    const f = oneStep<ElementId>(t, BASICS.frame, { ids: [b, a] });
    const r = t.resolver();
    expect(r.get(f)?.type).toBe(FRAME_TYPE);
    const pad = 200 * FRAME_PADDING;
    expect(world(t, f)).toEqual({ x: -pad, y: -pad });
    expect(r.get(f)?.size).toEqual({ w: 200 + 2 * pad, h: 100 + 2 * pad });
    // The members are in it, in their order, and have not moved.
    expect(order(t, f)).toEqual([a, b]);
    expect(world(t, a)).toEqual({ x: 0, y: 0 });
    expect(world(t, b)).toEqual({ x: 100, y: 50 });
    // The frame took b's slot: in front of what was between, behind what was in front.
    expect(order(t)).toEqual([back, between, f, front]);
    expect(t.services.selection.get()).toEqual([f]);
  });

  it("is made at a rectangle with the given elements in it (the frame tool)", () => {
    const t = setupBasics();
    const outer = t.frame(0, 0, 1000, 1000);
    const inside = t.shape(110, 110, 10, 10, outer);
    const f = oneStep<ElementId>(t, BASICS.frame, {
      rect: { x: 100, y: 100, w: 300, h: 200 },
      parent: outer,
      ids: [inside],
    });
    expect(t.resolver().parentOf(f)).toBe(outer);
    expect(world(t, f)).toEqual({ x: 100, y: 100 });
    expect(order(t, f)).toEqual([inside]);
    expect(world(t, inside)).toEqual({ x: 110, y: 110 });
    // An empty one, on the canvas.
    const empty = t.must<ElementId>(BASICS.frame, { rect: { x: 0, y: 0, w: 10, h: 5 } });
    expect(t.resolver().parentOf(empty)).toBeNull();
    expect(order(t, empty)).toEqual([]);
  });

  it("refuses elements in different containers, locked ones and bad rectangles", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.shape(10, 10, 10, 10, f);
    const a = t.shape(200, 0);
    const locked = t.shape(300, 0);
    setLocked(t.doc, locked, true);
    refused(t, BASICS.frame, { ids: [inner, a] });
    refused(t, BASICS.frame, { ids: [locked] });
    refused(t, BASICS.frame, { ids: [] });
    refused(t, BASICS.frame, {});
    refused(t, BASICS.frame, { rect: { x: 0, y: 0, w: 0, h: 10 } });
    refused(t, BASICS.frame, { rect: { x: 0, y: 0, w: 10, h: Number.NaN } });
    // Elements not in the given parent.
    refused(t, BASICS.frame, { rect: { x: 0, y: 0, w: 10, h: 10 }, ids: [inner] });
    // Into a locked frame.
    setLocked(t.doc, f, true);
    refused(t, BASICS.frame, { rect: { x: 0, y: 0, w: 10, h: 10 }, parent: f });
  });
});

describe("removing a frame", () => {
  it("keeps what was in it where it is, on the canvas and in the stacking order", () => {
    const t = setupBasics();
    const back = t.shape(-10, 0);
    const f = t.frame(100, 100, 200, 200);
    const front = t.shape(-20, 0);
    const a = t.shape(10, 10, 10, 10, f);
    const b = t.shape(30, 10, 10, 10, f);
    oneStep(t, BASICS.removeFrame, { ids: [f] });
    expect(t.resolver().isGone(f)).toBe(true);
    expect(order(t)).toEqual([back, a, b, front]);
    expect(world(t, a)).toEqual({ x: 110, y: 110 });
    expect(t.services.selection.get()).toEqual([a, b]);
  });

  it("refuses what is not a frame, and locked frames", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const g = t.must<ElementId>(BASICS.group, { ids: [a, t.shape(20, 0)] });
    const f = t.frame(100, 0);
    refused(t, BASICS.removeFrame, { ids: [a] });
    refused(t, BASICS.removeFrame, { ids: [g] });
    refused(t, BASICS.removeFrame, { ids: [f, g] });
    setLocked(t.doc, f, true);
    refused(t, BASICS.removeFrame, { ids: [f] });
  });
});

describe("naming", () => {
  it("renames an element as one step", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    oneStep(t, BASICS.rename, { id: f, name: "Innledning 🎉" });
    expect(elementName(t.doc, f)).toBe("Innledning 🎉");
    oneStep(t, BASICS.rename, { id: f, name: "" });
    expect(elementName(t.doc, f)).toBe("");
  });

  it("refuses the same name, a name too long or not well formed, and locked elements", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    t.must(BASICS.rename, { id: f, name: "A" });
    refused(t, BASICS.rename, { id: f, name: "A" });
    refused(t, BASICS.rename, { id: f, name: "x".repeat(MAX_NAME_LENGTH + 1) });
    refused(t, BASICS.rename, { id: f, name: "\uD800" });
    refused(t, BASICS.rename, { id: f });
    refused(t, BASICS.rename, { id: "nothing", name: "B" });
    setLocked(t.doc, f, true);
    refused(t, BASICS.rename, { id: f, name: "B" });
  });
});

describe("into and out of frames", () => {
  it("moves elements out of their frame, in front of it, keeping their place", () => {
    const t = setupBasics();
    const before = t.shape(500, 0);
    const f = t.frame(100, 100, 200, 200);
    const after = t.shape(600, 0);
    const a = t.shape(10, 10, 10, 10, f);
    const b = t.shape(30, 10, 10, 10, f);
    oneStep(t, BASICS.moveOutOfFrame, { ids: [b, a] });
    expect(order(t)).toEqual([before, f, a, b, after]);
    expect(world(t, a)).toEqual({ x: 110, y: 110 });
    // From a nested frame into the outer one.
    const inner = t.frame(10, 10, 50, 50, f);
    const c = t.shape(5, 5, 5, 5, inner);
    t.must(BASICS.moveOutOfFrame, { ids: [c] });
    expect(t.resolver().parentOf(c)).toBe(f);
    expect(world(t, c)).toEqual({ x: 115, y: 115 });
  });

  it("refuses elements on the canvas, in a group, in different frames, and into a locked frame", () => {
    const t = setupBasics();
    const a = t.shape(0, 0);
    const f = t.frame(100, 0);
    const g = t.frame(300, 0);
    const inF = t.shape(1, 1, 5, 5, f);
    const inG = t.shape(1, 1, 5, 5, g);
    refused(t, BASICS.moveOutOfFrame, { ids: [a] });
    refused(t, BASICS.moveOutOfFrame, { ids: [inF, inG] });
    const grouped = t.must<ElementId>(BASICS.group, { ids: [a, t.shape(20, 0)] });
    const member = order(t, grouped)[0]!;
    refused(t, BASICS.moveOutOfFrame, { ids: [member] });
    const outer = t.frame(1000, 0, 500, 500);
    const nested = t.frame(10, 10, 100, 100, outer);
    const deep = t.shape(1, 1, 5, 5, nested);
    setLocked(t.doc, outer, true);
    refused(t, BASICS.moveOutOfFrame, { ids: [deep] });
  });

  it("moves elements into the frame under them, or a given one", () => {
    const t = setupBasics();
    const f = t.frame(100, 100, 400, 400);
    const inner = t.frame(200, 200, 100, 100, f);
    const a = t.shape(150, 150, 20, 20);
    const b = t.shape(310, 310, 20, 20);
    oneStep(t, BASICS.moveIntoFrame, { ids: [a] });
    expect(t.resolver().parentOf(a)).toBe(f);
    expect(world(t, a)).toEqual({ x: 150, y: 150 });
    // Already in the frame under it: nothing to do.
    refused(t, BASICS.moveIntoFrame, { ids: [a] });
    // b's centre is in the inner frame.
    t.must(BASICS.moveIntoFrame, { ids: [b] });
    expect(t.resolver().parentOf(b)).toBe(inner);
    expect(world(t, b)).toEqual({ x: 310, y: 310 });
    // A given frame.
    t.must(BASICS.moveIntoFrame, { ids: [b], target: f });
    expect(t.resolver().parentOf(b)).toBe(f);
    // Not into itself, a shape, a locked frame or with nothing under it.
    refused(t, BASICS.moveIntoFrame, { ids: [f], target: inner });
    refused(t, BASICS.moveIntoFrame, { ids: [b], target: a });
    const lone = t.shape(5000, 5000);
    refused(t, BASICS.moveIntoFrame, { ids: [lone] });
    setLocked(t.doc, inner, true);
    refused(t, BASICS.moveIntoFrame, { ids: [b], target: inner });
  });

  it("finds the innermost open frame under a point, passing over what is moved", () => {
    const t = setupBasics();
    const f = t.frame(0, 0, 400, 400);
    const back = t.frame(50, 50, 100, 100, f);
    const front = t.frame(60, 60, 100, 100, f);
    const r = () => t.resolver();
    expect(frameAt(r(), { x: 70, y: 70 })).toBe(front);
    expect(frameAt(r(), { x: 55, y: 55 })).toBe(back);
    expect(frameAt(r(), { x: 300, y: 300 })).toBe(f);
    expect(frameAt(r(), { x: 900, y: 300 })).toBeNull();
    expect(frameAt(r(), { x: 70, y: 70 }, [front])).toBe(back);
    expect(frameAt(r(), { x: 70, y: 70 }, [f])).toBeNull();
    setLocked(t.doc, front, true);
    expect(frameAt(r(), { x: 70, y: 70 })).toBe(back);
    t.must(BASICS.delete, { ids: [back] });
    expect(frameAt(r(), { x: 70, y: 70 })).toBe(f);
  });

  it("moves into another container with the move, as a drag does: one step, one place", () => {
    const t = setupBasics();
    const f = t.frame(100, 100, 200, 200);
    const a = t.shape(0, 0, 10, 10);
    const b = t.shape(20, 0, 10, 10);
    oneStep(t, BASICS.move, { ids: [a, b], dx: 150, dy: 150, target: f });
    expect(order(t, f)).toEqual([a, b]);
    expect(world(t, a)).toEqual({ x: 150, y: 150 });
    expect(world(t, b)).toEqual({ x: 170, y: 150 });
    // Out again to the canvas.
    oneStep(t, BASICS.move, { ids: [b], dx: 500, dy: 0, target: null });
    expect(t.resolver().parentOf(b)).toBeNull();
    expect(world(t, b)).toEqual({ x: 670, y: 150 });
    // Only a change of container.
    oneStep(t, BASICS.move, { ids: [b], dx: 0, dy: 0, target: f });
    expect(world(t, b)).toEqual({ x: 670, y: 150 });
    // A frame moved into another frame takes its contents with it.
    const g = t.frame(1000, 0, 50, 50);
    const inG = t.shape(5, 5, 5, 5, g);
    t.must(BASICS.move, { ids: [g], dx: -850, dy: 150, target: f });
    expect(t.resolver().parentOf(g)).toBe(f);
    expect(world(t, inG)).toEqual({ x: 155, y: 155 });
  });

  it("refuses a move into itself, into what is inside it, and into a locked or gone container", () => {
    const t = setupBasics();
    const f = t.frame(0, 0);
    const inner = t.frame(10, 10, 20, 20, f);
    const a = t.shape(500, 0);
    const locked = t.frame(300, 0);
    setLocked(t.doc, locked, true);
    const gone = t.frame(700, 0);
    t.must(BASICS.delete, { ids: [gone] });
    refused(t, BASICS.move, { ids: [f], dx: 1, dy: 1, target: f });
    refused(t, BASICS.move, { ids: [f], dx: 1, dy: 1, target: inner });
    refused(t, BASICS.move, { ids: [a], dx: 1, dy: 1, target: locked });
    refused(t, BASICS.move, { ids: [a], dx: 1, dy: 1, target: gone });
    refused(t, BASICS.move, { ids: [a], dx: 1, dy: 1, target: a });
    refused(t, BASICS.move, { ids: [a], dx: 1, dy: 1, target: "nothing" });
    // Nothing to do: already on the canvas, no offset.
    refused(t, BASICS.move, { ids: [a], dx: 0, dy: 0, target: null });
  });
});

describe("stacking inside a frame", () => {
  it("puts a picture at the back of a frame with text on top, and the frame moves without anything shifting", () => {
    const t = setupBasics();
    const f = t.frame(100, 100, 400, 300);
    const text = t.shape(20, 20, 200, 40, f);
    const picture = t.shape(0, 0, 400, 300, f);
    const outside = t.shape(0, 0, 50, 50);
    oneStep(t, BASICS.sendToBack, { ids: [picture] });
    expect(order(t, f)).toEqual([picture, text]);
    // Only the frame's own slots count: the frame stays where it is on the canvas.
    expect(order(t)).toEqual([f, outside]);
    const drawn = t.resolver().drawOrder();
    expect(drawn.indexOf(picture)).toBeLessThan(drawn.indexOf(text));
    oneStep(t, BASICS.move, { ids: [f], dx: 250, dy: -40 });
    expect(world(t, f)).toEqual({ x: 350, y: 60 });
    expect(world(t, picture)).toEqual({ x: 350, y: 60 });
    expect(world(t, text)).toEqual({ x: 370, y: 80 });
    expect(world(t, outside)).toEqual({ x: 0, y: 0 });
    expect(order(t, f)).toEqual([picture, text]);
  });

  it("steps among the frame's contents only", () => {
    const t = setupBasics();
    const f = t.frame(0, 0, 400, 300);
    const [a, b, c] = [
      t.shape(0, 0, 10, 10, f),
      t.shape(1, 0, 10, 10, f),
      t.shape(2, 0, 10, 10, f),
    ];
    t.shape(0, 0); // on the canvas, in front of the frame
    oneStep(t, BASICS.bringForward, { ids: [a] });
    expect(order(t, f)).toEqual([b, a, c]);
    oneStep(t, BASICS.bringToFront, { ids: [a] });
    expect(order(t, f)).toEqual([b, c, a]);
    refused(t, BASICS.bringForward, { ids: [a] });
    oneStep(t, BASICS.sendBackward, { ids: [c] });
    expect(order(t, f)).toEqual([c, b, a]);
  });

  it("offers bracket and arrow shortcuts for the stacking order", () => {
    const t = setupBasics({ mode: "quick" });
    const { map, conflicts } = t.host.commands.shortcuts("quick");
    expect(conflicts).toEqual([]);
    expect(map.get("Mod+]")).toBe(BASICS.bringForward);
    expect(map.get("Mod+ArrowUp")).toBe(BASICS.bringForward);
    expect(map.get("Mod+[")).toBe(BASICS.sendBackward);
    expect(map.get("Mod+ArrowDown")).toBe(BASICS.sendBackward);
    expect(map.get("Mod+Shift+]")).toBe(BASICS.bringToFront);
    expect(map.get("Mod+Shift+ArrowUp")).toBe(BASICS.bringToFront);
    expect(map.get("Mod+Shift+[")).toBe(BASICS.sendToBack);
    expect(map.get("Mod+Shift+ArrowDown")).toBe(BASICS.sendToBack);
  });
});

describe("frame stops", () => {
  it("follow their frame when it is moved, framed or moved into another frame", () => {
    const t = setupBasics();
    const f = t.frame(100, 100, 160, 90);
    const stop = addStop(t.doc, { view: { kind: "frame", frame: f, padding: 0 } });
    const shown = () =>
      regionToWorld(
        t.resolver(),
        stopRegion(stopsAndRoutesOf(t.doc), t.resolver(), stop)!,
      );
    expect(shown()).toEqual({ x: 100, y: 100, w: 160, h: 90 });
    t.must(BASICS.move, { ids: [f], dx: 40, dy: 10 });
    expect(shown()).toEqual({ x: 140, y: 110, w: 160, h: 90 });
    const outer = t.must<ElementId>(BASICS.frame, { ids: [f] });
    expect(t.resolver().parentOf(f)).toBe(outer);
    expect(shown()).toEqual({ x: 140, y: 110, w: 160, h: 90 });
    t.must(BASICS.move, { ids: [outer], dx: -40, dy: 0 });
    expect(shown()).toEqual({ x: 100, y: 110, w: 160, h: 90 });
    t.must(BASICS.removeFrame, { ids: [outer] });
    expect(shown()).toEqual({ x: 100, y: 110, w: 160, h: 90 });
  });
});
