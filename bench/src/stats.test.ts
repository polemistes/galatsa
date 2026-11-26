// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  type ComparableRun,
  compareRuns,
  frameStats,
  percentile,
  relativeDifference,
} from "./stats.ts";

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 10)).toBe(1);
    expect(percentile(sorted, 11)).toBe(2);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
  });

  it("is NaN for no values and rejects bad percentiles", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("frameStats", () => {
  it("computes mean, percentiles, max and threshold counts", () => {
    // 100 frames: 90 of 10 ms, 5 of 16.7 ms (not over), 3 of 20 ms, 1 of 40, 1 of 120.
    const values = [
      ...Array<number>(90).fill(10),
      ...Array<number>(5).fill(16.7),
      ...Array<number>(3).fill(20),
      40,
      120,
    ];
    const stats = frameStats(values.reverse());
    expect(stats.count).toBe(100);
    expect(stats.mean).toBeCloseTo((900 + 83.5 + 60 + 40 + 120) / 100, 10);
    expect(stats.min).toBe(10);
    expect(stats.p50).toBe(10);
    expect(stats.p95).toBe(16.7);
    expect(stats.p99).toBe(40);
    expect(stats.max).toBe(120);
    expect(stats.over).toEqual({ "16.7": 5, "33": 2, "100": 1 });
  });

  it("handles no frames", () => {
    const stats = frameStats([]);
    expect(stats.count).toBe(0);
    expect(stats.mean).toBeNaN();
    expect(stats.over).toEqual({ "16.7": 0, "33": 0, "100": 0 });
  });
});

describe("compareRuns", () => {
  const run = (intervals: number[]): ComparableRun => ({
    timings: { runMs: intervals.reduce((a, b) => a + b, 0) },
    stats: {
      interval: frameStats(intervals),
      callbackInterval: frameStats(intervals),
      script: frameStats(intervals.map(() => 0.01)),
    },
  });

  it("measures the symmetric relative difference", () => {
    expect(relativeDifference(100, 105)).toBeCloseTo(5 / 105, 12);
    expect(relativeDifference(105, 100)).toBeCloseTo(5 / 105, 12);
    expect(relativeDifference(0, 0)).toBe(0);
  });

  it("agrees within 5 % and disagrees outside", () => {
    const a = run(Array<number>(1000).fill(16.67));
    const close = run(Array<number>(1000).fill(17.2));
    const far = run(Array<number>(1000).fill(18));
    expect(compareRuns(a, close).agree).toBe(true);
    expect(compareRuns(a, far).agree).toBe(false);
  });

  it("does not let the maximum or threshold counts decide", () => {
    const base = Array<number>(1000).fill(16.67);
    const spike = [...base.slice(1), 150];
    const comparison = compareRuns(run(base), run(spike));
    expect(comparison.agree).toBe(true);
    const max = comparison.metrics.find((m) => m.name.includes("max"))!;
    expect(max.withinTolerance).toBe(false);
    expect(max.decisive).toBe(false);
  });

  it("disagrees when the frame counts differ", () => {
    const a = run(Array<number>(1000).fill(16.67));
    const b = run(Array<number>(900).fill(16.67));
    expect(compareRuns(a, b).agree).toBe(false);
  });
});
