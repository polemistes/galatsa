// SPDX-License-Identifier: GPL-3.0-or-later

// The overlay in screen space: tools draw in a document space through a
// projection, and the projection stays exact under a camera anchored in a
// frame far from the root.

import { FRAME_TYPE } from "@galatsa/core";
import { addElement } from "@galatsa/core/ydoc";
import type { DrawContext, Path } from "@galatsa/extension-api/editing";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "./editor.ts";
import { projectedContext } from "./overlay.ts";
import { testEditor } from "./test-support.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

/** A screen-space context that records what is drawn. */
function recordingScreen(scale = 2) {
  const calls: Array<[string, ...unknown[]]> = [];
  const path = (): Path => {
    const p = {} as Record<string, unknown>;
    for (const name of [
      "moveTo",
      "lineTo",
      "quadraticCurveTo",
      "bezierCurveTo",
      "arc",
      "ellipse",
      "rect",
      "roundRect",
      "closePath",
    ])
      p[name] = (...args: unknown[]) => calls.push([name, ...args]);
    return p as unknown as Path;
  };
  const ctx: DrawContext = {
    scale,
    detail: "full",
    createPath: path,
    fill: (_p, color) => calls.push(["fill", color]),
    stroke: (_p, style) => calls.push(["stroke", style.width, style.dash ?? null]),
    withOpacity: (_a, draw) => draw(),
    withClip: (_p, draw) => draw(),
    withOffset: (_x, _y, draw) => draw(),
    drawImage: (_asset, dest) => {
      calls.push(["drawImage", dest]);
      return "drawn";
    },
    layoutText: () => ({ width: 10, height: 10, lineCount: 1 }),
    drawText: (_l, x, y) => calls.push(["drawText", x, y]),
    t: (label) => label,
  };
  return { ctx, calls };
}

describe("projectedContext", () => {
  it("projects paths, widths, dashes and offsets from a document space to the screen", () => {
    const { ctx, calls } = recordingScreen(2);
    const projected = projectedContext(ctx, { space: null, scale: 4, ox: 10, oy: 20 });
    // Device pixels per document unit, as tools expect.
    expect(projected.scale).toBe(8);
    projected.withOffset(1, 2, () => {
      const p = projected.createPath();
      p.rect(0, 0, 3, 5);
      projected.stroke(p, { color: "#000", width: 0.5, dash: [1, 2] });
    });
    const p = projected.createPath();
    p.moveTo(1, 1);
    p.arc(0, 0, 2, 0, Math.PI);
    projected.fill(p, "#fff");
    expect(calls).toEqual([
      ["rect", 14, 28, 12, 20],
      ["stroke", 2, [4, 8]],
      ["moveTo", 14, 24],
      ["arc", 10, 20, 8, 0, Math.PI, undefined],
      ["fill", "#fff"],
    ]);
  });
});

describe("the editor's projection", () => {
  it("maps root space to the screen through the camera", () => {
    const { editor } = testEditor();
    editors.push(editor);
    // testEditor: 1000 x 800, camera at (500, 400), zoom 1.
    expect(editor.projection(null)).toEqual({ space: null, scale: 1, ox: 0, oy: 0 });
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 2 });
    expect(editor.projection(null)).toEqual({ space: null, scale: 2, ox: 500, oy: 400 });
  });

  it("stays exact under a camera anchored in a frame far from the root", () => {
    const { editor } = testEditor();
    editors.push(editor);
    const far = 2 ** 40;
    const frame = addElement(editor.doc, {
      type: FRAME_TYPE,
      parent: null,
      x: far,
      y: far,
      size: { w: 100, h: 100 },
      data: {},
    });
    const zoom = 2 ** 30;
    editor.services.camera.set({ space: frame, cx: 10.25, cy: 20.5, zoom });
    // The frame's origin on screen, computed in the frame's own space.
    const p = editor.projection(frame);
    expect(p.scale).toBe(zoom);
    expect(p.ox).toBe(-10.25 * zoom + 500);
    expect(p.oy).toBe(-20.5 * zoom + 400);
  });
});
