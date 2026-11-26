// SPDX-License-Identifier: GPL-3.0-or-later

// Statistics over frame times, the targets an engine is judged against, the
// numbers a decision is based on, and the comparison of two runs.

import { STRINGS } from "./strings.ts";

export interface FrameStats {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * The p-th percentile (0 < p <= 100) of sorted values, by the nearest-rank method:
 * the smallest value such that at least p percent of the values are less or equal.
 */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (!(p > 0 && p <= 100)) throw new RangeError(`Percentile out of range: ${p}`);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function frameStats(values: ArrayLike<number>): FrameStats {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const n = sorted.length;
  return {
    count: n,
    mean: n === 0 ? Number.NaN : sum / n,
    min: n === 0 ? Number.NaN : (sorted[0] as number),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n === 0 ? Number.NaN : (sorted[n - 1] as number),
  };
}

// ---------------------------------------------------------------------------------
// The display's refresh interval

export interface RefreshEstimate {
  /** Mean of the samples within 25 % of the median. */
  readonly intervalMs: number;
  readonly medianMs: number;
  /** Share of samples within 25 % of the median (1 = perfectly steady). */
  readonly stableShare: number;
  readonly samples: number;
}

/**
 * Estimates the refresh interval from animation-frame timestamp differences taken
 * while nothing draws. The median finds the interval even when a quarter of the
 * frames were doubled by background work; averaging the samples near it then
 * removes the alternation some browsers show (Firefox: about 16.1 and 17.1 ms at
 * 60 Hz, median 17.06, true 16.67).
 */
export function estimateRefresh(deltas: ArrayLike<number>): RefreshEstimate {
  const sorted = Float64Array.from(deltas).sort();
  const median = percentile(sorted, 50);
  let sum = 0;
  let near = 0;
  for (const v of sorted) {
    if (Math.abs(v - median) <= 0.25 * median) {
      sum += v;
      near++;
    }
  }
  return {
    intervalMs: near === 0 ? Number.NaN : sum / near,
    medianMs: median,
    stableShare: sorted.length === 0 ? 0 : near / sorted.length,
    samples: sorted.length,
  };
}

/** Refresh rates of common displays, in Hz. */
export const STANDARD_REFRESH_RATES_HZ = [
  30, 48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 360,
] as const;

/** Share of calibration samples that must be near the median. */
export const MIN_STABLE_SHARE = 0.9;

/**
 * Problems with a refresh estimate that make frame times hard to judge: an unsteady
 * calibration, a rate far from every standard display rate (within 3 %), or a
 * display throttled to about 30 Hz (low-power modes do this).
 */
export function refreshProblems(estimate: RefreshEstimate): string[] {
  const p = STRINGS.problems;
  const problems: string[] = [];
  const hz = 1000 / estimate.intervalMs;
  if (!Number.isFinite(hz)) return [p.refreshUnmeasured];
  if (estimate.stableShare < MIN_STABLE_SHARE)
    problems.push(p.refreshUnsteady(estimate.stableShare));
  if (hz < 40) {
    problems.push(p.refreshLowPower(hz));
  } else if (
    !STANDARD_REFRESH_RATES_HZ.some((rate) => Math.abs(hz - rate) <= 0.03 * rate)
  ) {
    problems.push(p.refreshUnusual(hz));
  }
  return problems;
}

// ---------------------------------------------------------------------------------
// Targets

/** Proposed targets for choosing an engine. Ratios are shares of all frames. */
export const TARGETS = {
  /** At most 5 % of frames longer than 16.7 ms (meant for Chromium). */
  frames16_7: { thresholdMs: 16.7, maxRatio: 0.05 },
  /** At most 5 % of frames longer than 33 ms (meant for WebKitGTK and Firefox). */
  frames33: { thresholdMs: 33, maxRatio: 0.05 },
  /** No frame longer than 100 ms. */
  stallMs: 100,
  /** Text sharp at most 200 ms after the camera stops, at every stop. */
  textSharpMs: 200,
  /** Memory of the whole program at most 1.5 GB (10^9 bytes). */
  memoryBytes: 1.5e9,
} as const;

/** How far T / refresh may be from a whole number for the display to judge T. */
const PRESENTED_SLACK = 0.1;

/**
 * Where a frame-time target can be judged from presented frame intervals on a
 * display: only when the target is (within 10 % of a refresh) a whole number k of
 * refresh intervals, because a vsync-paced display only shows whole numbers of
 * refreshes. The threshold then sits half a refresh above k refreshes, away from the
 * values intervals can take. Null where the target falls between refreshes (16.7 ms
 * at 75, 100 or 144 Hz): there a frame shown after 2 refreshes may have taken more or
 * less than the target, and only the work time can tell.
 */
export function presentedThreshold(targetMs: number, refreshMs: number): number | null {
  const k = Math.round(targetMs / refreshMs);
  if (k < 1 || Math.abs(targetMs / refreshMs - k) > PRESENTED_SLACK) return null;
  return (k + 0.5) * refreshMs;
}

export interface ThresholdCount {
  readonly thresholdMs: number;
  /** Frames strictly longer than the threshold. */
  readonly count: number;
  /** count / frames. */
  readonly ratio: number;
}

export function countOver(
  values: ArrayLike<number>,
  thresholdMs: number,
): ThresholdCount {
  let count = 0;
  for (let i = 0; i < values.length; i++)
    if ((values[i] as number) > thresholdMs) count++;
  return { thresholdMs, count, ratio: values.length === 0 ? 0 : count / values.length };
}

/** The check of one frame-time target. */
export interface FrameTargetCheck {
  readonly thresholdMs: number;
  readonly maxRatio: number;
  /** Frames whose main-thread work took longer than the threshold. */
  readonly workOver: number;
  /** Presented-interval threshold on this display, or null where it cannot judge. */
  readonly presentedThresholdMs: number | null;
  /** Frames presented later than that, or null. */
  readonly presentedOver: number | null;
  /** Frames over the target by either measure. */
  readonly count: number;
  readonly ratio: number;
  readonly judgedBy: "work and display" | "work only";
  readonly pass: boolean;
}

function checkFrameTarget(
  target: { thresholdMs: number; maxRatio: number },
  frameMs: ArrayLike<number>,
  workMs: ArrayLike<number>,
  refreshMs: number,
): FrameTargetCheck {
  const presented = presentedThreshold(target.thresholdMs, refreshMs);
  let workOver = 0;
  let presentedOver = 0;
  let count = 0;
  for (let i = 0; i < frameMs.length; i++) {
    const byWork = (workMs[i] as number) > target.thresholdMs;
    const byDisplay = presented !== null && (frameMs[i] as number) > presented;
    if (byWork) workOver++;
    if (byDisplay) presentedOver++;
    if (byWork || byDisplay) count++;
  }
  const ratio = frameMs.length === 0 ? 0 : count / frameMs.length;
  return {
    thresholdMs: target.thresholdMs,
    maxRatio: target.maxRatio,
    workOver,
    presentedThresholdMs: presented,
    presentedOver: presented === null ? null : presentedOver,
    count,
    ratio,
    judgedBy: presented === null ? "work only" : "work and display",
    pass: ratio <= target.maxRatio,
  };
}

/**
 * The numbers to judge an engine by, all from one run.
 *
 * Frame times: `frameMs` is the wall-clock interval between animation-frame
 * callbacks (what the display paced); `workMs` is the main-thread time of the frame
 * (render() plus the browser's style, layout and paint), which no display rounds.
 */
export interface VerdictInputs {
  /** Measured before the run, with nothing drawing. */
  readonly refreshIntervalMs: number;
  readonly refreshRateHz: number;
  /** Frames counted (frames paused for a capture are left out). */
  readonly frames: number;
  /** The frame-time targets, judged on any display (see presentedThreshold). */
  readonly targets: {
    readonly frames16_7: FrameTargetCheck;
    readonly frames33: FrameTargetCheck;
    /** Frames over 100 ms, by wall clock or work time. */
    readonly stalls: { readonly count: number; readonly pass: boolean };
    readonly textSharp: {
      readonly maxMs: number | null;
      readonly missing: number;
      readonly pass: boolean;
    };
    /** Null when no host memory sampler was set: the page cannot judge it. */
    readonly memory: { readonly peakBytes: number | null; readonly pass: boolean | null };
  };
  /**
   * Display-native counts, for this display only: frames longer than 1.5 and 2.5
   * refresh intervals (a refresh missed; slower than half the refresh rate).
   */
  readonly missedRefreshes: ThresholdCount;
  readonly longRefreshes: ThresholdCount;
  readonly frameMs: FrameStats;
  readonly workMs: FrameStats;
  /** Time inside engine.render(). */
  readonly renderMs: FrameStats;
  readonly textSharp: {
    readonly p50Ms: number | null;
    readonly maxMs: number | null;
    readonly missing: number;
  };
  /** engine.load(), which the frame times do not include. */
  readonly loadMs: number;
  /** Peak from the host's memory sampler only; null without one. */
  readonly peakMemory: { readonly bytes: number; readonly source: string } | null;
  /** False if something made the run unfit for a decision; see `problems`. */
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export function verdictInputs(input: {
  refreshIntervalMs: number;
  frameMs: ArrayLike<number>;
  workMs: ArrayLike<number>;
  renderMs: ArrayLike<number>;
  textSharp: VerdictInputs["textSharp"];
  loadMs: number;
  peakMemory: VerdictInputs["peakMemory"];
  problems: readonly string[];
}): VerdictInputs {
  const refresh = input.refreshIntervalMs;
  let stalls = 0;
  for (let i = 0; i < input.frameMs.length; i++) {
    if (
      (input.frameMs[i] as number) > TARGETS.stallMs ||
      (input.workMs[i] as number) > TARGETS.stallMs
    ) {
      stalls++;
    }
  }
  const text = input.textSharp;
  const peak = input.peakMemory;
  return {
    refreshIntervalMs: refresh,
    refreshRateHz: 1000 / refresh,
    frames: input.frameMs.length,
    targets: {
      frames16_7: checkFrameTarget(
        TARGETS.frames16_7,
        input.frameMs,
        input.workMs,
        refresh,
      ),
      frames33: checkFrameTarget(TARGETS.frames33, input.frameMs, input.workMs, refresh),
      stalls: { count: stalls, pass: stalls === 0 },
      textSharp: {
        maxMs: text.maxMs,
        missing: text.missing,
        pass:
          text.missing === 0 && text.maxMs !== null && text.maxMs <= TARGETS.textSharpMs,
      },
      memory: {
        peakBytes: peak?.bytes ?? null,
        pass: peak === null ? null : peak.bytes <= TARGETS.memoryBytes,
      },
    },
    missedRefreshes: countOver(input.frameMs, 1.5 * refresh),
    longRefreshes: countOver(input.frameMs, 2.5 * refresh),
    frameMs: frameStats(input.frameMs),
    workMs: frameStats(input.workMs),
    renderMs: frameStats(input.renderMs),
    textSharp: text,
    loadMs: input.loadMs,
    peakMemory: peak,
    valid: input.problems.length === 0,
    problems: input.problems,
  };
}

// ---------------------------------------------------------------------------------
// Comparing two runs

/** Symmetric relative difference |a - b| / max(|a|, |b|); 0 when both are 0. */
export function relativeDifference(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

export type TargetId = keyof VerdictInputs["targets"];

export interface VerdictComparison {
  readonly target: TargetId;
  /** Pass (true), fail (false) or cannot judge (null), per run. */
  readonly a: boolean | null;
  readonly b: boolean | null;
  /** The number the verdict rests on, per run (ratio, count, ms or bytes). */
  readonly valueA: number | null;
  readonly valueB: number | null;
  readonly same: boolean;
}

export interface MetricComparison {
  readonly name: string;
  readonly a: number;
  readonly b: number;
  readonly relativeDifference: number;
  /** max(tolerance * max(|a|, |b|), absolute floor). */
  readonly allowed: number;
  readonly withinTolerance: boolean;
}

export interface Comparison {
  /** True if both runs reach the same verdict on every target. */
  readonly agree: boolean;
  readonly verdicts: readonly VerdictComparison[];
  /** Raw differences, for information. */
  readonly tolerance: number;
  readonly metrics: readonly MetricComparison[];
}

function targetValue(v: VerdictInputs, target: TargetId): number | null {
  const t = v.targets;
  switch (target) {
    case "frames16_7":
      return t.frames16_7.ratio;
    case "frames33":
      return t.frames33.ratio;
    case "stalls":
      return t.stalls.count;
    case "textSharp":
      return t.textSharp.missing > 0 ? Number.POSITIVE_INFINITY : t.textSharp.maxMs;
    case "memory":
      return t.memory.peakBytes;
  }
}

/**
 * Compares two runs. They agree when they reach the same verdict on every target
 * (pass, fail, or cannot judge). Raw differences of the main numbers are listed
 * too, each with an allowance of `tolerance` relative or an absolute floor, for
 * judging how steady the meter is; they do not decide.
 */
export function compareRuns(
  a: VerdictInputs,
  b: VerdictInputs,
  tolerance = 0.05,
): Comparison {
  const targets: TargetId[] = ["frames16_7", "frames33", "stalls", "textSharp", "memory"];
  const verdicts = targets.map((target): VerdictComparison => {
    const passA = a.targets[target].pass;
    const passB = b.targets[target].pass;
    return {
      target,
      a: passA,
      b: passB,
      valueA: targetValue(a, target),
      valueB: targetValue(b, target),
      same: passA === passB,
    };
  });

  const metrics: MetricComparison[] = [];
  const add = (name: string, va: number, vb: number, floor: number) => {
    const allowed = Math.max(tolerance * Math.max(Math.abs(va), Math.abs(vb)), floor);
    metrics.push({
      name,
      a: va,
      b: vb,
      relativeDifference: relativeDifference(va, vb),
      allowed,
      withinTolerance:
        Math.abs(va - vb) <= allowed || (Number.isNaN(va) && Number.isNaN(vb)),
    });
  };
  const countFloor = Math.max(3, 0.002 * Math.max(a.frames, b.frames));
  const refresh = Math.max(a.refreshIntervalMs, b.refreshIntervalMs);
  const orNaN = (v: number | null) => (v === null ? Number.NaN : v);
  add("frames", a.frames, b.frames, 0);
  add("refresh interval (ms)", a.refreshIntervalMs, b.refreshIntervalMs, 0.5);
  add(
    "frames over 16.7 ms",
    a.targets.frames16_7.count,
    b.targets.frames16_7.count,
    countFloor,
  );
  add(
    "frames over 33 ms",
    a.targets.frames33.count,
    b.targets.frames33.count,
    countFloor,
  );
  add("stalls", a.targets.stalls.count, b.targets.stalls.count, 1);
  add("missed refreshes", a.missedRefreshes.count, b.missedRefreshes.count, countFloor);
  add("frame time mean (ms)", a.frameMs.mean, b.frameMs.mean, 0.5);
  add("work p50 (ms)", a.workMs.p50, b.workMs.p50, 0.5);
  add("work p95 (ms)", a.workMs.p95, b.workMs.p95, 1);
  add("render() p95 (ms)", a.renderMs.p95, b.renderMs.p95, 1);
  add("text sharp p50 (ms)", orNaN(a.textSharp.p50Ms), orNaN(b.textSharp.p50Ms), refresh);
  add("text sharp max (ms)", orNaN(a.textSharp.maxMs), orNaN(b.textSharp.maxMs), refresh);
  add("load (ms)", a.loadMs, b.loadMs, 50);
  return {
    agree: verdicts.every((v) => v.same),
    verdicts,
    tolerance,
    metrics,
  };
}
