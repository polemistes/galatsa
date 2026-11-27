// SPDX-License-Identifier: GPL-3.0-or-later

// Frames and the stacking order in the editor (docs/adr/0014-stacking-and-frames.md),
// with pointer events and keys as the page sends them: dragging into and out
// of frames, a frame taken by its name, a click and a band on a frame's
// background, the frame tool, the stacking keys on US and Norwegian
// keyboards, the context menu's entries, renaming in the panel, and where a
// paste lands when frames are involved. Each action is one undo step. The
// test editor shows root space one to one: a screen pixel is a world unit.

import type { ElementId } from "@galatsa/core";
import { setLocked } from "@galatsa/core/ydoc";
import { BASICS, elementName } from "@galatsa/extension-basics";
import { INSERT_FRAME, visibleState } from "@galatsa/extension-basics/testing";
import {
  FRAME_TOOL,
  LABEL_HEIGHT,
  SELECT_TOOL,
  shownFrames,
} from "@galatsa/extension-select";
import { afterEach, describe, expect, it } from "vitest";
import { readClipboard, type ClipboardSource } from "./clipboard.ts";
import { menuEntries, openContextMenu, type MenuClipboard } from "./context-menu.ts";
import type { Editor } from "./editor.ts";
import { RENAME_FRAME, RENAME_PANEL } from "./rename.ts";
import { drag, key, pointer, testEditor } from "./test-support.ts";

const editors: Editor[] = [];
function make(): Editor {
  const { editor } = testEditor();
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

function rect(
  editor: Editor,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: ElementId | null = null,
): ElementId {
  return must<ElementId>(editor, "examples.shape/insert", {
    kind: "rect",
    x,
    y,
    w,
    h,
    parent,
  });
}

function frame(editor: Editor, x: number, y: number, w: number, h: number): ElementId {
  return must<ElementId>(editor, INSERT_FRAME, { x, y, w, h });
}

function at(editor: Editor, id: ElementId) {
  const p = editor.services.scene.placement(id)!;
  return { x: p.worldX, y: p.worldY, parent: editor.live.logicalParentOf(id) };
}

function steps(editor: Editor): number {
  return editor.undo.undoStack.length;
}

/**
 * Runs `fn`, which must make exactly one undo step; undo gives the state
 * back, redo the result. Returns the selection right after `fn`, which undo
 * and redo do not keep.
 */
function oneStep(editor: Editor, fn: () => void): readonly ElementId[] {
  const before = visibleState(editor.doc);
  const count = steps(editor);
  fn();
  const selected = editor.selection;
  expect(steps(editor)).toBe(count + 1);
  const after = visibleState(editor.doc);
  editor.keyDown(key("z", { ctrlKey: true }));
  expect(visibleState(editor.doc)).toEqual(before);
  editor.keyDown(key("Z", { ctrlKey: true, shiftKey: true, code: "KeyZ" }));
  expect(visibleState(editor.doc)).toEqual(after);
  return selected;
}

function click(editor: Editor, x: number, y: number): void {
  editor.pointerDown(pointer(x, y));
  editor.pointerUp(pointer(x, y));
}

describe("dragging into and out of frames", () => {
  it("drops an element into the frame under the pointer, and out again, each one step", () => {
    const editor = make();
    const f = frame(editor, 300, 100, 400, 300);
    const a = rect(editor, 50, 50, 40, 40);
    editor.services.selection.set([]);
    oneStep(editor, () => drag(editor, { x: 70, y: 70 }, { x: 420, y: 220 }));
    expect(at(editor, a)).toEqual({ x: 400, y: 200, parent: f });
    // The frame moves with what is in it.
    must(editor, BASICS.move, { ids: [f], dx: 10, dy: 0 });
    expect(at(editor, a)).toEqual({ x: 410, y: 200, parent: f });
    // Out to the canvas.
    oneStep(editor, () => drag(editor, { x: 430, y: 220 }, { x: 830, y: 620 }));
    expect(at(editor, a)).toEqual({ x: 810, y: 600, parent: null });
  });

  it("keeps an element in its frame while the pointer stays inside it", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 400, 300);
    const a = rect(editor, 10, 10, 40, 40, f);
    editor.services.selection.set([]);
    drag(editor, { x: 130, y: 130 }, { x: 330, y: 230 });
    expect(at(editor, a)).toEqual({ x: 310, y: 210, parent: f });
  });

  it("does not drop into a locked frame, nor a frame into itself", () => {
    const editor = make();
    const f = frame(editor, 300, 100, 400, 300);
    setLocked(editor.doc, f, true);
    const a = rect(editor, 50, 50, 40, 40);
    editor.services.selection.set([]);
    drag(editor, { x: 70, y: 70 }, { x: 420, y: 220 });
    expect(at(editor, a)).toEqual({ x: 400, y: 200, parent: null });
    setLocked(editor.doc, f, false);
    // A frame dragged by its name stays on the canvas.
    const g = frame(editor, 0, 500, 100, 100);
    editor.services.selection.set([]);
    drag(
      editor,
      { x: 10, y: 500 - LABEL_HEIGHT / 2 },
      { x: 40, y: 530 - LABEL_HEIGHT / 2 },
    );
    expect(at(editor, g)).toEqual({ x: 30, y: 530, parent: null });
  });
});

describe("taking frames", () => {
  it("selects a frame by its name above it and drags it, with what is in it, as one step", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 200);
    const a = rect(editor, 10, 10, 50, 50, f);
    editor.services.selection.set([]);
    const name = { x: 120, y: 100 - LABEL_HEIGHT / 2 };
    click(editor, name.x, name.y);
    expect(editor.selection).toEqual([f]);
    editor.services.selection.set([]);
    oneStep(editor, () => drag(editor, name, { x: name.x + 200, y: name.y + 50 }));
    expect(at(editor, f)).toEqual({ x: 300, y: 150, parent: null });
    expect(at(editor, a)).toEqual({ x: 310, y: 160, parent: f });
  });

  it("selects a frame with a click on its background and moves it with a drag; with Shift a drag draws a band among its contents", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 400, 300);
    const a = rect(editor, 20, 20, 40, 40, f);
    const b = rect(editor, 120, 20, 40, 40, f);
    rect(editor, 300, 200, 40, 40, f);
    editor.services.selection.set([]);
    click(editor, 300, 150);
    expect(editor.selection).toEqual([f]);
    // With Shift, a band among what is in the frame, added to the selection.
    editor.services.selection.set([]);
    const before = visibleState(editor.doc);
    drag(editor, { x: 105, y: 105 }, { x: 250, y: 150 }, { shiftKey: true });
    expect(editor.selection).toEqual([a, b]);
    expect(visibleState(editor.doc)).toEqual(before);
    // A Shift-click on the background adds the frame, and takes it out again.
    editor.pointerDown(pointer(300, 150, { shiftKey: true }));
    editor.pointerUp(pointer(300, 150, { shiftKey: true }));
    expect(editor.selection).toEqual([a, b, f]);
    editor.pointerDown(pointer(300, 150, { shiftKey: true }));
    editor.pointerUp(pointer(300, 150, { shiftKey: true }));
    expect(editor.selection).toEqual([a, b]);
    // Between the selected elements, a drag moves them, not the frame.
    drag(editor, { x: 200, y: 140 }, { x: 210, y: 150 });
    expect(at(editor, a)).toEqual({ x: 130, y: 130, parent: f });
    expect(at(editor, f)).toEqual({ x: 100, y: 100, parent: null });
    // A drag on the background of a frame that is not selected moves it.
    editor.services.selection.set([]);
    oneStep(editor, () => drag(editor, { x: 400, y: 380 }, { x: 410, y: 390 }));
    expect(at(editor, f)).toEqual({ x: 110, y: 110, parent: null });
  });

  it("lists the frames on screen for their names, nested ones too", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 400, 300);
    const inner = must<ElementId>(editor, INSERT_FRAME, {
      x: 10,
      y: 10,
      w: 50,
      h: 50,
      parent: f,
    });
    frame(editor, 5000, 5000, 10, 10);
    expect(shownFrames(editor.services, editor.doc).map((s) => s.id)).toEqual([f, inner]);
  });
});

describe("the frame tool", () => {
  it("draws a frame around what lies inside the rectangle, as one step, and selects it", async () => {
    const editor = make();
    const a = rect(editor, 100, 100, 40, 40);
    const b = rect(editor, 200, 100, 40, 40);
    const outside = rect(editor, 400, 100, 40, 40);
    editor.services.selection.set([]);
    expect(editor.keyDown(key("f"))).toMatchObject({ kind: "tool" });
    expect(editor.tools.current).toBe(FRAME_TOOL);
    const selected = oneStep(editor, () =>
      drag(editor, { x: 80, y: 80 }, { x: 300, y: 200 }),
    );
    const f = editor.live.logicalParentOf(a)!;
    expect(f).not.toBeNull();
    expect(editor.live.logicalParentOf(b)).toBe(f);
    expect(editor.live.logicalParentOf(outside)).toBeNull();
    expect(at(editor, f)).toEqual({ x: 80, y: 80, parent: null });
    expect(selected).toEqual([f]);
    // The selection tool comes back once the event is handled.
    await Promise.resolve();
    expect(editor.tools.current).toBe(SELECT_TOOL);
  });

  it("makes a frame of a set size with a click, inside the frame under it", () => {
    const editor = make();
    const outer = frame(editor, 0, 0, 2000, 2000);
    editor.services.selection.set([]);
    editor.keyDown(key("f"));
    click(editor, 100, 100);
    const [f] = editor.selection;
    expect(at(editor, f!)).toEqual({ x: 100, y: 100, parent: outer });
    expect(editor.live.get(f!)?.size).toEqual({ w: 480, h: 270 });
  });
});

describe("the stacking keys", () => {
  it("restack inside a frame with the brackets and the arrows, each one step", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 400, 300);
    const picture = rect(editor, 0, 0, 400, 300, f);
    const text = rect(editor, 20, 20, 200, 40, f);
    const order = () => editor.live.logicalChildren(f);
    editor.services.selection.set([text]);
    // Norwegian keyboard: Ctrl and Å (the key right of P).
    oneStep(editor, () =>
      editor.keyDown(key("å", { ctrlKey: true, code: "BracketLeft" })),
    );
    expect(order()).toEqual([text, picture]);
    // Ctrl and ¨ (a dead key, right of Å).
    oneStep(editor, () =>
      editor.keyDown(key("Dead", { ctrlKey: true, code: "BracketRight" })),
    );
    expect(order()).toEqual([picture, text]);
    // Ctrl+Shift+ArrowDown sends to the back, Ctrl+Shift+] (US) brings to the front.
    editor.services.selection.set([text]);
    oneStep(editor, () =>
      editor.keyDown(
        key("ArrowDown", { ctrlKey: true, shiftKey: true, code: "ArrowDown" }),
      ),
    );
    expect(order()).toEqual([text, picture]);
    oneStep(editor, () =>
      editor.keyDown(key("}", { ctrlKey: true, shiftKey: true, code: "BracketRight" })),
    );
    expect(order()).toEqual([picture, text]);
    // Ctrl+ArrowUp at the front: nothing to do, and no step.
    const count = steps(editor);
    editor.keyDown(key("ArrowUp", { ctrlKey: true, code: "ArrowUp" }));
    expect(steps(editor)).toBe(count);
    // The picture at the back with the text on top: moving the frame shifts nothing.
    must(editor, BASICS.move, { ids: [f], dx: 300, dy: 100 });
    expect(at(editor, picture)).toEqual({ x: 400, y: 200, parent: f });
    expect(at(editor, text)).toEqual({ x: 420, y: 220, parent: f });
    expect(order()).toEqual([picture, text]);
  });
});

describe("the context menu", () => {
  const none: MenuClipboard = { copy() {}, cut() {}, paste() {} };
  const entry = (editor: Editor, k: string) =>
    menuEntries(editor, none).find((e) => e.key === k)!;

  it("frames the selection, takes it out, removes the frame and restacks, each one step", () => {
    const editor = make();
    const a = rect(editor, 100, 100, 40, 40);
    const b = rect(editor, 200, 100, 40, 40);
    editor.services.selection.set([a, b]);
    expect(entry(editor, BASICS.frame).enabled).toBe(true);
    expect(entry(editor, BASICS.moveOutOfFrame).enabled).toBe(false);
    const [f] = oneStep(editor, () => entry(editor, BASICS.frame).run()) as [ElementId];
    expect(editor.live.logicalChildren(f)).toEqual([a, b]);
    editor.services.selection.set([a]);
    expect(entry(editor, BASICS.sendToBack).enabled).toBe(false);
    expect(entry(editor, BASICS.bringToFront).enabled).toBe(true);
    oneStep(editor, () => entry(editor, BASICS.bringToFront).run());
    expect(editor.live.logicalChildren(f)).toEqual([b, a]);
    oneStep(editor, () => entry(editor, BASICS.moveOutOfFrame).run());
    expect(at(editor, a).parent).toBeNull();
    editor.services.selection.set([a]);
    oneStep(editor, () => entry(editor, BASICS.moveIntoFrame).run());
    expect(at(editor, a).parent).toBe(f);
    editor.services.selection.set([f]);
    const freed = oneStep(editor, () => entry(editor, BASICS.removeFrame).run());
    expect(editor.live.isGone(f)).toBe(true);
    expect(freed).toEqual([b, a]);
  });

  it("opens the rename panel for one frame, with F2 too; a new name is one step", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 200);
    const a = rect(editor, 600, 100, 40, 40);
    editor.services.selection.set([a]);
    expect(entry(editor, RENAME_FRAME).enabled).toBe(false);
    editor.services.selection.set([f]);
    expect(entry(editor, RENAME_FRAME).enabled).toBe(true);
    entry(editor, RENAME_FRAME).run();
    expect(editor.services.panels.isOpen(RENAME_PANEL)).toBe(true);
    editor.services.panels.close(RENAME_PANEL);
    editor.keyDown(key("F2", { code: "F2" }));
    expect(editor.services.panels.isOpen(RENAME_PANEL)).toBe(true);
    // What the panel runs.
    oneStep(editor, () => must(editor, BASICS.rename, { id: f, name: "Kapittel 1" }));
    expect(elementName(editor.doc, f)).toBe("Kapittel 1");
  });

  it("selects a frame with a right click on its name, a locked one too", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 200);
    const a = rect(editor, 600, 100, 40, 40);
    setLocked(editor.doc, f, true);
    editor.services.selection.set([a]);
    openContextMenu(editor, { x: 150, y: 100 - LABEL_HEIGHT / 2 }, none);
    expect(editor.selection).toEqual([f]);
    // An element over the name wins.
    const over = rect(editor, 140, 80, 40, 40);
    openContextMenu(editor, { x: 150, y: 100 - LABEL_HEIGHT / 2 }, none);
    expect(editor.selection).toEqual([over]);
  });
});

/** A clipboard as a copy event's data transfer holds it. */
function clipboardData(): ClipboardSource & {
  setData(type: string, data: string): void;
} {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    getData: (type) => store.get(type) ?? "",
    setData: (type, data) => {
      store.set(type, data);
    },
  };
}

describe("where a paste lands among frames", () => {
  it("goes into a selected frame, at its place when that is inside the frame", () => {
    const editor = make();
    const a = rect(editor, 120, 120, 40, 40);
    const f = frame(editor, 100, 100, 300, 300);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.services.selection.set([f]);
    expect(editor.clipboardPaste(readClipboard(data))).toBe(true);
    const [copy] = editor.selection;
    expect(at(editor, copy!)).toEqual({ x: 120, y: 120, parent: f });
  });

  it("goes into the container of what is selected, centred in the part of it in view", () => {
    const editor = make();
    const a = rect(editor, 50, 50, 40, 40);
    const f = frame(editor, 600, 100, 300, 300);
    const inF = rect(editor, 10, 10, 20, 20, f);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.services.selection.set([inF]);
    editor.clipboardPaste(readClipboard(data));
    const [copy] = editor.selection;
    // Centred in the frame's box (600..900 by 100..400).
    expect(at(editor, copy!)).toEqual({ x: 730, y: 230, parent: f });
  });

  it("goes into the frame in view when what it was copied from is out of view", () => {
    const editor = make();
    const far = frame(editor, 5000, 5000, 300, 300);
    const a = rect(editor, 10, 10, 40, 40, far);
    const here = frame(editor, 100, 100, 800, 600);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.services.selection.set([]);
    editor.clipboardPaste(readClipboard(data));
    const [copy] = editor.selection;
    // The view is 0..1000 by 0..800; its centre (500, 400) is in `here`.
    expect(at(editor, copy!)).toEqual({ x: 480, y: 380, parent: here });
  });

  it("goes back next to what was copied while it is in view", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 300);
    const a = rect(editor, 10, 10, 40, 40, f);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.clipboardPaste(readClipboard(data));
    const [copy] = editor.selection;
    expect(at(editor, copy!)).toEqual({ x: 110, y: 110, parent: f });
  });
});
