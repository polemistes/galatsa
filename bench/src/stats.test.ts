// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  compareRuns,
  countOver,
  estimateRefreshInterval,
  frameStats,
  percentile,
  relativeDifference,
  type VerdictInputs,
  verdictInputs,
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
  it("computes mean, percentiles and extremes", () => {
    const values = [...Array<number>(90).fill(10), ...Array<number>(9).fill(20), 120];
    const stats = frameStats(values.reverse());
    expect(stats.count).toBe(100);
    expect(stats.mean).toBeCloseTo((900 + 180 + 120) / 100, 10);
    expect(stats.min).toBe(10);
    expect(stats.p50).toBe(10);
    expect(stats.p95).toBe(20);
    expect(stats.p99).toBe(20);
    expect(stats.max).toBe(120);
  });

  it("handles no frames", () => {
    expect(frameStats([]).count).toBe(0);
    expect(frameStats([]).mean).toBeNaN();
  });
});

describe("estimateRefreshInterval", () => {
  it("averages out alternating timestamps (Firefox-like 16.1 / 17.1 ms)", () => {
    const deltas = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 16.1 : 17.1));
    expect(estimateRefreshInterval(deltas)).toBeCloseTo(16.6, 6);
  });

  it("ignores a few stray long frames", () => {
    const deltas = [...Array<number>(110).fill(8.333), ...Array<number>(10).fill(100)];
    expect(estimateRefreshInterval(deltas)).toBeCloseTo(8.333, 6);
  });
});

describe("verdictInputs", () => {
  it("counts missed, long and stalled frames relative to the refresh interval", () => {
    // 60 Hz: missed over 25 ms, long over 41.67 ms, stall over 100 ms.
    const frames = [16.7, 17.2, 24.9, 25.1, 33.3, 41.6, 41.7, 50, 100, 110];
    const v = verdictInputs({
      refreshIntervalMs: 1000 / 60,
      frameMs: frames,
      renderMs: frames.map(() => 1),
      textSharp: { p50Ms: 17, maxMs: 20, missing: 0 },
      loadMs: 5,
      peakMemory: null,
      problems: [],
    });
    expect(v.missedFrames.count).toBe(7);
    expect(v.missedFrames.thresholdMs).toBeCloseTo(25, 10);
    expect(v.longFrames.count).toBe(4);
    expect(v.stalls.count).toBe(1);
    expect(v.missedFrames.ratio).toBeCloseTo(0.7, 10);
    expect(v.refreshRateHz).toBeCloseTo(60, 10);
    expect(v.valid).toBe(true);
  });

  it("uses refresh-relative thresholds on a 120 Hz display, and keeps 60 Hz ones", () => {
    const frames = [8.3, 8.4, 13, 16.7, 30];
    const v = verdictInputs({
      refreshIntervalMs: 1000 / 120,
      frameMs: frames,
      renderMs: frames,
      textSharp: { p50Ms: null, maxMs: null, missing: 1 },
      loadMs: 0,
      peakMemory: null,
      problems: ["hidden"],
    });
    expect(v.missedFrames.count).toBe(3); // over 12.5 ms
    expect(v.longFrames.count).toBe(1); // over 20.8 ms
    expect(v.missedFrames60Hz.count).toBe(1); // over 25 ms
    expect(v.valid).toBe(false);
  });

  it("counts strictly over the threshold", () => {
    expect(countOver([1, 2, 3], 2)).toEqual({ thresholdMs: 2, count: 1, ratio: 1 / 3 });
    expect(countOver([], 2).ratio).toBe(0);
  });
});

describe("compareRuns", () => {
  const inputs = (
    frameMs: number[],
    overrides: Partial<VerdictInputs> = {},
  ): VerdictInputs => ({
    ...verdictInputs({
      refreshIntervalMs: 1000 / 60,
      frameMs,
      renderMs: frameMs.map((v) => v / 2),
      textSharp: { p50Ms: 16.7, maxMs: 33, missing: 0 },
      loadMs: 10,
      peakMemory: null,
      problems: [],
    }),
    ...overrides,
  });
  const steady = Array<number>(2775).fill(16.67);
  const withMissed = (count: number) => steady.map((v, i) => (i < count ? 33.3 : v));

  it("measures the symmetric relative difference", () => {
    expect(relativeDifference(100, 105)).toBeCloseTo(5 / 105, 12);
    expect(relativeDifference(0, 0)).toBe(0);
  });

  it("agrees on identical runs", () => {
    expect(compareRuns(inputs(steady), inputs(steady)).agree).toBe(true);
  });

  it("uses an absolute floor for small counts", () => {
    // 2 against 6 missed frames: 67 % apart, but within the floor of 3 + 2775 * 0.2 %.
    expect(compareRuns(inputs(withMissed(2)), inputs(withMissed(6))).agree).toBe(true);
    // 2 against 20 is not.
    expect(compareRuns(inputs(withMissed(2)), inputs(withMissed(20))).agree).toBe(false);
  });

  it("uses 5 % for large counts", () => {
    expect(compareRuns(inputs(withMissed(1000)), inputs(withMissed(1040))).agree).toBe(
      true,
    );
    expect(compareRuns(inputs(withMissed(1000)), inputs(withMissed(1100))).agree).toBe(
      false,
    );
  });

  it("disagrees on render time, text latency and refresh changes", () => {
    const base = inputs(steady);
    const slowerRender = inputs(steady.map((v) => v * 1.2));
    expect(compareRuns(base, slowerRender).agree).toBe(false);
    const lateText = inputs(steady, { textSharp: { p50Ms: 60, maxMs: 80, missing: 0 } });
    expect(compareRuns(base, lateText).agree).toBe(false);
    const otherDisplay = inputs(steady, { refreshIntervalMs: 8.33 });
    expect(compareRuns(base, otherDisplay).agree).toBe(false);
  });

  it("does not let the maximum or load time decide", () => {
    const spike = inputs(steady.map((v, i) => (i === 5 ? 90 : v)));
    const slowLoad = inputs(steady, { loadMs: 900 });
    const comparison = compareRuns(inputs(steady), spike);
    expect(comparison.agree).toBe(true);
    expect(
      comparison.metrics.find((m) => m.name.startsWith("frame time max"))!
        .withinTolerance,
    ).toBe(false);
    expect(compareRuns(inputs(steady), slowLoad).agree).toBe(true);
  });
});
