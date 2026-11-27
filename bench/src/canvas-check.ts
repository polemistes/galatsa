// SPDX-License-Identifier: GPL-3.0-or-later

// A page for browser tests of what the renderer hands a real canvas
// (bench/canvas-check.html): it draws small scenes with @galatsa/renderer on a
// canvas and reports pixels, so tests can check the result in each browser.
// Used by tests/e2e/bench-canvas.spec.ts; not part of the benchmark.

import type { Element } from "@galatsa/core";
import {
  defineElementView,
  defineViewExtension,
  EXTENSION_API_VERSION,
  ViewHost,
  type Label,
} from "@galatsa/extension-api";
import { CanvasRenderer, sceneFromSnapshot } from "@galatsa/renderer";

/** One element type: a rectangle outline of the stroke width in its data. */
function outlineHost(): ViewHost {
  const host = new ViewHost();
  host.load([
    defineViewExtension({
      id: "check",
      version: "0.0.0",
      api: EXTENSION_API_VERSION,
      elementTypes: [
        defineElementView<{ width: number }>({
          name: "outline",
          label: "common:check" as Label,
          typeVersion: 1,
          read: (data) => ({
            width: typeof data["width"] === "number" ? data["width"] : 1,
          }),
          draw(model, ctx, box) {
            const p = ctx.createPath();
            p.rect(0, 0, box.w, box.h);
            ctx.stroke(p, { color: "#000", width: model.width });
          },
          bounds: (model, box) => ({
            x: -model.width / 2,
            y: -model.width / 2,
            w: box.w + model.width,
            h: box.h + model.width,
          }),
        }),
      ],
    }),
  ]);
  return host;
}

function outline(width: number, w: number, h: number): Element {
  return {
    type: "check/outline",
    typeVersion: 1,
    parent: null,
    order: "a0",
    pos: { x: 0, y: 0, space: null },
    rebase: null,
    name: "",
    locked: false,
    rev: {},
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: { width },
    size: { w, h },
    rot: 0,
  };
}

/** Draws a 100 x 100 outline of stroke width `width` for a camera; returns the canvas context. */
function draw(
  width: number,
  camera: { cx: number; cy: number; zoom: number },
  size: { width: number; height: number },
): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const renderer = new CanvasRenderer({ host: outlineHost(), background: "#ffffff" });
  renderer.attach(ctx, { ...size, devicePixelRatio: 1 });
  renderer.setScene(sceneFromSnapshot({ elements: { r: outline(width, 100, 100) } }));
  renderer.setCamera({ space: null, ...camera });
  renderer.render();
  return ctx;
}

const checks = {
  /**
   * Darkness (0 white to 255 black) just outside the corner of a clipped closed
   * outline, where the join must fill the corner. 100 x 100 at zoom 400 is beyond
   * the fast path; the stroke is 4 device pixels wide; the corner is at the
   * centre (200, 150) of a 400 x 300 canvas.
   */
  cornerDarkness(): number {
    const ctx = draw(0.01, { cx: 0, cy: 0, zoom: 400 }, { width: 400, height: 300 });
    const pixel = ctx.getImageData(199, 149, 1, 1).data;
    return 255 - pixel[0]!;
  },
  /**
   * Where a stroke 2 units wide starts in the middle row, for camera positions
   * one pixel apart: its outer edge (x = -1) at the centre of a 400 x 100 canvas,
   * then moving right one pixel per step.
   */
  thickEdges(zoom: number, steps: number): number[] {
    const out: number[] = [];
    for (let step = 0; step < steps; step++) {
      const ctx = draw(
        2,
        { cx: -1 - step / zoom, cy: 50, zoom },
        { width: 400, height: 100 },
      );
      const row = ctx.getImageData(0, 50, 400, 1).data;
      let x = 0;
      while (x < 400 && row[x * 4]! >= 128) x++;
      out.push(x);
    }
    return out;
  },
};

declare global {
  interface Window {
    galatsaCanvasCheck?: typeof checks;
  }
}

window.galatsaCanvasCheck = checks;
