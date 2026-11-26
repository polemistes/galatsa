// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createRng } from "./prng.ts";
import {
  compareRuns,
  countOver,
  estimateRefresh,
  frameStats,
  percentile,
  presentedThreshold,
  refreshProblems,
  relativeDifference,
  type VerdictInputs,
  verdictInputs,
} from "./stats.ts";

describe("percentile and frameStats", () => {
  it("uses the nearest-rank method", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 11)).toBe(2);
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile([1], 0)).toThrow(RangeError);
  });

  it("computes mean, percentiles and extremes", () => {
    const stats = frameStats([
      ...Array<number>(90).fill(10),
      ...Array<number>(9).fill(20),
      120,
    ]);
    expect(stats.count).toBe(100);
    expect(stats.mean).toBeCloseTo(12, 10);
    expect([stats.p50, stats.p95, stats.p99, stats.max]).toEqual([10, 20, 20, 120]);
  });
});

describe("estimateRefresh and refreshProblems", () => {
  it("averages out alternating timestamps (Firefox-like 16.1 / 17.1 ms)", () => {
    const e = estimateRefresh(
      Array.from({ length: 120 }, (_, i) => (i % 2 ? 17.1 : 16.1)),
    );
    expect(e.intervalMs).toBeCloseTo(16.6, 6);
    expect(e.stableShare).toBe(1);
    expect(refreshProblems(e)).toEqual([]);
  });

  it("ignores doubled frames and reports them as unsteady", () => {
    // A quarter of the idle frames doubled by background work.
    const e = estimateRefresh(
      Array.from({ length: 120 }, (_, i) => (i % 4 ? 16.67 : 33.33)),
    );
    expect(e.intervalMs).toBeCloseTo(16.67, 6);
    expect(e.stableShare).toBeCloseTo(0.75, 6);
    expect(refreshProblems(e)).toHaveLength(1);
    expect(refreshProblems(e)[0]).toMatch(/not steady/);
  });

  it("flags a display throttled to 30 Hz and unusual rates, and accepts standard ones", () => {
    const at = (ms: number) => estimateRefresh(Array<number>(120).fill(ms));
    expect(refreshProblems(at(33.33))[0]).toMatch(/low-power/);
    expect(refreshProblems(at(1000 / 52))[0]).toMatch(/not a usual display rate/);
    for (const hz of [59.94, 60, 75, 100, 120, 144, 165, 240]) {
      expect(refreshProblems(at(1000 / hz)), String(hz)).toEqual([]);
    }
  });
});

describe("presentedThreshold", () => {
  it("judges a target from presented intervals only where it is a whole number of refreshes", () => {
    const r = (hz: number) => 1000 / hz;
    expect(presentedThreshold(16.7, r(60))).toBeCloseTo(1.5 * r(60), 10); // 25 ms
    expect(presentedThreshold(33, r(60))).toBeCloseTo(2.5 * r(60), 10); // 41.7 ms
    expect(presentedThreshold(16.7, r(120))).toBeCloseTo(2.5 * r(120), 10); // 20.8 ms
    expect(presentedThreshold(33, r(120))).toBeCloseTo(4.5 * r(120), 10); // 37.5 ms
    expect(presentedThreshold(16.7, r(240))).toBeCloseTo(4.5 * r(240), 10); // 18.75 ms
    expect(presentedThreshold(33, r(240))).toBeCloseTo(8.5 * r(240), 10); // 35.4 ms
    for (const hz of [75, 100, 144]) {
      expect(presentedThreshold(16.7, r(hz)), String(hz)).toBeNull();
      expect(presentedThreshold(33, r(hz)), String(hz)).toBeNull();
    }
  });
});

/**
 * Frames on a vsync-paced display: work of `workMs` (plus or minus 0.1 ms) is shown
 * at the next refresh, so the interval is a whole number of refreshes (at least
 * one), plus or minus 0.1 ms of timer jitter.
 */
function vsyncRun(hz: number, workMs: number, frames = 2775) {
  const refresh = 1000 / hz;
  const rng = createRng(hz * 1000 + workMs);
  const work: number[] = [];
  const presented: number[] = [];
  for (let i = 0; i < frames; i++) {
    const w = workMs + (rng.next() - 0.5) * 0.2;
    work.push(w);
    presented.push(
      Math.max(1, Math.ceil(w / refresh)) * refresh + (rng.next() - 0.5) * 0.2,
    );
  }
  return verdictInputs({
    refreshIntervalMs: refresh,
    frameMs: presented,
    workMs: work,
    renderMs: work,
    textSharp: { p50Ms: 20, maxMs: 30, missing: 0 },
    loadMs: 0,
    peakMemory: null,
    problems: [],
  });
}

describe("frame targets on vsync-paced displays", () => {
  // Work per frame, and whether it meets the 16.7 ms and the 33 ms target.
  const cases: [number, boolean, boolean][] = [
    [5, true, true],
    [10, true, true],
    [15, true, true],
    [16.5, true, true],
    [18, false, true],
    [20, false, true],
    [30, false, true],
    [32.8, false, true],
    [34, false, false],
    [38, false, false],
    [60, false, false],
  ];
  for (const hz of [60, 75, 100, 120, 144, 240]) {
    for (const [work, meets16, meets33] of cases) {
      it(`${work} ms of work at ${hz} Hz: 16.7 ms ${meets16 ? "met" : "missed"}, 33 ms ${meets33 ? "met" : "missed"}`, () => {
        const v = vsyncRun(hz, work);
        expect(v.targets.frames16_7.ratio).toBe(meets16 ? 0 : 1);
        expect(v.targets.frames16_7.pass).toBe(meets16);
        expect(v.targets.frames33.ratio).toBe(meets33 ? 0 : 1);
        expect(v.targets.frames33.pass).toBe(meets33);
      });
    }
  }

  it("uses the display as well as the work where the target is whole refreshes", () => {
    expect(vsyncRun(60, 10).targets.frames16_7.judgedBy).toBe("work and display");
    expect(vsyncRun(120, 10).targets.frames33.judgedBy).toBe("work and display");
    expect(vsyncRun(240, 10).targets.frames16_7.judgedBy).toBe("work and display");
    expect(vsyncRun(144, 10).targets.frames16_7.judgedBy).toBe("work only");
    expect(vsyncRun(75, 10).targets.frames33.judgedBy).toBe("work only");
  });

  it("counts frames the display delayed beyond their work (off the main thread)", () => {
    // 5 ms of work, but every frame shown after two refreshes at 60 Hz.
    const refresh = 1000 / 60;
    const v = verdictInputs({
      refreshIntervalMs: refresh,
      frameMs: Array<number>(100).fill(2 * refresh),
      workMs: Array<number>(100).fill(5),
      renderMs: Array<number>(100).fill(1),
      textSharp: { p50Ms: 20, maxMs: 30, missing: 0 },
      loadMs: 0,
      peakMemory: null,
      problems: [],
    });
    expect(v.targets.frames16_7.workOver).toBe(0);
    expect(v.targets.frames16_7.presentedOver).toBe(100);
    expect(v.targets.frames16_7.pass).toBe(false);
    expect(v.targets.frames33.pass).toBe(true);
    expect(v.missedRefreshes.count).toBe(100);
  });

  it("counts intervals exactly on a refresh multiple on the right side", () => {
    // At 120 Hz, three refreshes (25.0 ms) is over 16.7 ms; two (16.67 ms) is not.
    const refresh = 1000 / 120;
    const v = verdictInputs({
      refreshIntervalMs: refresh,
      frameMs: [2 * refresh, 3 * refresh, 4 * refresh, 5 * refresh],
      workMs: [1, 1, 1, 1],
      renderMs: [1, 1, 1, 1],
      textSharp: { p50Ms: 20, maxMs: 30, missing: 0 },
      loadMs: 0,
      peakMemory: null,
      problems: [],
    });
    expect(v.targets.frames16_7.presentedOver).toBe(3);
    expect(v.targets.frames33.presentedOver).toBe(1);
  });
});

describe("other targets", () => {
  const base = (over: Partial<Parameters<typeof verdictInputs>[0]> = {}) =>
    verdictInputs({
      refreshIntervalMs: 1000 / 60,
      frameMs: [16.7, 16.6, 120],
      workMs: [3, 3, 3],
      renderMs: [1, 1, 1],
      textSharp: { p50Ms: 20, maxMs: 180, missing: 0 },
      loadMs: 5,
      peakMemory: null,
      problems: [],
      ...over,
    });

  it("counts stalls by wall clock or work", () => {
    expect(base().targets.stalls).toEqual({ count: 1, pass: false });
    expect(
      base({ frameMs: [16.7, 16.7, 16.7], workMs: [3, 101, 3] }).targets.stalls.count,
    ).toBe(1);
    expect(base({ frameMs: [16.7, 16.7, 16.7] }).targets.stalls.pass).toBe(true);
  });

  it("judges text sharpness: max at most 200 ms and none missing", () => {
    expect(base().targets.textSharp.pass).toBe(true);
    expect(
      base({ textSharp: { p50Ms: 20, maxMs: 201, missing: 0 } }).targets.textSharp.pass,
    ).toBe(false);
    expect(
      base({ textSharp: { p50Ms: 20, maxMs: 30, missing: 1 } }).targets.textSharp.pass,
    ).toBe(false);
  });

  it("judges memory only with a host sampler", () => {
    expect(base().targets.memory).toEqual({ peakBytes: null, pass: null });
    const ok = base({ peakMemory: { bytes: 1.2e9, source: "host" } });
    expect(ok.targets.memory.pass).toBe(true);
    expect(
      base({ peakMemory: { bytes: 1.6e9, source: "host" } }).targets.memory.pass,
    ).toBe(false);
  });

  it("counts strictly over a threshold", () => {
    expect(countOver([1, 2, 3], 2)).toEqual({ thresholdMs: 2, count: 1, ratio: 1 / 3 });
  });
});

describe("compareRuns", () => {
  const run = (overFrames: number, extra: Partial<VerdictInputs> = {}): VerdictInputs => {
    const refresh = 1000 / 60;
    const frames = Array.from({ length: 2775 }, (_, i) =>
      i < overFrames ? 2 * refresh : refresh,
    );
    return {
      ...verdictInputs({
        refreshIntervalMs: refresh,
        frameMs: frames,
        workMs: frames.map((f) => f - 2),
        renderMs: frames.map(() => 5),
        textSharp: { p50Ms: 17, maxMs: 40, missing: 0 },
        loadMs: 10,
        peakMemory: null,
        problems: [],
      }),
      ...extra,
    };
  };

  it("measures the symmetric relative difference", () => {
    expect(relativeDifference(100, 105)).toBeCloseTo(5 / 105, 12);
    expect(relativeDifference(0, 0)).toBe(0);
  });

  it("agrees when the verdict is the same, even if counts differ a lot", () => {
    // 38 against 24 frames over 16.7 ms: 1.4 % and 0.9 %, both within 5 %.
    const c = compareRuns(run(38), run(24));
    expect(c.agree).toBe(true);
    expect(c.metrics.find((m) => m.name === "frames over 16.7 ms")!.withinTolerance).toBe(
      false,
    );
  });

  it("disagrees when a verdict flips", () => {
    // 4.9 % against 5.1 % of frames over 16.7 ms.
    expect(compareRuns(run(136), run(142)).agree).toBe(false);
    // One stall against none.
    const stall = run(0, {});
    const withStall: VerdictInputs = {
      ...stall,
      targets: { ...stall.targets, stalls: { count: 1, pass: false } },
    };
    const c = compareRuns(stall, withStall);
    expect(c.agree).toBe(false);
    expect(c.verdicts.find((v) => v.target === "stalls")).toMatchObject({
      a: true,
      b: false,
    });
  });

  it("treats two runs that cannot judge memory as agreeing", () => {
    const c = compareRuns(run(0), run(0));
    expect(c.verdicts.find((v) => v.target === "memory")).toMatchObject({
      a: null,
      b: null,
      same: true,
    });
  });
});
