// SPDX-License-Identifier: GPL-3.0-or-later

// Strokes beyond the fast path: clipped closed outlines keep their corners,
// strokes wider than the screen become filled outlines with only screen-sized
// numbers, dash phases stay small, and the slow path follows Canvas 2D after
// closePath.

import {
  defineElementView,
  defineViewExtension,
  EXTENSION_API_VERSION,
  ViewHost,
  type Label,
} from "@galatsa/extension-api";
import { describe, expect, it } from "vitest";
import { dashPattern, flatten, RecordedPath, THICK_STROKE_PX } from "./path.ts";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, RecordingContext, record, type Call } from "./test-support.ts";

const VIEW = { width: 800, height: 600, devicePixelRatio: 1 };
const OUTLINE = "outline/rect";

/** A host with one type: a rectangle outline of a given stroke width (and dashes). */
function outlineHost(): ViewHost {
  const host = new ViewHost();
  const problems = host.load([
    defineViewExtension({
      id: "outline",
      version: "0.0.0",
      api: EXTENSION_API_VERSION,
      elementTypes: [
        defineElementView<{
          width: number;
          dash: number[] | undefined;
          join: "miter" | "round" | "bevel";
        }>({
          name: "rect",
          label: "common:test" as Label,
          typeVersion: 1,
          read: (data) => ({
            width: typeof data["width"] === "number" ? data["width"] : 1,
            dash: Array.isArray(data["dash"]) ? (data["dash"] as number[]) : undefined,
            join:
              data["join"] === "round" || data["join"] === "bevel"
                ? data["join"]
                : "miter",
          }),
          draw(model, ctx, b) {
            const p = ctx.createPath();
            p.rect(0, 0, b.w, b.h);
            ctx.stroke(p, {
              color: "#000",
              width: model.width,
              join: model.join,
              ...(model.dash ? { dash: model.dash } : {}),
            });
          },
          bounds: (model, b) => ({
            x: -model.width / 2,
            y: -model.width / 2,
            w: b.w + model.width,
            h: b.h + model.width,
          }),
        }),
      ],
    }),
  ]);
  if (problems.length) throw new Error(JSON.stringify(problems));
  return host;
}

function setup(data: Record<string, unknown>, w = 100, h = 100) {
  const renderer = new CanvasRenderer({ host: outlineHost(), background: "#fff" });
  const ctx = new RecordingContext();
  renderer.attach(ctx, VIEW);
  renderer.setScene(
    sceneFromSnapshot({
      elements: record([["r", box(OUTLINE, 0, 0, w, h, { data: data as never })]]),
    }),
  );
  return { renderer, ctx };
}

/** The path calls since the last background fill, as short strings. */
function pathCalls(calls: readonly Call[]): string[] {
  return calls
    .filter((c) =>
      ["beginPath", "moveTo", "lineTo", "closePath", "stroke"].includes(c.name),
    )
    .map((c) => `${c.name}(${c.args.map((a) => Math.round(a as number)).join(",")})`);
}

describe("clipped closed strokes", () => {
  it("keep the join at a corner that is in view", () => {
    // 100 x 100 at zoom 400 is 40,000 device pixels: beyond the fast path. The
    // view is on the top-left corner, which lands at the screen centre (400, 300).
    const { renderer, ctx } = setup({ width: 2 });
    renderer.setCamera({ space: null, cx: 0, cy: 0, zoom: 400 });
    renderer.render();
    const path = pathCalls(ctx.calls);
    // The corner is reached by a lineTo and left by the next lineTo in the same
    // subpath, so the canvas joins the two sides there.
    const at = path.indexOf("lineTo(400,300)");
    expect(at).toBeGreaterThan(0);
    expect(path[at + 1]).toMatch(/^lineTo/);
    expect(path).not.toContain("moveTo(400,300)");
  });

  it("keep the dash phase, reduced to one pattern length", () => {
    const { renderer, ctx } = setup({ width: 1e-6, dash: [1e-6, 2e-6] }, 1000, 1000);
    // The bottom edge near the right end, at zoom 2^30: the path before the
    // view is about 2^40 device pixels long.
    renderer.setCamera({ space: null, cx: 900, cy: 1000, zoom: 2 ** 30 });
    renderer.render();
    const offsets = ctx.named("set lineDashOffset").map((c) => c.args[0] as number);
    expect(offsets.length).toBeGreaterThan(0);
    // Pattern of 1 + 2 units at 2^30 pixels per unit, times 1e-6: about 3,221 px.
    const period = 3e-6 * 2 ** 30;
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(period + 1e-6);
    }
  });
});

describe("strokes wider than the screen", () => {
  it("reach the canvas as filled outlines with screen-sized numbers", () => {
    // Stroke width 2 units at zoom 2^24: 33 million device pixels.
    const { renderer, ctx } = setup({ width: 2 });
    renderer.setCamera({ space: null, cx: -1, cy: 50, zoom: 2 ** 24 });
    renderer.render();
    const widths = ctx.named("set lineWidth").map((c) => c.args[0] as number);
    expect(Math.max(0, ...widths)).toBeLessThanOrEqual(THICK_STROKE_PX);
    const coords = [...ctx.named("moveTo"), ...ctx.named("lineTo")].flatMap(
      (c) => c.args as number[],
    );
    expect(coords.length).toBeGreaterThan(0);
    for (const v of coords) expect(Math.abs(v)).toBeLessThan(1000);
    expect(ctx.named("stroke")).toHaveLength(0);
    expect(ctx.named("fill").length).toBeGreaterThan(0);
  });

  it("put the band's edge one device pixel further for each pixel the camera moves", () => {
    // The outer edge of the left side is at x = -1. Find where the filled polygon
    // starts in the middle row for several camera positions one pixel apart.
    const zoom = 2 ** 24;
    const edges: number[] = [];
    for (let step = 0; step < 6; step++) {
      const { renderer, ctx } = setup({ width: 2 });
      renderer.setCamera({ space: null, cx: -1 - step / zoom, cy: 50, zoom });
      renderer.render();
      const xs = [...ctx.named("moveTo"), ...ctx.named("lineTo")].map(
        (c) => c.args[0] as number,
      );
      edges.push(Math.min(...xs.filter((x) => x > -2)));
    }
    for (let step = 1; step < 6; step++)
      expect(edges[step]! - edges[0]!).toBeCloseTo(step, 6);
  });

  it("draw round joins and dashes the same way", () => {
    const { renderer, ctx } = setup({ width: 2, join: "round", dash: [3, 1] });
    renderer.setCamera({ space: null, cx: 0, cy: 0, zoom: 2 ** 20 });
    renderer.render();
    const coords = [...ctx.named("moveTo"), ...ctx.named("lineTo")].flatMap(
      (c) => c.args as number[],
    );
    expect(coords.length).toBeGreaterThan(0);
    for (const v of coords) expect(Math.abs(v)).toBeLessThan(1000);
  });
});

describe("dash patterns", () => {
  it("repeat an odd list once, as Canvas 2D does", () => {
    expect(dashPattern([1, 2, 3])).toEqual([1, 2, 3, 1, 2, 3]);
    expect(dashPattern([0, 0])).toBeNull();
    expect(dashPattern([])).toBeNull();
  });
});

describe("the slow path after closePath", () => {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const clip = [-100, -100, 100, 100];

  it("starts a lineTo after closePath at the subpath's start", () => {
    const p = new RecordedPath();
    p.moveTo(0, 0);
    p.lineTo(10, 0);
    p.lineTo(10, 10);
    p.closePath();
    p.lineTo(0, 10); // Canvas 2D: a segment from (0, 0) to (0, 10).
    const polys = flatten(p, identity, clip);
    expect(polys[0]).toEqual({ points: [0, 0, 10, 0, 10, 10], closed: true });
    expect(polys[1]?.points).toEqual([0, 0, 0, 10]);
  });

  it("starts a curve after a rectangle at the rectangle's corner", () => {
    const p = new RecordedPath();
    p.rect(5, 5, 10, 10);
    p.bezierCurveTo(5, 20, 5, 20, 5, 30);
    const polys = flatten(p, identity, clip);
    expect(polys[1]?.points.slice(0, 2)).toEqual([5, 5]);
    expect(polys[1]?.points.slice(-2)).toEqual([5, 30]);
  });

  it("starts a first curve without a current point at its control point", () => {
    const p = new RecordedPath();
    p.quadraticCurveTo(3, 4, 10, 10);
    const polys = flatten(p, identity, clip);
    expect(polys[0]?.points.slice(0, 2)).toEqual([3, 4]);
  });
});
