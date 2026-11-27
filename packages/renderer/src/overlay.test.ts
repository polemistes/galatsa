// SPDX-License-Identifier: GPL-3.0-or-later

// The overlay: drawn above the document in root space, and a failing overlay
// does not break the frame.

import { describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, RECT, RecordingContext, record, testHost } from "./test-support.ts";

const VIEW = { width: 800, height: 600, devicePixelRatio: 2 };

function setup() {
  const { host } = testHost();
  const renderer = new CanvasRenderer({ host, background: "#fff" });
  const ctx = new RecordingContext();
  renderer.attach(ctx, VIEW);
  renderer.setScene(
    sceneFromSnapshot({ elements: record([["a", box(RECT, 0, 0, 10, 10)]]) }),
  );
  renderer.setCamera({ space: null, cx: 100, cy: 50, zoom: 4 });
  return { renderer, ctx };
}

describe("overlay", () => {
  it("draws after the document, in root space, with the device scale", () => {
    const { renderer, ctx } = setup();
    let scale = 0;
    renderer.setOverlay((dc) => {
      scale = dc.scale;
      const path = dc.createPath();
      path.rect(100, 50, 1, 1);
      dc.fill(path, "#123456");
    });
    renderer.render();
    expect(scale).toBe(8);
    const fills = ctx.calls.filter((c) => c.name === "set fillStyle");
    expect(fills[fills.length - 1]?.args[0]).toBe("#123456");
    // The camera centre (100, 50) is the middle of the canvas: 800 x 600 device pixels.
    const moves = ctx.calls.filter((c) => c.name === "rect" || c.name === "moveTo");
    const last = moves[moves.length - 1]!;
    expect(last.args.slice(0, 2)).toEqual([800, 600]);
  });

  // renderRegion needs a real canvas (OffscreenCanvas), which Node has not; it
  // never passes the overlay to the frame it draws (renderer.ts).
  it("is left out after setOverlay(null)", () => {
    const { renderer } = setup();
    const overlay = vi.fn();
    renderer.setOverlay(overlay);
    renderer.render();
    expect(overlay).toHaveBeenCalledTimes(1);
    renderer.setOverlay(null);
    renderer.render();
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("keeps drawing frames when the overlay throws", () => {
    const { renderer } = setup();
    renderer.setOverlay(() => {
      throw new Error("broken tool");
    });
    const frames = renderer.stats.frames;
    expect(() => renderer.render()).not.toThrow();
    expect(renderer.stats.frames).toBe(frames + 1);
    expect(renderer.stats.elementsDrawn).toBe(1);
  });
});
