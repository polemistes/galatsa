// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import {
  type CameraPose,
  createCameraRun,
  flightPath,
  HOLD_FRAMES,
  MAX_ZOOM,
  MIN_ZOOM,
  REFERENCE_VIEWPORT,
  STOP_COUNT,
} from "./camera.ts";
import { hashString } from "./prng.ts";
import { generateScene } from "./scene.ts";

// Pinned hash of the default run, with poses rounded to 9 significant digits, so
// that last-bit differences between JavaScript engines do not change it.
const DEFAULT_RUN_HASH = "ff1b76c9";

const scene = generateScene();
const run = createCameraRun(scene);

function rounded(poses: readonly CameraPose[]): string {
  return poses
    .map((p) => `${p.x.toPrecision(9)},${p.y.toPrecision(9)},${p.zoom.toPrecision(9)}`)
    .join(";");
}

describe("createCameraRun", () => {
  it("is the same every time, and matches the pinned hash", () => {
    expect(createCameraRun(generateScene())).toEqual(run);
    expect(hashString(rounded(run.poses))).toBe(DEFAULT_RUN_HASH);
  });

  it("does not use Math.random", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random was called");
    });
    createCameraRun(scene);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("has consecutive segments that cover every frame", () => {
    let next = 0;
    for (const segment of run.segments) {
      expect(segment.start).toBe(next);
      expect(segment.end).toBeGreaterThan(segment.start);
      next = segment.end;
    }
    expect(next).toBe(run.poses.length);
    expect(run.poses.length).toBe(2775);
  });

  it("zooms from 0.02 to 20 and back, and pans, and visits ten stops", () => {
    const zooms = run.poses.map((p) => p.zoom);
    expect(Math.min(...zooms)).toBe(MIN_ZOOM);
    expect(Math.max(...zooms)).toBe(MAX_ZOOM);
    const kinds = run.segments.map((s) => s.kind);
    expect(kinds.filter((k) => k === "zoom-in")).toHaveLength(1);
    expect(kinds.filter((k) => k === "zoom-out")).toHaveLength(1);
    expect(kinds.filter((k) => k === "pan")).toHaveLength(1);
    expect(run.stops).toHaveLength(STOP_COUNT);
    const stopHolds = run.segments.filter((s) => s.label.startsWith("at stop"));
    expect(stopHolds).toHaveLength(STOP_COUNT);
    stopHolds.forEach((hold, i) => {
      expect(run.poses[hold.start]).toEqual(run.stops[i]);
    });
  });

  it("pans across the whole scene", () => {
    const pan = run.segments.find((s) => s.kind === "pan")!;
    const first = run.poses[pan.start]!;
    const last = run.poses[pan.end - 1]!;
    expect(first.x).toBeLessThan(scene.bounds.x + 100);
    expect(last.x).toBe(scene.bounds.x + scene.bounds.width);
  });

  it("stands still during holds", () => {
    for (const hold of run.segments.filter((s) => s.kind === "hold")) {
      expect(hold.end - hold.start).toBe(HOLD_FRAMES);
      for (let i = hold.start; i < hold.end; i++) {
        expect(run.poses[i]).toEqual(run.poses[hold.start]);
      }
    }
  });

  it("moves smoothly: no frame jumps by more than a few viewports or a large zoom step", () => {
    for (let i = 1; i < run.poses.length; i++) {
      const a = run.poses[i - 1]!;
      const b = run.poses[i]!;
      const zoomStep = Math.abs(Math.log(b.zoom / a.zoom));
      expect(zoomStep, `frame ${i}`).toBeLessThan(0.1);
      // Movement in screen pixels at the smaller zoom of the two frames.
      const screen = Math.hypot(b.x - a.x, b.y - a.y) * Math.min(a.zoom, b.zoom);
      expect(screen, `frame ${i}`).toBeLessThan(REFERENCE_VIEWPORT.width);
    }
  });
});

describe("flightPath", () => {
  const from: CameraPose = { x: 0, y: 0, zoom: 1 };
  const to: CameraPose = { x: 50000, y: 10000, zoom: 2 };

  it("starts and ends at the given poses", () => {
    const path = flightPath(from, to);
    expect(path(0)).toEqual(from);
    expect(path(1)).toEqual(to);
  });

  it("zooms out in the middle of a long flight and moves monotonically", () => {
    const path = flightPath(from, to);
    let lastX = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const p = path(i / 100);
      expect(p.x).toBeGreaterThanOrEqual(lastX);
      lastX = p.x;
    }
    expect(path(0.5).zoom).toBeLessThan(0.1);
  });

  it("is continuous at the ends", () => {
    const path = flightPath(from, to);
    const start = path(1e-9);
    const end = path(1 - 1e-9);
    expect(start.x).toBeCloseTo(from.x, 3);
    expect(start.zoom).toBeCloseTo(from.zoom, 6);
    expect(end.x).toBeCloseTo(to.x, 3);
    expect(end.zoom).toBeCloseTo(to.zoom, 6);
  });

  it("zooms in place when the centre does not move", () => {
    const path = flightPath({ x: 5, y: 5, zoom: 1 }, { x: 5, y: 5, zoom: 4 });
    expect(path(0.5).zoom).toBeCloseTo(2, 9);
    expect(path(0.5).x).toBe(5);
  });
});
