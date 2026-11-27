// SPDX-License-Identifier: GPL-3.0-or-later

// The selection tool (galatsa.select) in the editor, with pointer events and
// keys as the page sends them: selecting by click, Shift-click and rubber
// band; moving, scaling, resizing and rotating with the handles, each drag
// previewed without writing and committed as one undo step; groups scaled
// with their proportions kept; elements of a missing extension moved but not
// scaled; locked elements not dragged; and every action of the keys, the
// clipboard and the context menu undone. The test editor shows root space
// one to one: a screen pixel is a world unit at the same coordinates.

import type { ElementId } from "@galatsa/core";
import { setLocked } from "@galatsa/core/ydoc";
import { EXTENSION_API_VERSION } from "@galatsa/extension-api";
import {
  defineEditExtension,
  defineViewExtension,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import { BASICS } from "@galatsa/extension-basics";
import { INSERT_MISSING, visibleState } from "@galatsa/extension-basics/testing";
import { HANDLE_FRAME_MIN, ROTATE_LIFT } from "@galatsa/extension-select";
import { afterEach, describe, expect, it } from "vitest";
import {
  FRAGMENT_MIME,
  decodeFragment,
  readClipboard,
  type ClipboardSource,
} from "./clipboard.ts";
import { menuEntries, openContextMenu, type MenuClipboard } from "./context-menu.ts";
import type { Editor } from "./editor.ts";
import { drag, key, pointer, testEditor } from "./test-support.ts";

const editors: Editor[] = [];
function make(...args: Parameters<typeof testEditor>): Editor {
  const { editor } = testEditor(...args);
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function must<R>(editor: Editor, command: string, args?: unknown): R {
  const outcome = editor.run<R>(command, args);
  if (!outcome.ok) throw new Error(`${command}: ${outcome.reason}`);
  return outcome.value;
}

function rect(editor: Editor, x: number, y: number, w: number, h: number): ElementId {
  return must<ElementId>(editor, "examples.shape/insert", { kind: "rect", x, y, w, h });
}

/** Where an element is on the canvas, as the document says (root space). */
function box(editor: Editor, id: ElementId) {
  const p = editor.services.scene.placement(id)!;
  return { x: p.worldX, y: p.worldY, w: p.w, h: p.h, rot: p.rot };
}

function steps(editor: Editor): number {
  return editor.undo.undoStack.length;
}

/** Counts document updates during `fn`. */
function updates(editor: Editor, fn: () => void): number {
  let count = 0;
  const listener = () => (count += 1);
  editor.doc.on("update", listener);
  try {
    fn();
  } finally {
    editor.doc.off("update", listener);
  }
  return count;
}

/** A drag that must be one undo step of at most two document updates, previewed without writing. */
function oneStepDrag(
  editor: Editor,
  from: { x: number; y: number },
  to: { x: number; y: number },
  extra: Parameters<typeof pointer>[2] = {},
): void {
  const before = steps(editor);
  const state = visibleState(editor.doc);
  let duringPreview: unknown;
  const n = updates(editor, () => {
    editor.pointerDown(pointer(from.x, from.y, extra));
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      editor.pointerMove(
        pointer(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, extra),
      );
    }
    duringPreview = visibleState(editor.doc);
    editor.pointerUp(pointer(to.x, to.y, extra));
  });
  // Nothing was written before the drag ended, and it ended in one step.
  expect(duringPreview).toEqual(state);
  expect(editor.scene.preview.size).toBe(0);
  expect(steps(editor)).toBe(before + 1);
  expect(n).toBeLessThanOrEqual(2);
}

/** Undoes the last step and checks that it gives `state` back. */
function undoTo(editor: Editor, state: unknown): void {
  expect(editor.keyDown(key("z", { ctrlKey: true }))).toMatchObject({
    outcome: { ok: true, value: true },
  });
  expect(visibleState(editor.doc)).toEqual(state);
}

/** A clipboard as a copy event's data transfer holds it. */
function clipboardData(): ClipboardSource & {
  setData(type: string, data: string): void;
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    get types() {
      return [...store.keys()];
    },
    getData: (type) => store.get(type) ?? "",
    setData: (type, data) => {
      store.set(type, data);
    },
  };
}

describe("selecting", () => {
  it("selects by click, adds and removes with Shift, and clears on empty canvas", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 300, 100, 50, 50);
    editor.services.selection.set([]);
    editor.pointerDown(pointer(120, 120));
    editor.pointerUp(pointer(120, 120));
    expect(editor.selection).toEqual([a]);
    editor.pointerDown(pointer(320, 120, { shiftKey: true }));
    editor.pointerUp(pointer(320, 120, { shiftKey: true }));
    expect(editor.selection).toEqual([a, b]);
    // A click on one of several selected selects it alone (without a move).
    editor.pointerDown(pointer(320, 120));
    editor.pointerUp(pointer(320, 120));
    expect(editor.selection).toEqual([b]);
    editor.pointerDown(pointer(120, 120, { shiftKey: true }));
    editor.pointerUp(pointer(120, 120, { shiftKey: true }));
    editor.pointerDown(pointer(120, 120, { shiftKey: true }));
    editor.pointerUp(pointer(120, 120, { shiftKey: true }));
    expect(editor.selection).toEqual([b]);
    editor.pointerDown(pointer(700, 600));
    editor.pointerUp(pointer(700, 600));
    expect(editor.selection).toEqual([]);
  });

  it("selects what a rubber band touches, adds with Shift, and passes over locked elements", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 200, 100, 50, 50);
    const c = rect(editor, 400, 100, 50, 50);
    const locked = rect(editor, 140, 300, 50, 50);
    setLocked(editor.doc, locked, true);
    editor.services.selection.set([]);
    drag(editor, { x: 50, y: 50 }, { x: 210, y: 400 });
    expect(editor.selection).toEqual([a, b]);
    drag(editor, { x: 390, y: 50 }, { x: 410, y: 120 }, { shiftKey: true });
    expect(editor.selection).toEqual([a, b, c]);
    // Escape clears the selection when nothing is being dragged.
    expect(editor.keyDown(key("Escape"))).toEqual({ kind: "tool-key" });
    expect(editor.selection).toEqual([]);
    // A click on a locked element does not select it: the band starts there.
    editor.pointerDown(pointer(160, 320));
    editor.pointerUp(pointer(160, 320));
    expect(editor.selection).toEqual([]);
  });
});

describe("clicking empty canvas", () => {
  it("does not select a turned element whose bounding box covers the click", () => {
    const editor = make();
    const a = rect(editor, 150, 150, 100, 100);
    must(editor, BASICS.rotate, { ids: [a], rot: Math.PI / 4 });
    editor.services.selection.set([]);
    const bounds = editor.services.scene.bounds(a)!;
    // The corner of the bounding box lies outside the turned square.
    editor.pointerDown(pointer(bounds.x + 5, bounds.y + 5));
    editor.pointerUp(pointer(bounds.x + 5, bounds.y + 5));
    expect(editor.selection).toEqual([]);
    // A band dragged over it still selects it.
    drag(
      editor,
      { x: bounds.x + 5, y: bounds.y + 5 },
      { x: bounds.x + 20, y: bounds.y + 20 },
    );
    expect(editor.selection).toEqual([a]);
  });
});

describe("moving", () => {
  it("drags the selection as one step, with Shift along one axis", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 300, 100, 50, 50);
    editor.services.selection.set([a, b]);
    const start = visibleState(editor.doc);
    oneStepDrag(editor, { x: 120, y: 120 }, { x: 170, y: 150 });
    expect(box(editor, a)).toMatchObject({ x: 150, y: 130 });
    expect(box(editor, b)).toMatchObject({ x: 350, y: 130 });
    expect(editor.selection).toEqual([a, b]);
    // Inside the selection's box, between its elements, also drags it.
    const moved = visibleState(editor.doc);
    editor.pointerDown(pointer(250, 150));
    editor.pointerMove(pointer(255, 170, { shiftKey: true }));
    editor.pointerUp(pointer(260, 200, { shiftKey: true }));
    expect(box(editor, a)).toMatchObject({ x: 150, y: 180 });
    undoTo(editor, moved);
    undoTo(editor, start);
  });

  it("nudges with the arrow keys, one step each", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    editor.services.selection.set([a]);
    const before = steps(editor);
    expect(editor.keyDown(key("ArrowRight"))).toEqual({ kind: "tool-key" });
    expect(editor.keyDown(key("ArrowDown", { shiftKey: true }))).toEqual({
      kind: "tool-key",
    });
    expect(box(editor, a)).toMatchObject({ x: 101, y: 110 });
    expect(steps(editor)).toBe(before + 2);
  });

  it("does not drag locked elements", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    setLocked(editor.doc, a, true);
    const state = visibleState(editor.doc);
    const before = steps(editor);
    drag(editor, { x: 120, y: 120 }, { x: 220, y: 220 });
    expect(visibleState(editor.doc)).toEqual(state);
    expect(steps(editor)).toBe(before);
    // Selected anyway (from the context menu), it has no handles and does not move.
    editor.services.selection.set([a]);
    drag(editor, { x: 120, y: 120 }, { x: 220, y: 220 });
    drag(editor, { x: 150, y: 150 }, { x: 250, y: 250 });
    drag(editor, { x: 125, y: 100 - ROTATE_LIFT }, { x: 300, y: 125 });
    expect(visibleState(editor.doc)).toEqual(state);
    expect(steps(editor)).toBe(before);
  });
});

describe("scaling and resizing", () => {
  it("scales a group with a corner handle, keeping the proportions between its members", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 200, 150, 100, 50);
    const g = must<ElementId>(editor, BASICS.group, { ids: [a, b] });
    expect(editor.selection).toEqual([g]);
    const start = visibleState(editor.doc);
    // The group's box is 100..300 by 100..200; drag the bottom right corner
    // from (300, 200) to (400, 250): a factor of 1.5 about the top left.
    oneStepDrag(editor, { x: 300, y: 200 }, { x: 400, y: 250 });
    const k = 1.5;
    expect(box(editor, a)).toMatchObject({ x: 100, y: 100, w: 50 * k, h: 50 * k });
    const bb = box(editor, b);
    expect(bb.x).toBeCloseTo(100 + 100 * k, 9);
    expect(bb.y).toBeCloseTo(100 + 50 * k, 9);
    expect(bb.w).toBeCloseTo(100 * k, 9);
    expect(bb.h).toBeCloseTo(50 * k, 9);
    // The proportions between the members are the same as before.
    const ba = box(editor, a);
    expect((bb.x - ba.x) / ba.w).toBeCloseTo(100 / 50, 9);
    expect(bb.w / ba.w).toBeCloseTo(100 / 50, 9);
    expect(editor.undo.undoStack.length).toBeGreaterThan(0);
    undoTo(editor, start);
  });

  it("scales several elements about the centre with Alt", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 100);
    const b = rect(editor, 300, 100, 100, 100);
    editor.services.selection.set([a, b]);
    // Box 100..400 by 100..200, centre (250, 150). The top left corner from
    // (100, 100) to (175, 125) halves it about the centre.
    oneStepDrag(editor, { x: 100, y: 100 }, { x: 175, y: 125 }, { altKey: true });
    expect(box(editor, a)).toMatchObject({ x: 175, y: 125, w: 50, h: 50 });
    expect(box(editor, b)).toMatchObject({ x: 275, y: 125, w: 50, h: 50 });
  });

  it("resizes one element with a side handle, and freely from a corner with Shift", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 100);
    editor.services.selection.set([a]);
    const start = visibleState(editor.doc);
    // The right side handle at (200, 150).
    oneStepDrag(editor, { x: 200, y: 150 }, { x: 260, y: 170 });
    expect(box(editor, a)).toMatchObject({ x: 100, y: 100, w: 160, h: 100 });
    const wider = visibleState(editor.doc);
    // The top left corner with Shift: both sides follow, the others stay.
    oneStepDrag(editor, { x: 100, y: 100 }, { x: 80, y: 140 }, { shiftKey: true });
    expect(box(editor, a)).toMatchObject({ x: 80, y: 140, w: 180, h: 60 });
    undoTo(editor, wider);
    undoTo(editor, start);
  });

  it("changes nothing when a handle is pressed and let go without a move", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 100);
    editor.services.selection.set([a]);
    const state = visibleState(editor.doc);
    const before = steps(editor);
    for (const at of [
      { x: 203, y: 152 }, // the right side handle, a little off its centre
      { x: 198, y: 197 }, // the bottom right corner
      { x: 150, y: 100 - ROTATE_LIFT + 2 }, // the rotation handle
    ]) {
      editor.pointerDown(pointer(at.x, at.y));
      editor.pointerUp(pointer(at.x + 1, at.y));
    }
    expect(visibleState(editor.doc)).toEqual(state);
    expect(steps(editor)).toBe(before);
    expect(editor.selection).toEqual([a]);
  });

  it("moves a small selected element from inside it; its handles stand outside", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 10, 10);
    editor.services.selection.set([a]);
    oneStepDrag(editor, { x: 105, y: 105 }, { x: 205, y: 155 });
    expect(box(editor, a)).toMatchObject({ x: 200, y: 150, w: 10, h: 10 });
    // Its corner handles stand on a box of HANDLE_FRAME_MIN around it: the
    // bottom right one, half of that from the centre, still scales it.
    const c = 205 + HANDLE_FRAME_MIN / 2;
    const half = 155 + HANDLE_FRAME_MIN / 2;
    oneStepDrag(editor, { x: c, y: half }, { x: c + 10, y: half + 10 });
    expect(box(editor, a)).toMatchObject({ x: 200, y: 150, w: 20, h: 20 });
  });

  it("moves a line (no height) from its middle, and resizes it from its ends", () => {
    const editor = make();
    const a = rect(editor, 100, 200, 200, 0);
    editor.services.selection.set([a]);
    oneStepDrag(editor, { x: 200, y: 200 }, { x: 260, y: 260 });
    expect(box(editor, a)).toMatchObject({ x: 160, y: 260, w: 200, h: 0 });
    // The right side handle sits at the line's right end.
    oneStepDrag(editor, { x: 360, y: 260 }, { x: 400, y: 270 });
    expect(box(editor, a)).toMatchObject({ x: 160, y: 260, w: 240, h: 0 });
  });

  it("resizes a turned element along its own axis, the opposite side staying", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 50);
    must(editor, BASICS.rotate, { ids: [a], rot: Math.PI / 2 });
    editor.services.selection.set([a]);
    // Turned a quarter, the box's right side (its own +x) points down: the
    // handle is at the centre (150, 125) plus (0, 50).
    oneStepDrag(editor, { x: 150, y: 175 }, { x: 150, y: 215 });
    const b = box(editor, a);
    expect(b.w).toBeCloseTo(140, 9);
    expect(b.h).toBeCloseTo(50, 9);
    // The opposite side (its own -x, at the top on screen) stays at y = 75.
    const cy = b.y + b.h / 2;
    expect(cy - b.w / 2).toBeCloseTo(75, 9);
  });

  it("moves but does not scale elements of a missing extension", () => {
    const editor = make();
    const m = must<ElementId>(editor, INSERT_MISSING, { x: 100, y: 100, w: 100, h: 100 });
    editor.services.selection.set([m]);
    const start = visibleState(editor.doc);
    // Where the corner handle would be, a drag moves it, at its size.
    oneStepDrag(editor, { x: 200, y: 200 }, { x: 260, y: 230 });
    expect(box(editor, m)).toMatchObject({ x: 160, y: 130, w: 100, h: 100 });
    undoTo(editor, start);
    // The side and rotation handles are not offered either.
    drag(editor, { x: 150, y: 100 - ROTATE_LIFT }, { x: 300, y: 150 });
    expect(box(editor, m)).toMatchObject({ rot: 0, w: 100, h: 100 });
    // Scaled with a shape, it moves with the others and keeps its size: the
    // box 100..400 by 100..200 doubles about its top left corner.
    const s = rect(editor, 300, 100, 100, 100);
    editor.services.selection.set([m, s]);
    oneStepDrag(editor, { x: 400, y: 200 }, { x: 700, y: 300 });
    expect(box(editor, s)).toMatchObject({ x: 500, y: 100, w: 200, h: 200 });
    // Its centre lands where a scaled centre would: (150, 150) to (200, 200).
    expect(box(editor, m)).toMatchObject({ x: 150, y: 150, w: 100, h: 100 });
  });
});

describe("rotating", () => {
  it("rotates one element with the handle above it, in steps with Shift", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 100);
    editor.services.selection.set([a]);
    const start = visibleState(editor.doc);
    // The handle at (150, 100 - lift); from straight above the centre to its right.
    oneStepDrag(editor, { x: 150, y: 100 - ROTATE_LIFT }, { x: 300, y: 150 });
    expect(box(editor, a).rot).toBeCloseTo(Math.PI / 2, 9);
    expect(box(editor, a)).toMatchObject({ x: 100, y: 100 });
    undoTo(editor, start);
    // With Shift, to the nearest 15 degrees: 40 degrees gives 45.
    const angle = (40 * Math.PI) / 180;
    const to = { x: 150 + 100 * Math.sin(angle), y: 150 - 100 * Math.cos(angle) };
    oneStepDrag(editor, { x: 150, y: 100 - ROTATE_LIFT }, to, { shiftKey: true });
    expect(box(editor, a).rot).toBeCloseTo(Math.PI / 4, 9);
  });

  it("rotates several elements together about the selection's centre", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 20, 20);
    const b = rect(editor, 180, 100, 20, 20);
    editor.services.selection.set([a, b]);
    const start = visibleState(editor.doc);
    // Box 100..200 by 100..120, centre (150, 110); a quarter turn clockwise.
    oneStepDrag(editor, { x: 150, y: 100 - ROTATE_LIFT }, { x: 250, y: 110 });
    const ba = box(editor, a);
    const bb = box(editor, b);
    expect(ba.x + 10).toBeCloseTo(150, 9);
    expect(ba.y + 10).toBeCloseTo(70, 9);
    expect(bb.x + 10).toBeCloseTo(150, 9);
    expect(bb.y + 10).toBeCloseTo(150, 9);
    expect(ba.rot).toBeCloseTo(Math.PI / 2, 9);
    undoTo(editor, start);
  });

  it("cancels a rotation with Escape, writing nothing", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 100, 100);
    editor.services.selection.set([a]);
    const state = visibleState(editor.doc);
    editor.pointerDown(pointer(150, 100 - ROTATE_LIFT));
    editor.pointerMove(pointer(300, 150));
    expect(editor.scene.preview.get(a)?.rot).toBeCloseTo(Math.PI / 2, 9);
    expect(editor.keyDown(key("Escape"))).toEqual({ kind: "tool-key" });
    expect(editor.scene.preview.size).toBe(0);
    editor.pointerUp(pointer(300, 150));
    expect(visibleState(editor.doc)).toEqual(state);
  });

  it("offers no rotation handle for a group", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 150, 100, 50, 50);
    must<ElementId>(editor, BASICS.group, { ids: [a, b] });
    const state = visibleState(editor.doc);
    drag(editor, { x: 150, y: 100 - ROTATE_LIFT }, { x: 300, y: 125 });
    expect(visibleState(editor.doc)).toEqual(state);
  });
});

describe("the keys, the clipboard and the context menu", () => {
  it("groups, ungroups, locks, duplicates and deletes with the keys, each undone", () => {
    const editor = make({ mode: "advanced" });
    const a = rect(editor, 100, 100, 50, 50);
    const b = rect(editor, 200, 100, 50, 50);
    editor.services.selection.set([a, b]);
    const press = (k: string, extra = {}) => {
      const before = visibleState(editor.doc);
      const result = editor.keyDown(key(k, { ctrlKey: true, ...extra }));
      expect(result).toMatchObject({ kind: "command", outcome: { ok: true } });
      return before;
    };
    let before = press("g");
    const [g] = editor.selection;
    expect(editor.live.get(g!)?.type).toBe("core/group");
    undoTo(editor, before);
    editor.keyDown(key("y", { ctrlKey: true }));
    editor.services.selection.set([g!]);
    before = press("G", { shiftKey: true, code: "KeyG" });
    expect(editor.selection).toEqual([a, b]);
    undoTo(editor, before);
    editor.keyDown(key("y", { ctrlKey: true }));
    editor.services.selection.set([a, b]);
    before = press("d");
    expect(editor.selection).toHaveLength(2);
    expect(editor.selection).not.toContain(a);
    undoTo(editor, before);
    editor.services.selection.set([a]);
    before = press("L", { shiftKey: true, code: "KeyL" });
    expect(editor.live.isLocked(a)).toBe(true);
    undoTo(editor, before);
    editor.services.selection.set([a]);
    before = visibleState(editor.doc);
    expect(editor.keyDown(key("Delete"))).toMatchObject({ outcome: { ok: true } });
    expect(editor.live.isGone(a)).toBe(true);
    undoTo(editor, before);
  });

  it("copies to the system clipboard, and pastes from it into another document", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    editor.services.selection.set([a]);
    const data = clipboardData();
    expect(editor.clipboardCopy(data)).toBe(true);
    expect(data.types).toEqual([FRAGMENT_MIME, "text/plain"]);
    expect(decodeFragment(data.getData(FRAGMENT_MIME))).toMatchObject({ roots: [a] });

    // Another editor, another document: only the clipboard data carries it.
    const other = make();
    const before = visibleState(other.doc);
    expect(other.clipboard).toBeNull();
    expect(other.clipboardPaste(readClipboard(data))).toBe(true);
    const [pasted] = other.selection;
    expect(pasted).toBeDefined();
    expect(box(other, pasted!)).toMatchObject({ x: 100, y: 100, w: 50, h: 50 });
    undoTo(other, before);

    // Plain text alone (what the asynchronous clipboard reads) is enough.
    const text = clipboardData();
    text.setData("text/plain", data.getData("text/plain"));
    expect(other.clipboardPaste(readClipboard(text))).toBe(true);
    // Text that is not the program's, and an envelope of another version, are not pasted.
    const foreign = clipboardData();
    foreign.setData("text/plain", "hello");
    expect(readClipboard(foreign)).toMatchObject({ fragment: undefined, text: "hello" });
    expect(other.clipboardPaste(readClipboard(foreign))).toBe(false);
    foreign.setData(
      "text/plain",
      JSON.stringify({ kind: "galatsa/fragment", version: 99, fragment: {} }),
    );
    expect(other.clipboardPaste(readClipboard(foreign))).toBe(false);
    // A damaged fragment is refused by paste, writing nothing.
    const damaged = clipboardData();
    damaged.setData(
      FRAGMENT_MIME,
      JSON.stringify({ kind: "galatsa/fragment", version: 1, fragment: { roots: 1 } }),
    );
    const state = visibleState(other.doc);
    expect(other.clipboardPaste(readClipboard(damaged))).toBe(false);
    expect(visibleState(other.doc)).toEqual(state);
  });

  it("pastes in the middle of the view what was copied out of sight", () => {
    const editor = make();
    const a = rect(editor, 5000, 5000, 100, 100);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    // The view is 0..1000 by 0..800: the copy lands with its centre at (500, 400).
    expect(editor.clipboardPaste(readClipboard(data))).toBe(true);
    expect(box(editor, editor.selection[0]!)).toMatchObject({ x: 450, y: 350 });
  });

  it("cuts as one step that undo takes back", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 50, 50);
    editor.services.selection.set([a]);
    const before = visibleState(editor.doc);
    const data = clipboardData();
    expect(editor.clipboardCut(data)).toBe(true);
    expect(editor.live.isGone(a)).toBe(true);
    expect(data.types).toContain(FRAGMENT_MIME);
    undoTo(editor, before);
  });

  it("opens a context menu that selects a locked element so it can be unlocked", () => {
    const editor = make({ mode: "advanced" });
    const a = rect(editor, 100, 100, 50, 50);
    setLocked(editor.doc, a, true);
    editor.services.selection.set([]);
    const calls: string[] = [];
    const clipboard: MenuClipboard = {
      copy: () => calls.push("copy"),
      cut: () => calls.push("cut"),
      paste: () => calls.push("paste"),
    };
    openContextMenu(editor, { x: 120, y: 120 }, clipboard);
    expect(editor.selection).toEqual([a]);
    const menu = editor.contextMenu.state!;
    expect(menu).toMatchObject({ x: 120, y: 120 });
    const entry = (k: string) => menu.entries.find((e) => e.key === k);
    expect(entry(BASICS.unlock)?.enabled).toBe(true);
    expect(entry(BASICS.lock)?.enabled).toBe(false);
    expect(entry(BASICS.delete)?.enabled).toBe(false);
    expect(entry(BASICS.copy)?.enabled).toBe(true);
    expect(entry("cut")?.enabled).toBe(false);
    const before = visibleState(editor.doc);
    editor.contextMenu.choose(entry(BASICS.unlock)!);
    expect(editor.contextMenu.state).toBeNull();
    expect(editor.live.isLocked(a)).toBe(false);
    undoTo(editor, before);
    // The clipboard entries are the page's.
    openContextMenu(editor, { x: 120, y: 120 }, clipboard);
    editor.contextMenu.choose(
      editor.contextMenu.state!.entries.find((e) => e.key === BASICS.copy)!,
    );
    expect(calls).toEqual(["copy"]);
  });

  it("offers in the context menu only what the mode offers, greyed out when refused", () => {
    const editor = make();
    const none: MenuClipboard = { copy() {}, cut() {}, paste() {} };
    const keys = menuEntries(editor, none).map((e) => [e.key, e.enabled]);
    expect(keys).toEqual([
      ["cut", false],
      [BASICS.copy, false],
      [BASICS.paste, true],
      [BASICS.duplicate, false],
      [BASICS.delete, false],
      [BASICS.group, false],
      [BASICS.ungroup, false],
      [BASICS.selectAll, true],
    ]);
  });
});

describe("the tool session", () => {
  it("gives tools the extension lookup only, not the host and its registry", () => {
    const editor = make();
    let seen: ToolSession | null = null;
    const problems = editor.host.load([
      defineEditExtension({
        view: defineViewExtension({
          id: "test.peek",
          version: "0.0.0",
          api: EXTENSION_API_VERSION,
        }),
        contributes: {
          tools: [
            {
              name: "peek",
              quick: true,
              label: "common:action.ok",
              start(session) {
                seen = session;
                return {};
              },
            },
          ],
        },
      }),
    ]);
    expect(problems).toEqual([]);
    expect(editor.tools.select("test.peek/peek")).toBe(true);
    const session = seen as ToolSession | null;
    const extensions = session!.extensions as unknown as Record<string, unknown>;
    expect(extensions).not.toBe(editor.host);
    expect(extensions["commands"]).toBeUndefined();
    expect(Object.keys(extensions).sort()).toEqual(["capabilities", "elementType"]);
    expect(session!.extensions.elementType("examples.shape/shape")).toBeDefined();
  });
});
