// SPDX-License-Identifier: GPL-3.0-or-later

// Statistics over frame times, the numbers a decision is based on, and the
// comparison of two runs.

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

/**
 * The display's refresh interval from a series of animation-frame timestamp
 * differences taken while nothing else runs: the mean after dropping the lowest and
 * highest 10 %. Timestamps jitter in some browsers (Firefox alternates about 16.1
 * and 17.1 ms at 60 Hz), but the jitter averages out; dropping the extremes keeps a
 * stray long frame from inflating the estimate.
 */
export function estimateRefreshInterval(deltas: ArrayLike<number>): number {
  const sorted = Float64Array.from(deltas).sort();
  const drop = Math.floor(sorted.length * 0.1);
  const kept = sorted.subarray(drop, sorted.length - drop);
  if (kept.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of kept) sum += v;
  return sum / kept.length;
}

/** Frame-time thresholds, as multiples of the refresh interval. */
export const MISSED_FRAME_FACTOR = 1.5;
export const LONG_FRAME_FACTOR = 2.5;
/** The refresh interval of a 60 Hz display, for thresholds that do not depend on the display. */
export const REFERENCE_REFRESH_MS = 1000 / 60;
/** Frames longer than this are stalls, whatever the display. */
export const STALL_MS = 100;

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

/**
 * The numbers to judge an engine by, all from one run. Frame times are wall-clock
 * intervals between animation-frame callbacks (see runner.ts).
 */
export interface VerdictInputs {
  /** Measured before the run, with nothing drawing. */
  readonly refreshIntervalMs: number;
  readonly refreshRateHz: number;
  /** Frames counted (frames paused for a capture are left out). */
  readonly frames: number;
  /**
   * Frames longer than 1.5 refresh intervals: at least one display refresh was
   * missed. At 60 Hz the threshold is 25 ms.
   */
  readonly missedFrames: ThresholdCount;
  /** Frames longer than 2.5 refresh intervals: slower than half the refresh rate. */
  readonly longFrames: ThresholdCount;
  /**
   * The same two counts against a 60 Hz display (25 ms and 41.7 ms), so that
   * machines with other displays can be compared with the targets in milliseconds.
   */
  readonly missedFrames60Hz: ThresholdCount;
  readonly longFrames60Hz: ThresholdCount;
  /** Frames longer than 100 ms. */
  readonly stalls: ThresholdCount;
  readonly frameMs: FrameStats;
  /** Time inside engine.render(). */
  readonly renderMs: FrameStats;
  /** Time from the camera stopping to sharp text (see TextSharpEvent). */
  readonly textSharp: {
    readonly p50Ms: number | null;
    readonly maxMs: number | null;
    readonly missing: number;
  };
  /** engine.load(), which the frame times do not include. */
  readonly loadMs: number;
  /** Highest memory figure the browser or an external sampler gave, if any. */
  readonly peakMemory: { readonly bytes: number; readonly source: string } | null;
  /** False if something made the frame times unreliable; see `problems`. */
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export function verdictInputs(input: {
  refreshIntervalMs: number;
  frameMs: ArrayLike<number>;
  renderMs: ArrayLike<number>;
  textSharp: VerdictInputs["textSharp"];
  loadMs: number;
  peakMemory: VerdictInputs["peakMemory"];
  problems: readonly string[];
}): VerdictInputs {
  const refresh = input.refreshIntervalMs;
  return {
    refreshIntervalMs: refresh,
    refreshRateHz: 1000 / refresh,
    frames: input.frameMs.length,
    missedFrames: countOver(input.frameMs, MISSED_FRAME_FACTOR * refresh),
    longFrames: countOver(input.frameMs, LONG_FRAME_FACTOR * refresh),
    missedFrames60Hz: countOver(
      input.frameMs,
      MISSED_FRAME_FACTOR * REFERENCE_REFRESH_MS,
    ),
    longFrames60Hz: countOver(input.frameMs, LONG_FRAME_FACTOR * REFERENCE_REFRESH_MS),
    stalls: countOver(input.frameMs, STALL_MS),
    frameMs: frameStats(input.frameMs),
    renderMs: frameStats(input.renderMs),
    textSharp: input.textSharp,
    loadMs: input.loadMs,
    peakMemory: input.peakMemory,
    valid: input.problems.length === 0,
    problems: input.problems,
  };
}

/** Symmetric relative difference |a - b| / max(|a|, |b|); 0 when both are 0. */
export function relativeDifference(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

export interface MetricComparison {
  readonly name: string;
  readonly a: number;
  readonly b: number;
  readonly relativeDifference: number;
  /** The largest difference allowed: max(tolerance * max(|a|, |b|), absolute floor). */
  readonly allowed: number;
  readonly withinTolerance: boolean;
  /** True if the metric decides whether the runs agree; false if it is only shown. */
  readonly decisive: boolean;
}

export interface Comparison {
  readonly tolerance: number;
  /** True if every decisive metric is within its allowed difference. */
  readonly agree: boolean;
  readonly metrics: readonly MetricComparison[];
}

/**
 * Compares the verdict inputs of two runs. A metric agrees when the two values
 * differ by at most `tolerance` (relative) or by an absolute floor, whichever is
 * larger; the floors keep small numbers from failing on noise (5 % of 3 missed
 * frames is not a meaningful difference). Floors: counts max(3, 0.2 % of the
 * frames); times in ms as listed below; text-sharp latency one refresh interval,
 * because it is measured to the next animation frame.
 */
export function compareRuns(
  a: VerdictInputs,
  b: VerdictInputs,
  tolerance = 0.05,
): Comparison {
  const metrics: MetricComparison[] = [];
  const add = (
    name: string,
    va: number,
    vb: number,
    floor: number,
    decisive: boolean,
  ) => {
    const allowed = Math.max(tolerance * Math.max(Math.abs(va), Math.abs(vb)), floor);
    metrics.push({
      name,
      a: va,
      b: vb,
      relativeDifference: relativeDifference(va, vb),
      allowed,
      withinTolerance:
        Math.abs(va - vb) <= allowed || (Number.isNaN(va) && Number.isNaN(vb)),
      decisive,
    });
  };
  const countFloor = Math.max(3, 0.002 * Math.max(a.frames, b.frames));
  const refresh = Math.max(a.refreshIntervalMs, b.refreshIntervalMs);
  const orNaN = (v: number | null) => (v === null ? Number.NaN : v);

  add("frames", a.frames, b.frames, 0, true);
  add("refresh interval (ms)", a.refreshIntervalMs, b.refreshIntervalMs, 0.5, true);
  add("missed frames", a.missedFrames.count, b.missedFrames.count, countFloor, true);
  add("long frames", a.longFrames.count, b.longFrames.count, countFloor, true);
  add("stalls over 100 ms", a.stalls.count, b.stalls.count, 1, true);
  add("frame time mean (ms)", a.frameMs.mean, b.frameMs.mean, 0.5, true);
  add("render() p50 (ms)", a.renderMs.p50, b.renderMs.p50, 0.25, true);
  add("render() p95 (ms)", a.renderMs.p95, b.renderMs.p95, 0.25, true);
  add(
    "text sharp p50 (ms)",
    orNaN(a.textSharp.p50Ms),
    orNaN(b.textSharp.p50Ms),
    refresh,
    true,
  );
  add("text sharp missing", a.textSharp.missing, b.textSharp.missing, 1, true);
  add("frame time p95 (ms)", a.frameMs.p95, b.frameMs.p95, 1, false);
  add("frame time max (ms)", a.frameMs.max, b.frameMs.max, refresh, false);
  add("render() max (ms)", a.renderMs.max, b.renderMs.max, 1, false);
  add(
    "text sharp max (ms)",
    orNaN(a.textSharp.maxMs),
    orNaN(b.textSharp.maxMs),
    refresh,
    false,
  );
  add("load (ms)", a.loadMs, b.loadMs, 50, false);
  return {
    tolerance,
    agree: metrics.every((m) => !m.decisive || m.withinTolerance),
    metrics,
  };
}
