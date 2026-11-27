// SPDX-License-Identifier: GPL-3.0-or-later

// Flattening follows the Canvas 2D path rules; hit testing and bounds rest on it.

import { describe, expect, it } from "vitest";
import {
  arcSweep,
  extent,
  flatten,
  insideFill,
  outlineDistance,
  PlacedPath,
  RecordingPath,
} from "./geometry.ts";

const TAU = 2 * Math.PI;

describe("arc sweeps, by the Canvas 2D rules", () => {
  it("draws a full circle for a sweep of a turn or more in the arc's direction", () => {
    expect(arcSweep(0, TAU, false)).toBe(TAU);
    expect(arcSweep(0, 3 * TAU, false)).toBe(TAU);
    expect(arcSweep(TAU, 0, true)).toBe(-TAU);
  });
  it("takes other angles modulo a turn", () => {
    expect(arcSweep(0, -Math.PI / 2, false)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(arcSweep(0, Math.PI / 2, true)).toBeCloseTo((-3 * Math.PI) / 2, 12);
    expect(arcSweep(Math.PI, Math.PI, false)).toBe(0);
  });
});

describe("flatten", () => {
  it("makes a closed run of a rectangle and starts a new run at its corner", () => {
    const p = new RecordingPath();
    p.rect(1, 2, 10, 20);
    p.lineTo(5, 5);
    const { lines, error } = flatten(p.ops, 0.1);
    expect(lines).toEqual([
      { points: [1, 2, 11, 2, 11, 22, 1, 22], closed: true },
      { points: [1, 2, 5, 5], closed: false },
    ]);
    expect(error).toBe(0);
  });

  it("closes a run with closePath and continues from its first point", () => {
    const p = new RecordingPath();
    p.moveTo(0, 0);
    p.lineTo(10, 0);
    p.lineTo(10, 10);
    p.closePath();
    p.lineTo(-5, 0);
    const { lines } = flatten(p.ops, 1);
    expect(lines).toEqual([
      { points: [0, 0, 10, 0, 10, 10], closed: true },
      { points: [0, 0, -5, 0], closed: false },
    ]);
  });

  it("flattens an ellipse within the tolerance and reports the error", () => {
    const p = new RecordingPath();
    p.ellipse(50, 25, 50, 25, 0, 0, TAU);
    const { lines, error } = flatten(p.ops, 0.01);
    expect(error).toBeLessThanOrEqual(0.01);
    expect(error).toBeGreaterThan(0);
    const pts = lines[0]!.points;
    for (let i = 0; i < pts.length; i += 2) {
      const dx = (pts[i]! - 50) / 50;
      const dy = (pts[i + 1]! - 25) / 25;
      expect(dx * dx + dy * dy).toBeCloseTo(1, 9);
    }
    // The chords stay inside the curve, by at most the error.
    const box = extent(lines)!;
    expect(box.x).toBeCloseTo(0, 9);
    expect(box.w).toBeCloseTo(100, 9);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThanOrEqual(error);
    expect(box.y + box.h).toBeGreaterThanOrEqual(50 - error);
  });

  it("joins an arc to the current point with a line", () => {
    const p = new RecordingPath();
    p.moveTo(0, 0);
    p.arc(10, 0, 5, Math.PI, 0);
    const { lines } = flatten(p.ops, 0.5);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.points.slice(0, 4)).toEqual([0, 0, 5, expect.closeTo(0, 12)]);
  });

  it("makes a rounded rectangle whose corners are quarter circles", () => {
    const p = new RecordingPath();
    p.roundRect(0, 0, 100, 50, 10);
    const { lines } = flatten(p.ops, 0.01);
    expect(lines[0]!.closed).toBe(true);
    // A corner of the box is outside the rounded outline; its middle inside.
    expect(insideFill(lines, 1, 1)).toBe(false);
    expect(insideFill(lines, 50, 25)).toBe(true);
    expect(outlineDistance(lines, 0, 0)).toBeCloseTo(Math.SQRT2 * 10 - 10, 2);
  });

  it("limits the radius of a rounded rectangle to half the shorter side", () => {
    const p = new RecordingPath();
    p.roundRect(0, 0, 100, 20, 500);
    const { lines } = flatten(p.ops, 0.001);
    expect(extent(lines)).toEqual({
      x: expect.closeTo(0, 6),
      y: expect.closeTo(0, 6),
      w: expect.closeTo(100, 6),
      h: expect.closeTo(20, 6),
    });
  });

  it("keeps curves within the tolerance", () => {
    const p = new RecordingPath();
    p.moveTo(0, 0);
    p.bezierCurveTo(0, 100, 100, 100, 100, 0);
    const { lines, error } = flatten(p.ops, 0.05);
    expect(error).toBeLessThanOrEqual(0.05);
    // The curve's top is at y = 75 (t = 0.5).
    expect(extent(lines)!.h).toBeCloseTo(75, 1);
  });
});

describe("the fill rule and distances", () => {
  it("fills by the nonzero rule, so a run drawn twice the same way is still filled", () => {
    const p = new RecordingPath();
    p.rect(0, 0, 10, 10);
    p.rect(2, 2, 6, 6);
    const { lines } = flatten(p.ops, 1);
    expect(insideFill(lines, 5, 5)).toBe(true);
    expect(insideFill(lines, 11, 5)).toBe(false);
  });

  it("measures the distance to open runs without closing them", () => {
    const p = new RecordingPath();
    p.moveTo(0, 0);
    p.lineTo(10, 0);
    p.lineTo(10, 10);
    const { lines } = flatten(p.ops, 1);
    expect(outlineDistance(lines, 0, 10)).toBe(10);
    expect(outlineDistance(lines, 5, 1)).toBe(1);
  });
});

describe("placed paths", () => {
  it("turn and move every kind of path call alike", () => {
    const draw = (p: { moveTo: RecordingPath["moveTo"] } & RecordingPath) => {
      p.rect(0, 0, 40, 20);
      p.roundRect(50, 0, 30, 30, 8);
      p.ellipse(20, 60, 15, 8, 0.3, 0, TAU);
      p.moveTo(0, 90);
      p.arc(30, 90, 10, Math.PI, 0);
      p.quadraticCurveTo(50, 120, 60, 90);
      p.bezierCurveTo(70, 70, 80, 110, 90, 90);
      p.closePath();
    };
    const plain = new RecordingPath();
    draw(plain);
    const target = new RecordingPath();
    const placement = { rot: 0.7, dx: 13, dy: -4 };
    draw(new PlacedPath(target, placement) as unknown as RecordingPath);
    const cos = Math.cos(placement.rot);
    const sin = Math.sin(placement.rot);
    const a = flatten(plain.ops, 0.001).lines;
    const b = flatten(target.ops, 0.001).lines;
    // Every placed point lies on the placed outline, and the other way round.
    for (const [from, to, turn] of [
      [a, b, true],
      [b, a, false],
    ] as const) {
      for (const line of from) {
        for (let i = 0; i < line.points.length; i += 2) {
          let x = line.points[i]!;
          let y = line.points[i + 1]!;
          if (turn) [x, y] = [x * cos - y * sin + 13, x * sin + y * cos - 4];
          else [x, y] = [(x - 13) * cos + (y + 4) * sin, -(x - 13) * sin + (y + 4) * cos];
          expect(outlineDistance(to, x, y)).toBeLessThan(0.01);
        }
      }
    }
  });
});
