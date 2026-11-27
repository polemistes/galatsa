// SPDX-License-Identifier: GPL-3.0-or-later

// Navigation from the keyboard and with the hand: zoom in and out with
// Ctrl/Cmd and plus or minus on Norwegian and US keyboards, actual size, show
// everything, show the selection, the arrow keys, and Space with a drag.

import { FRAME_TYPE, MAX_ZOOM, type Rect } from "@galatsa/core";
import { SHAPE_TYPE } from "@galatsa/extension-examples";
import { addElement } from "@galatsa/core/ydoc";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "./editor.ts";
import { wheelPixels, wheelZoomFactor } from "./dom.ts";
import { NAVIGATION } from "./navigation.ts";
import { key, pointer, testEditor } from "./test-support.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function setup(): Editor {
  const { editor } = testEditor();
  editors.push(editor);
  return editor;
}

function shape(editor: Editor, x: number, y: number, w: number, h: number): string {
  return addElement(editor.doc, {
    type: SHAPE_TYPE,
    parent: null,
    x,
    y,
    size: { w, h },
    data: {},
  });
}

/** The rectangle of root space on screen now. */
function onScreen(editor: Editor, r: Rect): Rect {
  const p = editor.projection(null);
  return {
    x: r.x * p.scale + p.ox,
    y: r.y * p.scale + p.oy,
    w: r.w * p.scale,
    h: r.h * p.scale,
  };
}

describe("navigation from the keyboard", () => {
  it("zooms in with Ctrl and plus on a Norwegian keyboard and Ctrl and = on a US one", () => {
    const editor = setup();
    // Norwegian: the + key is where - is on a US keyboard.
    const plusNo = editor.keyDown(key("+", { ctrlKey: true, code: "Minus" }));
    expect(plusNo).toMatchObject({ kind: "command", command: NAVIGATION.zoomIn });
    expect(editor.camera).toEqual({ space: null, cx: 500, cy: 400, zoom: 2 });
    editor.keyDown(key("=", { ctrlKey: true, code: "Equal" }));
    expect(editor.camera.zoom).toBe(4);
    // US, with Shift: Ctrl and Shift and = give "+".
    editor.keyDown(key("+", { ctrlKey: true, shiftKey: true, code: "Equal" }));
    expect(editor.camera.zoom).toBe(8);
    // The numeric keypad.
    editor.keyDown(key("+", { ctrlKey: true, code: "NumpadAdd" }));
    expect(editor.camera.zoom).toBe(16);
  });

  it("zooms out with Ctrl and minus on both keyboards, and back to actual size with Ctrl+0", () => {
    const editor = setup();
    // Norwegian: - is right of the full stop (US /).
    const minus = editor.keyDown(key("-", { ctrlKey: true, code: "Slash" }));
    expect(minus).toMatchObject({ kind: "command", command: NAVIGATION.zoomOut });
    expect(editor.camera.zoom).toBe(0.5);
    editor.keyDown(key("-", { ctrlKey: true, code: "Minus" }));
    expect(editor.camera.zoom).toBe(0.25);
    editor.keyDown(key("0", { ctrlKey: true, code: "Digit0" }));
    expect(editor.camera).toEqual({ space: null, cx: 500, cy: 400, zoom: 1 });
  });

  it("uses Cmd on macOS", () => {
    const { editor } = testEditor({ platform: { mac: true } });
    editors.push(editor);
    editor.keyDown(key("+", { metaKey: true, code: "Minus" }));
    expect(editor.camera.zoom).toBe(2);
  });

  it("stops at the zoom limit", () => {
    const editor = setup();
    for (let i = 0; i < 80; i++)
      editor.keyDown(key("+", { ctrlKey: true, code: "Minus" }));
    expect(editor.camera.zoom).toBe(MAX_ZOOM);
  });

  it("shows everything with Shift+1, and the selection with Shift+2", () => {
    const editor = setup();
    const a = shape(editor, 3000, 2000, 100, 50);
    shape(editor, 5000, 2600, 400, 400);
    // Shift+1 gives ! on both keyboards: found by place.
    const all = editor.keyDown(key("!", { shiftKey: true, code: "Digit1" }));
    expect(all).toMatchObject({ kind: "command", command: NAVIGATION.viewAll });
    const both = onScreen(editor, { x: 3000, y: 2000, w: 2400, h: 1000 });
    // It fills the width (the wider side), within the margin, centred.
    expect(both.x).toBeGreaterThan(0);
    expect(both.x + both.w).toBeLessThan(1000);
    expect(both.w).toBeGreaterThan(850);
    expect(both.x + both.w / 2).toBeCloseTo(500, 6);
    expect(both.y + both.h / 2).toBeCloseTo(400, 6);

    // Nothing selected: Shift+2 does nothing (and is still taken from the browser).
    const before = editor.camera;
    const none = editor.keyDown(key('"', { shiftKey: true, code: "Digit2" }));
    expect(none).toMatchObject({
      command: NAVIGATION.viewSelection,
      outcome: { ok: false },
    });
    expect(editor.camera).toEqual(before);

    editor.services.selection.set([a]);
    editor.keyDown(key('"', { shiftKey: true, code: "Digit2" }));
    const one = onScreen(editor, { x: 3000, y: 2000, w: 100, h: 50 });
    expect(one.w).toBeGreaterThan(850);
    expect(one.x + one.w / 2).toBeCloseTo(500, 6);
    expect(one.y + one.h / 2).toBeCloseTo(400, 6);
  });

  it("shows a selection deep in a frame far from the root precisely", () => {
    const editor = setup();
    const far = 2 ** 40;
    const frame = addElement(editor.doc, {
      type: FRAME_TYPE,
      parent: null,
      x: far,
      y: far,
      size: { w: 100, h: 100 },
      data: {},
    });
    const tiny = addElement(editor.doc, {
      type: SHAPE_TYPE,
      parent: frame,
      x: 10.5,
      y: 20.25,
      size: { w: 2 ** -20, h: 2 ** -21 },
      data: {},
    });
    editor.services.selection.set([tiny]);
    expect(editor.run(NAVIGATION.viewSelection).ok).toBe(true);
    expect(editor.camera.space).toBe(frame);
    const p = editor.projection(frame);
    const left = 10.5 * p.scale + p.ox;
    const right = (10.5 + 2 ** -20) * p.scale + p.ox;
    expect((left + right) / 2).toBeCloseTo(500, 3);
    expect(right - left).toBeGreaterThan(850);
  });

  it("centres an element without size at the zoom it has, instead of zooming all the way in", () => {
    const editor = setup();
    const point = addElement(editor.doc, {
      type: FRAME_TYPE,
      parent: null,
      x: 10,
      y: 20,
      size: { w: 0, h: 0 },
      data: {},
    });
    editor.services.camera.set({ space: null, cx: 500, cy: 400, zoom: 3 });
    editor.services.selection.set([point]);
    expect(editor.run(NAVIGATION.viewSelection).ok).toBe(true);
    expect(editor.camera.zoom).toBe(3);
    const p = editor.projection(null);
    expect(10 * p.scale + p.ox).toBeCloseTo(500, 6);
    expect(20 * p.scale + p.oy).toBeCloseTo(400, 6);
    expect(editor.run(NAVIGATION.viewAll).ok).toBe(true);
    expect(editor.camera.zoom).toBe(3);
  });

  it("pans with the arrow keys", () => {
    const editor = setup();
    editor.keyDown(key("ArrowRight", { code: "ArrowRight" }));
    expect(editor.camera.cx).toBeGreaterThan(500);
    expect(editor.camera.cy).toBe(400);
    editor.keyDown(key("ArrowLeft", { code: "ArrowLeft" }));
    expect(editor.camera.cx).toBe(500);
    editor.keyDown(key("ArrowDown", { code: "ArrowDown" }));
    expect(editor.camera.cy).toBeGreaterThan(400);
    editor.keyDown(key("ArrowUp", { code: "ArrowUp" }));
    expect(editor.camera.cy).toBe(400);
  });
});

describe("two fingers", () => {
  it("take back what the first finger's press did when the second comes", () => {
    const editor = setup();
    const id = shape(editor, 100, 100, 200, 200);
    editor.pointerDown(pointer(150, 150, { pointerType: "touch" }));
    expect(editor.selection).toEqual([id]);
    editor.pointerWithdraw();
    expect(editor.selection).toEqual([]);
    expect(editor.services.scene.placement(id)).toMatchObject({ x: 100, y: 100 });
    // The next press is the tool's as before.
    editor.pointerDown(pointer(150, 150, { pointerType: "touch" }));
    editor.pointerUp(pointer(150, 150, { pointerType: "touch" }));
    expect(editor.selection).toEqual([id]);
  });

  it("take back a document change the first finger's press made, with its undo step", () => {
    const editor = setup();
    const kept = shape(editor, 600, 600, 10, 10);
    // An earlier step of the user's own, which must survive.
    expect(editor.run("galatsa.basics/move", { ids: [kept], dx: 5, dy: 0 }).ok).toBe(
      true,
    );
    const steps = editor.undo.undoStack.length;
    const count = () =>
      [...editor.live.ids()].filter((i) => !editor.live.isGone(i)).length;
    const before = count();
    // The text sketch inserts a text box as soon as the finger goes down.
    expect(editor.tools.select("examples.text/text")).toBe(true);
    editor.pointerDown(pointer(300, 300, { pointerType: "touch" }));
    expect(count()).toBe(before + 1);
    editor.pointerWithdraw();
    expect(count()).toBe(before);
    expect(editor.undo.undoStack.length).toBe(steps);
    // Nothing to redo either: the press never happened.
    expect(editor.undo.redoStack.length).toBe(0);
    // The tool picked before the press is back.
    expect(editor.tools.current).toBe("examples.text/text");
    expect(editor.services.scene.placement(kept)).toMatchObject({ x: 605, y: 600 });
  });
});

describe("the wheel", () => {
  it("zooms by the same step for a notch of every browser's mouse wheel, and finely for a pinch", () => {
    // Chromium: 100 pixels a notch; Firefox: 3 lines of 16 pixels.
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.25), 12);
    expect(wheelZoomFactor(-48)).toBeCloseTo(Math.exp(0.25), 12);
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-0.25), 12);
    // A trackpad pinch: small steps, as they come.
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04), 12);
  });

  it("reads pixels, lines and pages, a page across being the canvas's width", () => {
    expect(wheelPixels({ deltaX: 3, deltaY: -5, deltaMode: 0 }, 1000, 800)).toEqual({
      dx: 3,
      dy: -5,
    });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 1000, 800)).toEqual({
      dx: 16,
      dy: 48,
    });
    expect(wheelPixels({ deltaX: 1, deltaY: -1, deltaMode: 2 }, 1000, 800)).toEqual({
      dx: 1000,
      dy: -800,
    });
  });
});

describe("Space and a drag", () => {
  it("drags the canvas instead of using the tool while Space is held", () => {
    const editor = setup();
    const id = shape(editor, 100, 100, 200, 200);
    expect(editor.keyDown(key(" ", { code: "Space" }))).toEqual({ kind: "hand" });
    expect(editor.cursor).toBe("grab");
    editor.pointerDown(pointer(150, 150));
    expect(editor.cursor).toBe("grabbing");
    editor.pointerMove(pointer(170, 140));
    editor.pointerUp(pointer(190, 130));
    // The canvas followed the pointer; the shape was neither selected nor moved.
    expect(editor.camera).toEqual({ space: null, cx: 460, cy: 420, zoom: 1 });
    expect(editor.selection).toEqual([]);
    expect(editor.services.scene.placement(id)).toMatchObject({ x: 100, y: 100 });
    expect(editor.keyUp(key(" ", { code: "Space" }))).toBe(true);
    expect(editor.cursor).toBe("default");
    // Without Space, the tool has the pointer again.
    editor.pointerDown(pointer(150, 150));
    editor.pointerUp(pointer(150, 150));
    expect(editor.selection).toEqual([id]);
  });

  it("lets go when Space is released with a modifier held", () => {
    const editor = setup();
    const id = shape(editor, 100, 100, 200, 200);
    editor.keyDown(key(" ", { code: "Space" }));
    expect(editor.keyUp(key(" ", { code: "Space", shiftKey: true }))).toBe(true);
    expect(editor.cursor).toBe("default");
    const before = editor.camera;
    editor.pointerDown(pointer(150, 150));
    editor.pointerUp(pointer(150, 150));
    expect(editor.camera).toEqual(before);
    expect(editor.selection).toEqual([id]);
  });

  it("lets go of a finger that a pinch takes over", () => {
    const editor = setup();
    editor.keyDown(key(" ", { code: "Space" }));
    editor.pointerDown(pointer(100, 100, { pointerType: "touch" }));
    expect(editor.cursor).toBe("grabbing");
    // The second finger: the pinch has the camera now.
    editor.pointerWithdraw();
    editor.keyUp(key(" ", { code: "Space" }));
    expect(editor.cursor).toBe("default");
    // A mouse moving afterwards does not drag the canvas.
    const before = editor.camera;
    editor.pointerMove(pointer(400, 400));
    editor.pointerMove(pointer(450, 420));
    expect(editor.camera).toEqual(before);
  });

  it("does not take Space from a drag in progress", () => {
    const editor = setup();
    shape(editor, 100, 100, 200, 200);
    editor.pointerDown(pointer(150, 150));
    editor.pointerMove(pointer(160, 150));
    expect(editor.keyDown(key(" ", { code: "Space" }))).toBeNull();
    editor.pointerUp(pointer(170, 150));
  });
});
