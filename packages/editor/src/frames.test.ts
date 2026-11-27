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
  labelAt,
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
    openContextMenu(editor, { x: 120, y: 100 - LABEL_HEIGHT / 2 }, none);
    expect(editor.selection).toEqual([f]);
    // An element over the name wins.
    const over = rect(editor, 110, 80, 40, 40);
    openContextMenu(editor, { x: 120, y: 100 - LABEL_HEIGHT / 2 }, none);
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

  it("goes into the container of what is selected, centred on the selection", () => {
    const editor = make();
    const a = rect(editor, 50, 50, 40, 40);
    const f = frame(editor, 600, 100, 300, 300);
    const inF = rect(editor, 100, 100, 20, 20, f); // centre (710, 210)
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.services.selection.set([inF]);
    editor.clipboardPaste(readClipboard(data));
    const [copy] = editor.selection;
    expect(at(editor, copy!)).toEqual({ x: 690, y: 190, parent: f });
  });

  it("pastes a copied frame next to the copy pasted before, never into it (F-E)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 200);
    rect(editor, 10, 10, 40, 40, f);
    editor.services.selection.set([f]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    editor.clipboardPaste(readClipboard(data));
    const [first] = editor.selection;
    expect(at(editor, first!).parent).toBeNull();
    editor.clipboardPaste(readClipboard(data));
    const [second] = editor.selection;
    expect(second).not.toBe(first);
    expect(at(editor, second!).parent).toBeNull();
    // A third, with the second selected: on the canvas too.
    editor.clipboardPaste(readClipboard(data));
    expect(at(editor, editor.selection[0]!).parent).toBeNull();
  });

  it("does not leave a copy of an element of a frame on top of that frame outside it (F-K)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 300);
    const x = rect(editor, 10, 10, 40, 40, f);
    const y = rect(editor, 600, 500, 40, 40);
    editor.services.selection.set([x]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    // A selection on the canvas: the copy goes there, onto it, not onto the frame.
    editor.services.selection.set([y]);
    editor.clipboardPaste(readClipboard(data));
    expect(at(editor, editor.selection[0]!)).toEqual({ x: 600, y: 500, parent: null });
    // A selection on the canvas that lies over the frame: the copy shows in
    // the frame, so it goes into it.
    const over = rect(editor, 300, 300, 40, 40);
    editor.services.selection.set([over]);
    editor.clipboardPaste(readClipboard(data));
    expect(at(editor, editor.selection[0]!)).toEqual({ x: 300, y: 300, parent: f });
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

function inside(
  editor: Editor,
  parent: ElementId,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  return must<ElementId>(editor, INSERT_FRAME, { x, y, w, h, parent });
}

/** A drag with Shift held down once it has started (Shift at the press adds to the selection). */
function shiftDrag(
  editor: Editor,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  editor.pointerDown(pointer(from.x, from.y));
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    editor.pointerMove(
      pointer(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, {
        shiftKey: true,
      }),
    );
  }
  editor.pointerUp(pointer(to.x, to.y, { shiftKey: true }));
}

describe("the drop rule: an element stays in its frame unless it clearly lands elsewhere", () => {
  it("keeps an element in a frame that is in a group (F-A), and the frame in the group (F-A2)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 400, 300);
    const g = must<ElementId>(editor, BASICS.group, {
      ids: [f, rect(editor, 600, 100, 40, 40)],
    });
    const a = rect(editor, 10, 10, 40, 40, f);
    editor.services.selection.set([]);
    drag(editor, { x: 130, y: 130 }, { x: 160, y: 160 });
    expect(at(editor, a)).toEqual({ x: 140, y: 140, parent: f });
    // Dropped into the frame in the group from the canvas.
    const b = rect(editor, 700, 600, 40, 40);
    drag(editor, { x: 720, y: 620 }, { x: 300, y: 300 });
    expect(at(editor, b).parent).toBe(f);
    // The frame dragged by its name stays in its group.
    editor.services.selection.set([]);
    drag(
      editor,
      { x: 110, y: 100 - LABEL_HEIGHT / 2 },
      { x: 140, y: 130 - LABEL_HEIGHT / 2 },
    );
    expect(at(editor, f)).toEqual({ x: 130, y: 130, parent: g });
  });

  it("keeps an element in a nested frame where that reaches out of its frame, and drops into that part (F-B)", () => {
    const editor = make();
    const outer = frame(editor, 100, 100, 300, 300);
    const out = inside(editor, outer, 200, 10, 300, 100); // 300..600 by 110..210
    const a = rect(editor, 180, 20, 40, 40, out); // 480..520, outside `outer`
    editor.services.selection.set([]);
    drag(editor, { x: 500, y: 150 }, { x: 510, y: 150 });
    expect(at(editor, a)).toEqual({ x: 490, y: 130, parent: out });
    const b = rect(editor, 700, 600, 40, 40);
    drag(editor, { x: 720, y: 620 }, { x: 550, y: 160 });
    expect(at(editor, b).parent).toBe(out);
  });

  it("keeps a frame dragged by its name where it is, also when the name lies over another frame (F-C)", () => {
    const editor = make();
    const outer = frame(editor, 100, 100, 400, 300);
    const top = inside(editor, outer, 50, 5, 100, 100); // its name lies above `outer`
    editor.services.selection.set([]);
    drag(
      editor,
      { x: 160, y: 105 - LABEL_HEIGHT / 2 },
      { x: 170, y: 115 - LABEL_HEIGHT / 2 },
    );
    expect(at(editor, top)).toEqual({ x: 160, y: 115, parent: outer });
    // A frame just below another: its name lies over the one above.
    const above = frame(editor, 100, 600, 200, 100);
    const below = frame(editor, 100, 710, 200, 100);
    editor.services.selection.set([]);
    drag(
      editor,
      { x: 120, y: 710 - LABEL_HEIGHT / 2 },
      { x: 140, y: 730 - LABEL_HEIGHT / 2 },
    );
    expect(at(editor, below)).toEqual({ x: 120, y: 730, parent: null });
    expect(editor.live.logicalChildren(above)).toEqual([]);
  });

  it("follows the element where Shift keeps the move level, not the pointer (F-D)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 300, 200); // 100..400 by 100..300
    const a = rect(editor, 10, 150, 40, 40, f); // 110..150 by 250..290
    editor.services.selection.set([]);
    // The pointer ends below the frame; the element moves only sideways.
    shiftDrag(editor, { x: 130, y: 270 }, { x: 230, y: 320 });
    expect(at(editor, a)).toEqual({ x: 210, y: 250, parent: f });
  });

  it("keeps an element that reaches out of its frame there, until it is clearly dragged away (F-F)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 200, 200); // 100..300
    const a = rect(editor, 170, 50, 100, 40, f); // 270..370: its centre is outside
    editor.services.selection.set([]);
    // Taken by the part outside the frame and moved a little: it stays.
    drag(editor, { x: 350, y: 170 }, { x: 355, y: 170 });
    expect(at(editor, a)).toEqual({ x: 275, y: 150, parent: f });
    // Dragged well away (more than half its size): it leaves.
    drag(editor, { x: 355, y: 170 }, { x: 655, y: 170 });
    expect(at(editor, a)).toEqual({ x: 575, y: 150, parent: null });
    // A selection in a frame and on the canvas, moved a little: each stays.
    const inF = rect(editor, 10, 10, 40, 40, f);
    const onCanvas = rect(editor, 500, 500, 40, 40);
    editor.services.selection.set([inF, onCanvas]);
    drag(editor, { x: 130, y: 130 }, { x: 135, y: 130 });
    expect(at(editor, inF)).toEqual({ x: 115, y: 110, parent: f });
    expect(at(editor, onCanvas)).toEqual({ x: 505, y: 500, parent: null });
  });

  it("moves an element out when its centre crosses its frame's edge, and in when it crosses another's", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 200, 200);
    const g = frame(editor, 500, 100, 200, 200);
    const a = rect(editor, 80, 80, 40, 40, f); // centre (200, 200)
    editor.services.selection.set([]);
    drag(editor, { x: 200, y: 200 }, { x: 400, y: 200 });
    expect(at(editor, a).parent).toBeNull();
    drag(editor, { x: 400, y: 200 }, { x: 600, y: 200 });
    expect(at(editor, a).parent).toBe(g);
  });
});

describe("frames on the canvas", () => {
  it("draws a dragged frame's outline and name where the preview is (F-G)", () => {
    const editor = make();
    const f = frame(editor, 100, 100, 200, 100);
    editor.services.selection.set([]);
    editor.pointerDown(pointer(120, 100 - LABEL_HEIGHT / 2));
    for (let i = 1; i <= 4; i++)
      editor.pointerMove(pointer(120 + 25 * i, 100 - LABEL_HEIGHT / 2));
    const during = shownFrames(editor.services, editor.doc).find((s) => s.id === f)!;
    expect(during.box).toMatchObject({ x: 200, y: 100 });
    editor.pointerUp(pointer(220, 100 - LABEL_HEIGHT / 2));
    expect(at(editor, f)).toMatchObject({ x: 200, y: 100 });
  });

  it("takes the name of the frame on top where names overlap (F-H)", () => {
    const editor = make();
    const a = frame(editor, 100, 100, 100, 100);
    const b = frame(editor, 150, 100, 100, 100);
    must(editor, BASICS.rename, { id: a, name: "A long name for the frame" });
    const point = { x: 170, y: 100 - LABEL_HEIGHT / 2 };
    const shown = () => shownFrames(editor.services, editor.doc);
    expect(labelAt(editor.doc, shown(), point, 1)).toBe(b);
    must(editor, BASICS.sendToBack, { ids: [b] });
    expect(labelAt(editor.doc, shown(), point, 1)).toBe(a);
  });

  it("takes a name only where it is drawn: not over a small frame's neighbours (F-L)", () => {
    const editor = make();
    const small = frame(editor, 100, 100, 20, 20);
    const narrow = frame(editor, 300, 100, 40, 40);
    editor.services.selection.set([]);
    // Under LABEL_MIN_FRAME pixels wide: no name, nothing to take above it.
    click(editor, 110, 100 - LABEL_HEIGHT / 2);
    expect(editor.selection).toEqual([]);
    // A name is no wider than its frame on screen.
    click(editor, 330, 100 - LABEL_HEIGHT / 2);
    expect(editor.selection).toEqual([narrow]);
    editor.services.selection.set([]);
    click(editor, 345, 100 - LABEL_HEIGHT / 2);
    expect(editor.selection).toEqual([]);
    expect(small).toBeDefined();
  });
});
