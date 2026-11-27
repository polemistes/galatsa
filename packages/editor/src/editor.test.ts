// SPDX-License-Identifier: GPL-3.0-or-later

// The editor core over a real document: tools used with pointer events, undo
// and redo from the keyboard, gestures previewed without writing and committed
// as one step, the live resolver feeding the renderer, and the services.

import { FRAME_TYPE } from "@galatsa/core";
import { addElement, initDocument, roots, toSnapshot } from "@galatsa/core/ydoc";
import { BASICS } from "@galatsa/extension-basics";
import { SHAPE_TYPE } from "@galatsa/extension-examples";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Editor } from "./editor.ts";
import { drag, key, pointer, testEditor } from "./test-support.ts";

const editors: Editor[] = [];
function make(...args: Parameters<typeof testEditor>) {
  const made = testEditor(...args);
  editors.push(made.editor);
  return made;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function shapes(editor: Editor): string[] {
  const live = editor.live;
  return [...live.ids()].filter(
    (id) => live.get(id)?.type === SHAPE_TYPE && !live.isGone(id),
  );
}

describe("editor core", () => {
  it("records work from the first edit and has one undo manager", () => {
    // A document that came as an update (as from a sync provider) has no work
    // tracker; the editor attaches one before anything writes.
    const source = new Y.Doc();
    initDocument(source);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    const { editor } = make({ doc });
    expect(editor.tools.select("examples.shape/rect")).toBe(true);
    drag(editor, { x: 100, y: 100 }, { x: 300, y: 200 });
    const [id] = shapes(editor);
    expect(id).toBeDefined();
    const record = roots(doc).elements.get(id!) as Y.Map<unknown>;
    const rev = record.get("rev") as Y.Map<unknown> | undefined;
    expect(rev?.size ?? 0).toBeGreaterThan(0);
    expect(editor.undo.undoStack.length).toBe(1);
  });

  it("uses a shape tool with the mouse, and undoes and redoes with the keyboard", () => {
    const { editor } = make();
    expect(editor.keyDown(key("r"))).toEqual({
      kind: "tool",
      tool: "examples.shape/rect",
    });
    drag(editor, { x: 100, y: 120 }, { x: 300, y: 220 });
    const [id] = shapes(editor);
    expect(id).toBeDefined();
    const box = editor.services.scene.placement(id!);
    expect(box).toMatchObject({ x: 100, y: 120, w: 200, h: 100 });
    // The renderer heard of it through the live resolver.
    expect(editor.renderer.screenBounds(id!)).toMatchObject({
      x: 100,
      y: 120,
      w: 200,
      h: 100,
    });
    // The shape tool is done after one shape: back to the default tool.
    return Promise.resolve().then(() => {
      expect(editor.tools.current).toBe("examples.select/select");

      const undo = editor.keyDown(key("z", { ctrlKey: true }));
      expect(undo).toMatchObject({ kind: "command", command: BASICS.undo });
      expect(shapes(editor)).toEqual([]);
      expect(editor.renderer.screenBounds(id!)).toBeNull();

      editor.keyDown(key("Z", { ctrlKey: true, shiftKey: true, code: "KeyZ" }));
      expect(shapes(editor)).toEqual([id]);
      editor.keyDown(key("z", { ctrlKey: true }));
      expect(shapes(editor)).toEqual([]);
      const redo = editor.keyDown(key("y", { ctrlKey: true }));
      expect(redo).toMatchObject({ kind: "command", command: BASICS.redo });
      expect(shapes(editor)).toEqual([id]);
    });
  });

  it("previews a drag without writing, and commits it as one step", () => {
    const { editor } = make();
    const id = editor.run<string>("examples.shape/insert", {
      kind: "rect",
      x: 100,
      y: 100,
      w: 100,
      h: 100,
    });
    expect(id.ok).toBe(true);
    const shape = (id as { value: string }).value;
    const steps = editor.undo.undoStack.length;
    const updates: Uint8Array[] = [];
    editor.doc.on("update", (u: Uint8Array) => updates.push(u));

    editor.pointerDown(pointer(150, 150));
    expect(editor.selection).toEqual([shape]);
    editor.pointerMove(pointer(200, 170));
    editor.pointerMove(pointer(260, 190));
    // The renderer draws the preview; the document has not changed.
    expect(editor.scene.localPosition(shape)).toEqual({ x: 210, y: 140 });
    expect(editor.renderer.screenBounds(shape)).toMatchObject({ x: 210, y: 140 });
    expect(editor.live.localPosition(shape)).toEqual({ x: 100, y: 100 });
    expect(updates).toEqual([]);
    // Undo waits for the gesture.
    expect(editor.keyDown(key("z", { ctrlKey: true }))).toMatchObject({
      outcome: { ok: false, reason: "disabled" },
    });

    editor.pointerUp(pointer(260, 190));
    expect(editor.live.localPosition(shape)).toEqual({ x: 210, y: 140 });
    expect(editor.scene.preview.size).toBe(0);
    expect(editor.undo.undoStack.length).toBe(steps + 1);
    // One transaction for the move (and at most one for the work it records).
    expect(updates.length).toBeLessThanOrEqual(2);

    editor.keyDown(key("z", { ctrlKey: true }));
    expect(editor.live.localPosition(shape)).toEqual({ x: 100, y: 100 });
    expect(editor.renderer.screenBounds(shape)).toMatchObject({ x: 100, y: 100 });
  });

  it("cancels a drag with Escape, writing nothing", () => {
    const { editor } = make();
    const outcome = editor.run<string>("examples.shape/insert", {
      kind: "ellipse",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    const shape = (outcome as { value: string }).value;
    const before = Y.encodeStateVector(editor.doc);
    editor.pointerDown(pointer(50, 50));
    editor.pointerMove(pointer(150, 150));
    expect(editor.scene.localPosition(shape)).toEqual({ x: 100, y: 100 });
    expect(editor.keyDown(key("Escape"))).toEqual({ kind: "tool-key" });
    expect(editor.scene.localPosition(shape)).toEqual({ x: 0, y: 0 });
    editor.pointerUp(pointer(150, 150));
    expect(Y.encodeStateVector(editor.doc)).toEqual(before);
  });

  it("moves what is inside a frame with the frame's preview", () => {
    const { editor } = make();
    const frame = addElement(editor.doc, {
      type: FRAME_TYPE,
      parent: null,
      x: 300,
      y: 300,
      size: { w: 200, h: 200 },
      data: { fill: "#eeeeee" },
    });
    const inner = addElement(editor.doc, {
      type: SHAPE_TYPE,
      typeVersion: 1,
      parent: frame,
      x: 10,
      y: 10,
      size: { w: 20, h: 20 },
      data: { kind: "rect", fill: "#000000" },
    });
    expect(editor.renderer.screenBounds(inner)).toMatchObject({ x: 310, y: 310 });
    editor.services.preview.show({ [frame]: { x: 400, y: 350 } });
    expect(editor.renderer.screenBounds(inner)).toMatchObject({ x: 410, y: 360 });
    expect(editor.scene.offset(inner, null)).toEqual({ x: 410, y: 360 });
    editor.services.preview.clear();
    expect(editor.renderer.screenBounds(inner)).toMatchObject({ x: 310, y: 310 });
  });

  it("runs shortcut commands on the selection, and copy and paste through its clipboard", () => {
    const { editor } = make();
    const a = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
      }) as { value: string }
    ).value;
    editor.services.selection.set([a]);
    // Mod+C, Mod+X and Mod+V are left to the browser (no default prevented),
    // which sends copy, cut and paste events; the page passes those on.
    expect(editor.keyDown(key("c", { ctrlKey: true }))).toBeNull();
    expect(editor.keyDown(key("x", { ctrlKey: true }))).toBeNull();
    expect(editor.keyDown(key("v", { ctrlKey: true }))).toBeNull();
    expect(editor.clipboard).toBeNull();
    expect(shapes(editor)).toHaveLength(1);
    expect(editor.clipboardCopy()).toBe(true);
    expect(editor.clipboard).not.toBeNull();
    expect(editor.clipboardPaste()).toBe(true);
    expect(shapes(editor)).toHaveLength(2);
    // Paste selects what it pasted; Delete removes it.
    expect(editor.selection).not.toContain(a);
    editor.keyDown(key("Delete"));
    expect(shapes(editor)).toEqual([a]);
    expect(editor.selection).toEqual([]);
    // Ctrl+A is the basics' select all (registered first), not the sketch's.
    expect(editor.keyDown(key("a", { ctrlKey: true }))).toMatchObject({
      command: BASICS.selectAll,
    });
    expect(editor.selection).toEqual([a]);
    // Cut: copied, then deleted; paste brings a copy back.
    expect(editor.clipboardCut()).toBe(true);
    expect(shapes(editor)).toEqual([]);
    expect(editor.clipboardPaste()).toBe(true);
    expect(shapes(editor)).toHaveLength(1);
  });

  it("selects with a click and a rubber band, and draws the selection and the band", () => {
    const { editor, frames } = make();
    const ids = [0, 200, 400].map(
      (x) =>
        (
          editor.run<string>("examples.shape/insert", {
            kind: "rect",
            x,
            y: 0,
            w: 100,
            h: 100,
          }) as { value: string }
        ).value,
    );
    editor.pointerDown(pointer(250, 50));
    editor.pointerUp(pointer(250, 50));
    expect(editor.selection).toEqual([ids[1]]);
    drag(editor, { x: 150, y: 300 }, { x: 450, y: 50 });
    expect(editor.selection).toEqual([ids[1], ids[2]]);
    expect(frames.length).toBeGreaterThan(0);
    expect(() => editor.renderNow()).not.toThrow();
  });

  it("selects the outermost group a click lands in", () => {
    const { editor } = make();
    const a = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
      }) as { value: string }
    ).value;
    const b = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 100,
        y: 0,
        w: 50,
        h: 50,
      }) as { value: string }
    ).value;
    const outcome = editor.run<string>(BASICS.group, { ids: [a, b] });
    expect(outcome.ok).toBe(true);
    const group = (outcome as { value: string }).value;
    expect(editor.services.scene.elementAt({ x: 25, y: 25 }, 1)).toBe(group);
    expect(editor.services.scene.elementAt({ x: 75, y: 25 }, 1)).toBeNull();
  });

  it("drops selected elements that an undo took away", () => {
    const { editor } = make();
    const a = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
      }) as { value: string }
    ).value;
    editor.services.selection.set([a]);
    editor.keyDown(key("z", { ctrlKey: true }));
    expect(editor.selection).toEqual([]);
  });

  it("keeps the document unchanged by a tool that fails", () => {
    const { editor } = make();
    const before = toSnapshot(editor.doc);
    // A shape with a negative size is refused by the command's check.
    const outcome = editor.run("examples.shape/insert", {
      kind: "rect",
      x: 0,
      y: 0,
      w: -5,
      h: 10,
    });
    expect(outcome.ok).toBe(false);
    expect(toSnapshot(editor.doc).elements).toEqual(before.elements);
  });

  it("refuses document changes from the keyboard while a drag is open", () => {
    const { editor } = make();
    const shape = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 100,
        y: 100,
        w: 100,
        h: 100,
      }) as { value: string }
    ).value;
    const steps = editor.undo.undoStack.length;
    editor.pointerDown(pointer(150, 150));
    editor.pointerMove(pointer(250, 170));
    expect(editor.selection).toEqual([shape]);
    // Delete during the drag is refused; select all (no document change) is not.
    expect(editor.keyDown(key("Delete", { code: "Delete" }))).toMatchObject({
      command: BASICS.delete,
      outcome: { ok: false, reason: "disabled" },
    });
    expect(editor.keyDown(key("a", { ctrlKey: true }))).toMatchObject({
      outcome: { ok: true },
    });
    editor.pointerUp(pointer(250, 170));
    expect(shapes(editor)).toEqual([shape]);
    // One step: the move. Undo takes it back, and the next undo the insertion.
    expect(editor.undo.undoStack.length).toBe(steps + 1);
    editor.keyDown(key("z", { ctrlKey: true }));
    expect(editor.live.localPosition(shape)).toEqual({ x: 100, y: 100 });
    expect(shapes(editor)).toEqual([shape]);
    // After the drag, Delete works.
    editor.services.selection.set([shape]);
    editor.keyDown(key("Delete", { code: "Delete" }));
    expect(shapes(editor)).toEqual([]);
  });

  it("takes no input while input is off, and cancels a drag in progress", () => {
    const { editor } = make();
    const shape = (
      editor.run<string>("examples.shape/insert", {
        kind: "rect",
        x: 100,
        y: 100,
        w: 100,
        h: 100,
      }) as { value: string }
    ).value;
    editor.pointerDown(pointer(150, 150));
    editor.pointerMove(pointer(250, 150));
    expect(editor.scene.localPosition(shape)).toEqual({ x: 200, y: 100 });
    // The document starts closing: the drag is cancelled, nothing is written.
    editor.setInputEnabled(false);
    expect(editor.scene.preview.size).toBe(0);
    editor.pointerUp(pointer(250, 150));
    expect(editor.live.localPosition(shape)).toEqual({ x: 100, y: 100 });
    expect(editor.keyDown(key("z", { ctrlKey: true }))).toBeNull();
    expect(editor.keyDown(key("r"))).toBeNull();
    const camera = editor.camera;
    editor.pan(10, 10);
    expect(editor.camera).toEqual(camera);
    drag(editor, { x: 400, y: 400 }, { x: 500, y: 500 });
    expect(shapes(editor)).toEqual([shape]);
    editor.setInputEnabled(true);
    expect(editor.keyDown(key("z", { ctrlKey: true }))).toMatchObject({
      command: BASICS.undo,
    });
  });
});
