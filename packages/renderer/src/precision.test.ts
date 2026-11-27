// SPDX-License-Identifier: GPL-3.0-or-later

// Camera-relative precision: the canvas only ever gets screen-sized numbers, and
// a camera move of one pixel moves what is drawn by one pixel, also at deep zoom
// far from the world origin.

import { FRAME_TYPE, maxPreciseZoom, type CameraView } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import {
  box,
  ELLIPSE,
  RECT,
  RecordingContext,
  record,
  testHost,
  CIRCLE_STROKE,
} from "./test-support.ts";

const VIEW = { width: 800, height: 600, devicePixelRatio: 2 };

function setup(elements: ReturnType<typeof record>) {
  const { host } = testHost();
  const renderer = new CanvasRenderer({ host, background: "#fff" });
  const ctx = new RecordingContext();
  renderer.attach(ctx, VIEW);
  renderer.setScene(sceneFromSnapshot({ elements }));
  return { renderer, ctx };
}

/** Top-left corner of everything drawn with path calls. */
function firstMove(ctx: RecordingContext): [number, number] {
  const calls = [...ctx.named("moveTo"), ...ctx.named("lineTo")];
  if (calls.length === 0) throw new Error("nothing drawn");
  return [
    Math.min(...calls.map((c) => c.args[0] as number)),
    Math.min(...calls.map((c) => c.args[1] as number)),
  ];
}

describe("camera-relative precision", () => {
  // A frame very far from the world origin, with a small element inside.
  const far = 2 ** 52;
  const elements = record([
    ["F", box(FRAME_TYPE, far, -far, 1000, 1000)],
    ["r", box(RECT, 10, 20, 1, 1, { parent: "F" })],
  ]);
  // 1e-7 units: about 200 device pixels at zoom 2^30, so it is not clipped.
  const small = record([
    ["F", box(FRAME_TYPE, far, -far, 1000, 1000)],
    ["s", box(RECT, 10, 20, 1e-7, 1e-7, { parent: "F" })],
  ]);

  it("moves by one device pixel per pixel of camera movement at zoom 2^30 in a far frame", () => {
    const { renderer, ctx } = setup(small);
    const zoom = 2 ** 30;
    const base: CameraView = { space: "F", cx: 10 + 4e-8, cy: 20 + 4e-8, zoom };
    renderer.setCamera(base);
    renderer.render();
    const [x0, y0] = firstMove(ctx);
    for (let step = 1; step <= 5; step++) {
      ctx.calls = [];
      // Moving the camera right by `step` CSS pixels moves the content left.
      renderer.setCamera({
        ...base,
        cx: base.cx + step / zoom,
        cy: base.cy - step / zoom,
      });
      renderer.render();
      const [x, y] = firstMove(ctx);
      expect(x - x0).toBeCloseTo(-step * VIEW.devicePixelRatio, 6);
      expect(y - y0).toBeCloseTo(step * VIEW.devicePixelRatio, 6);
    }
  });

  it("puts the element where the camera says, to well under a pixel", () => {
    const { renderer, ctx } = setup(elements);
    const zoom = 2 ** 30;
    // Camera centre on the element's top-left corner: it lands mid-screen (the
    // element is far larger than the screen, so it is clipped at the corner).
    renderer.setCamera({ space: "F", cx: 10, cy: 20, zoom });
    renderer.render();
    const [x, y] = firstMove(ctx);
    expect(Math.abs(x - 800)).toBeLessThan(1 / 64);
    expect(Math.abs(y - 600)).toBeLessThan(1 / 64);
  });

  it("is exact at the root up to the precision budget", () => {
    const c = 1e6;
    const zoom = maxPreciseZoom(c, c);
    const els = record([["r", box(RECT, c, c, 1, 1)]]);
    const { renderer, ctx } = setup(els);
    renderer.setCamera({ space: null, cx: c, cy: c, zoom });
    renderer.render();
    const [x0] = firstMove(ctx);
    ctx.calls = [];
    renderer.setCamera({ space: null, cx: c + 1 / zoom, cy: c, zoom });
    renderer.render();
    const [x1] = firstMove(ctx);
    expect(Math.abs(x1 - x0 + 2)).toBeLessThan(1 / 32);
  });

  it("hands the canvas only screen-sized numbers when a shape is far larger than the screen", () => {
    const els = record([
      ["F", box(FRAME_TYPE, far, far, 10, 10)],
      ["r", box(RECT, 0, 0, 1000, 1000, { parent: "F" })],
      ["e", box(ELLIPSE, 0, 0, 1000, 1000, { parent: "F" })],
      ["c", box(CIRCLE_STROKE, 0, 0, 1000, 1000, { parent: "F", data: { width: 1e-7 } })],
    ]);
    const { renderer, ctx } = setup(els);
    // The view sits on the ellipse's outline at the right, at zoom 2^28.
    renderer.setCamera({ space: "F", cx: 1000, cy: 500, zoom: 2 ** 28 });
    renderer.render();
    const coords = ctx.coordinates();
    expect(coords.length).toBeGreaterThan(0);
    for (const v of coords) expect(Math.abs(v)).toBeLessThan(4000);
    // Something was filled and something stroked.
    expect(ctx.named("fill").length).toBeGreaterThanOrEqual(2);
    expect(ctx.named("stroke").length).toBeGreaterThanOrEqual(1);
  });

  it("flattens a huge circle so its visible part stays on the circle", () => {
    const els = record([["e", box(ELLIPSE, 0, 0, 1000, 1000)]]);
    const { renderer, ctx } = setup(els);
    const zoom = 2 ** 24;
    // Camera on the circle's rightmost point (1000, 500).
    renderer.setCamera({ space: null, cx: 1000, cy: 500, zoom });
    renderer.render();
    const s = zoom * VIEW.devicePixelRatio;
    // Device position of the circle centre (500, 500).
    const cx = (500 - 1000) * s + 800;
    const cy = 600;
    const r = 500 * s;
    const points = [...ctx.named("moveTo"), ...ctx.named("lineTo")].map(
      (c) => [c.args[0] as number, c.args[1] as number] as const,
    );
    const inView = points.filter(([x, y]) => x > 0 && x < 1600 && y > 0 && y < 1200);
    expect(inView.length).toBeGreaterThan(1);
    for (const [x, y] of inView) {
      // On the circle within the flattening tolerance plus rounding.
      expect(Math.abs(Math.hypot(x - cx, y - cy) - r)).toBeLessThan(0.5);
    }
  });

  it("follows a change of the device pixel ratio", () => {
    const els = record([["r", box(RECT, 0, 0, 10, 10)]]);
    const { renderer, ctx } = setup(els);
    renderer.setCamera({ space: null, cx: 0, cy: 0, zoom: 1 });
    renderer.render();
    expect(firstMove(ctx)).toEqual([800, 600]);
    renderer.setViewport({ ...VIEW, devicePixelRatio: 1 });
    ctx.calls = [];
    renderer.render();
    expect(firstMove(ctx)).toEqual([400, 300]);
  });
});
