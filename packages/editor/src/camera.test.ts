// SPDX-License-Identifier: GPL-3.0-or-later

// The camera controls: the point under the pointer stays where it is while
// zooming, to within a pixel, near the zoom limits and with the camera
// anchored in a frame far from the root; the camera anchors itself in the
// innermost frame around the centre of the view, and stays where it is on
// screen when that frame moves.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  MAX_ZOOM,
  MIN_ZOOM,
  PRECISION_BUDGET,
  type ElementId,
  type Point,
} from "@galatsa/core";
import { addElement, group, reparent } from "@galatsa/core/ydoc";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Editor } from "./editor.ts";
import { testEditor } from "./test-support.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function setup(): Editor {
  const { editor } = testEditor();
  editors.push(editor);
  return editor;
}

function frame(
  editor: Editor,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: ElementId | null = null,
): ElementId {
  return addElement(editor.doc, {
    type: FRAME_TYPE,
    parent,
    x,
    y,
    size: { w, h },
    data: {},
  });
}

/** Where a point of a space is on screen now (CSS pixels). */
function onScreen(editor: Editor, space: ElementId | null, p: Point): Point {
  const pr = editor.projection(space);
  return { x: p.x * pr.scale + pr.ox, y: p.y * pr.scale + pr.oy };
}

/** The point of a space under a point on screen now. */
function under(editor: Editor, space: ElementId | null, s: Point): Point {
  const pr = editor.projection(space);
  return { x: (s.x - pr.ox) / pr.scale, y: (s.y - pr.oy) / pr.scale };
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Zooms in steps about `pointer` until the zoom stops changing (or `until`
 * says so), then out the same way, and returns the largest
 * distance on screen between the pointer and the point of `space` that was
 * under it at the start (`worst`), the largest such distance over a single
 * step (`worstStep`), and the zooms reached.
 */
function zoomRun(
  editor: Editor,
  space: ElementId | null,
  pointer: Point,
  factor: number,
  until: () => boolean = () => false,
): { worst: number; worstStep: number; deepest: number; widest: number } {
  const target = under(editor, space, pointer);
  let worst = 0;
  let worstStep = 0;
  let deepest = editor.camera.zoom;
  let widest = editor.camera.zoom;
  for (const f of [factor, 1 / factor]) {
    let last = Number.NaN;
    for (let i = 0; i < 2000 && editor.camera.zoom !== last; i++) {
      last = editor.camera.zoom;
      const before = under(editor, space, pointer);
      editor.zoomAt(pointer, f);
      worst = Math.max(worst, distance(onScreen(editor, space, target), pointer));
      worstStep = Math.max(worstStep, distance(onScreen(editor, space, before), pointer));
      deepest = Math.max(deepest, editor.camera.zoom);
      widest = Math.min(widest, editor.camera.zoom);
      if (until()) return { worst, worstStep, deepest, widest };
    }
  }
  return { worst, worstStep, deepest, widest };
}

describe("zoom about the pointer", () => {
  it("keeps the point under the pointer within a pixel from the deepest zoom to the widest", () => {
    const editor = setup();
    const pointer = { x: 731.3, y: 211.7 };
    const run = zoomRun(editor, null, pointer, 1.37);
    expect(run.deepest).toBe(MAX_ZOOM);
    expect(run.widest).toBe(MIN_ZOOM);
    expect(run.worst).toBeLessThan(1);
  });

  it("stays within the zoom limits and does not drift when pushed against them", () => {
    const editor = setup();
    const pointer = { x: 123.4, y: 567.8 };
    const target = under(editor, null, pointer);
    // One large step across the limit: the zoom stops at it, the point stays.
    editor.zoomAt(pointer, 2 ** 40);
    expect(editor.camera.zoom).toBe(MAX_ZOOM);
    expect(distance(onScreen(editor, null, target), pointer)).toBeLessThan(1);
    const atLimit = editor.camera;
    for (let i = 0; i < 100; i++) editor.zoomAt(pointer, 1.5);
    expect(editor.camera).toEqual(atLimit);
    editor.zoomAt(pointer, 2 ** -80);
    expect(editor.camera.zoom).toBe(MIN_ZOOM);
    expect(distance(onScreen(editor, null, target), pointer)).toBeLessThan(1);
  });

  it("keeps the point within a pixel with the camera anchored in a frame far from the root", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, -far, 100, 80);
    editor.services.camera.set({ space: f, cx: 50, cy: 40, zoom: 1 });
    expect(editor.camera.space).toBe(f);
    const pointer = { x: 517.25, y: 402.5 };
    const run = zoomRun(editor, f, pointer, 1.29);
    // Inside the frame the full zoom range is there, far from the root.
    expect(run.deepest).toBe(MAX_ZOOM);
    expect(run.worst).toBeLessThan(1);
  });

  it("anchors in the frame while zooming in on it from the root, and keeps the point", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 100, 100);
    // At the root, beside the frame: the precision budget allows only a small
    // zoom there.
    editor.services.camera.set({ space: null, cx: far + 300, cy: far + 50, zoom: 0.01 });
    expect(editor.camera.space).toBeNull();
    // Over the frame, a little off its centre.
    const pointer = onScreen(editor, f, { x: 50.3, y: 49.1 });
    // Until the camera anchors in the frame. At the root, 2^40 from the
    // origin, the camera's centre moves in steps of 2^-12 units, so the point
    // under the pointer is only known to that much; it stays within a pixel
    // at every step.
    const first = zoomRun(editor, f, pointer, 1.21, () => editor.camera.space === f);
    expect(editor.camera.space).toBe(f);
    expect(first.worstStep).toBeLessThan(1);
    expect(first.worst).toBeLessThan(1);
    // From there on, the full range, and the point stays within a pixel.
    const run = zoomRun(editor, f, pointer, 1.21);
    expect(run.deepest).toBe(MAX_ZOOM);
    expect(run.worst).toBeLessThan(1);
    expect(run.worstStep).toBeLessThan(1);
  });

  it("limits the zoom by the precision budget at the root far from the origin", () => {
    const editor = setup();
    const far = 2 ** 40;
    editor.services.camera.set({ space: null, cx: far, cy: 0, zoom: 1 });
    editor.zoomAt({ x: 500, y: 400 }, 2 ** 30);
    expect(editor.camera.zoom).toBeLessThanOrEqual(PRECISION_BUDGET / far);
    expect(editor.camera.zoom).toBeGreaterThan((PRECISION_BUDGET / far) * 0.99);
  });

  it("fits a small frame far from the root deeper than the root's budget allows", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 1, 1);
    editor.fit({ x: far, y: far, w: 1, h: 1 }, null);
    expect(editor.camera.space).toBe(f);
    expect(editor.camera.zoom).toBeCloseTo(800 * 0.9, 6);
  });

  it("gives tools the pointer exactly in the camera's space", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 100, 100);
    const zoom = 2 ** 30;
    editor.services.camera.set({ space: f, cx: 10.25, cy: 20.5, zoom });
    const local = editor.pointerAt({ x: 600, y: 300 });
    expect(local.space).toBe(f);
    expect(local.x).toBe(10.25 + 100 / zoom);
    expect(local.y).toBe(20.5 - 100 / zoom);
  });
});

describe("pinch and pan", () => {
  it("keeps the point under two fingers between them as they move and spread", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 100, 100);
    editor.services.camera.set({ space: f, cx: 50, cy: 50, zoom: 2 ** 20 });
    const from = { x: 400, y: 300 };
    const target = under(editor, f, from);
    const to = { x: 450.5, y: 280.25 };
    editor.pinch(from, to, 3);
    expect(editor.camera.zoom).toBe(3 * 2 ** 20);
    expect(distance(onScreen(editor, f, target), to)).toBeLessThan(1);
  });

  it("pans by screen pixels at any zoom inside a far frame", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 100, 100);
    editor.services.camera.set({ space: f, cx: 50, cy: 50, zoom: 2 ** 30 });
    const p = { x: 50, y: 50 };
    const before = onScreen(editor, f, p);
    editor.pan(1, -1);
    const after = onScreen(editor, f, p);
    expect(after.x - before.x).toBeCloseTo(1, 6);
    expect(after.y - before.y).toBeCloseTo(-1, 6);
  });
});

describe("anchoring", () => {
  it("anchors in the innermost frame around the centre of the view, through groups", () => {
    const editor = setup();
    const far = 2 ** 40;
    const outer = frame(editor, far, far, 1000, 1000);
    const group = addElement(editor.doc, {
      type: GROUP_TYPE,
      parent: outer,
      x: 100,
      y: 100,
      data: {},
    });
    const inner = frame(editor, 50, 50, 200, 200, group);
    editor.services.camera.set({ space: null, cx: far + 250, cy: far + 260, zoom: 4 });
    expect(editor.camera).toEqual({ space: inner, cx: 100, cy: 110, zoom: 4 });
    // Out of the inner frame, into the outer one.
    editor.services.camera.set({ space: inner, cx: 300, cy: 110, zoom: 4 });
    expect(editor.camera).toEqual({ space: outer, cx: 450, cy: 260, zoom: 4 });
    // Out of both, at a zoom the root's budget allows.
    editor.services.camera.set({ space: outer, cx: 1500, cy: 260, zoom: 4 });
    expect(editor.camera).toEqual({
      space: null,
      cx: far + 1500,
      cy: far + 260,
      zoom: 4,
    });
  });

  it("keeps the frame's anchor out of the frame where the root's budget would not hold", () => {
    const editor = setup();
    const far = 2 ** 40;
    const f = frame(editor, far, far, 100, 100);
    editor.services.camera.set({ space: f, cx: 50, cy: 50, zoom: 2 ** 20 });
    // A long way out of the frame, still deep: precision is kept, not lost.
    editor.services.camera.set({ space: f, cx: 150.125, cy: 50, zoom: 2 ** 20 });
    expect(editor.camera).toEqual({ space: f, cx: 150.125, cy: 50, zoom: 2 ** 20 });
    // Zoomed out, the root takes over again.
    editor.zoomAt({ x: 500, y: 400 }, 2 ** -20);
    expect(editor.camera.space).toBeNull();
  });

  it("stays where it is on screen when the frame it is anchored in moves", () => {
    const editor = setup();
    const f = frame(editor, 1000, 1000, 400, 400);
    editor.services.camera.set({ space: null, cx: 1200, cy: 1200, zoom: 2 });
    expect(editor.camera.space).toBe(f);
    const rootPoint = { x: 1100, y: 1100 };
    const before = onScreen(editor, null, rootPoint);
    // A preview of a drag of the frame: the view keeps still, the frame moves.
    editor.services.preview.show({ [f]: { x: 1030, y: 990 } });
    expect(onScreen(editor, null, rootPoint)).toEqual(before);
    expect(onScreen(editor, f, { x: 0, y: 0 })).toEqual({
      x: before.x - 100 * 2 + 30 * 2,
      y: before.y - 100 * 2 - 10 * 2,
    });
    editor.services.preview.clear();
    expect(onScreen(editor, null, rootPoint)).toEqual(before);
    // The move itself, and its undo.
    expect(editor.run("galatsa.basics/move", { ids: [f], dx: -50, dy: 25 }).ok).toBe(
      true,
    );
    expect(onScreen(editor, null, rootPoint)).toEqual(before);
    editor.undo.undo();
    expect(onScreen(editor, null, rootPoint)).toEqual(before);
  });

  it("falls back to the root when the frame it is anchored in goes away", () => {
    const editor = setup();
    const f = frame(editor, 1000, 1000, 400, 400);
    editor.services.camera.set({ space: f, cx: 200, cy: 200, zoom: 2 });
    const before = onScreen(editor, null, { x: 1100, y: 1100 });
    expect(editor.run("galatsa.basics/delete", { ids: [f] }).ok).toBe(true);
    // A deleted frame is no anchor; the view stays where it was.
    editor.pan(0, 0);
    expect(editor.camera.space).toBeNull();
    expect(onScreen(editor, null, { x: 1100, y: 1100 })).toEqual(before);
  });
});

describe("the anchor's place in the tree changes", () => {
  const far = 2 ** 40;
  const P = { x: 50.123456, y: 50.654321 };

  /** Remote edits: a second document whose updates reach the editor's. */
  function remoteOf(editor: Editor): Y.Doc {
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(editor.doc));
    remote.on("update", (u: Uint8Array) => Y.applyUpdate(editor.doc, u, "remote"));
    return remote;
  }

  /** A frame 2^40 from the root, anchored in and zoomed deep. */
  function deep(zoom = 2 ** 30) {
    const editor = setup();
    const f = frame(editor, far, far, 100, 100);
    editor.services.camera.set({ space: f, cx: P.x, cy: P.y, zoom });
    expect(editor.camera.space).toBe(f);
    return { editor, f };
  }

  /** Two frames in an outer frame 2^40 from the root, anchored in the first. */
  function nested() {
    const editor = setup();
    const outer = frame(editor, far + 0.3, far + 0.7, 10000, 10000);
    const a = frame(editor, 10.3, 10.7, 100, 100, outer);
    const b = frame(editor, 5000.1, 10.9, 3000, 3000, outer);
    editor.services.camera.set({ space: a, cx: P.x, cy: P.y, zoom: 2 ** 31 });
    expect(editor.camera.space).toBe(a);
    return { editor, outer, a, b };
  }

  it("keeps the view when the anchor frame is grouped, and when that is undone", () => {
    const { editor, f } = deep();
    const other = frame(editor, far + 500, far, 10, 10);
    const before = onScreen(editor, f, P);
    expect(editor.run("galatsa.basics/group", { ids: [f, other] }).ok).toBe(true);
    expect(distance(onScreen(editor, f, P), before)).toBeLessThan(1);
    editor.undo.undo();
    expect(distance(onScreen(editor, f, P), before)).toBeLessThan(1);
    expect(editor.camera.zoom).toBe(2 ** 30);
  });

  it("keeps the view when a group around the anchor is dissolved, and when that is undone", () => {
    const editor = setup();
    const outer = frame(editor, far, far, 1000, 1000);
    const g = addElement(editor.doc, {
      type: GROUP_TYPE,
      parent: outer,
      x: 100.3,
      y: 100.7,
      data: {},
    });
    const inner = frame(editor, 50.1, 50.9, 200, 200, g);
    const p = { x: 100.123456, y: 100.654321 };
    editor.services.camera.set({ space: inner, cx: p.x, cy: p.y, zoom: 2 ** 32 });
    const before = onScreen(editor, inner, p);
    expect(editor.run("galatsa.basics/ungroup", { ids: [g] }).ok).toBe(true);
    expect(distance(onScreen(editor, inner, p), before)).toBeLessThan(1);
    editor.undo.undo();
    expect(distance(onScreen(editor, inner, p), before)).toBeLessThan(1);
  });

  it("keeps the view when the anchor frame is moved into another frame", () => {
    const { editor, a, b } = nested();
    const before = onScreen(editor, a, P);
    expect(editor.run("galatsa.basics/reparent", { ids: [a], target: b }).ok).toBe(true);
    expect(distance(onScreen(editor, a, P), before)).toBeLessThan(1);
  });

  it("keeps the view when someone else moves the anchor frame into another frame", () => {
    const { editor, a, b } = nested();
    const remote = remoteOf(editor);
    const before = onScreen(editor, a, P);
    reparent(remote, a, b);
    expect(editor.live.parentOf(a)).toBe(b);
    expect(distance(onScreen(editor, a, P), before)).toBeLessThan(1);
  });

  it("keeps the view when someone else groups the anchor frame", () => {
    const { editor, a } = nested();
    const remote = remoteOf(editor);
    const before = onScreen(editor, a, P);
    group(remote, [a]);
    expect(editor.live.parentOf(a)).not.toBe(null);
    expect(distance(onScreen(editor, a, P), before)).toBeLessThan(1);
  });

  it("keeps the zoom and the view when the anchor frame is deleted far out, and after undo", () => {
    const { editor, f } = deep();
    const before = onScreen(editor, f, P);
    expect(editor.run("galatsa.basics/delete", { ids: [f] }).ok).toBe(true);
    expect(editor.camera.zoom).toBe(2 ** 30);
    expect(distance(onScreen(editor, f, P), before)).toBeLessThan(1);
    editor.undo.undo();
    expect(editor.camera.zoom).toBe(2 ** 30);
    expect(distance(onScreen(editor, f, P), before)).toBeLessThan(1);
  });

  it("keeps the zoom when the anchor frame is moved very far, and the view after undo", () => {
    const { editor, f } = deep();
    const before = onScreen(editor, f, P);
    expect(editor.run("galatsa.basics/move", { ids: [f], dx: -far, dy: -far }).ok).toBe(
      true,
    );
    expect(editor.camera.zoom).toBe(2 ** 30);
    editor.undo.undo();
    expect(editor.camera.zoom).toBe(2 ** 30);
    expect(distance(onScreen(editor, f, P), before)).toBeLessThan(1);
  });
});
