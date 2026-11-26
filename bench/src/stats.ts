// SPDX-License-Identifier: GPL-3.0-or-later

// Statistics over frame times, and the comparison of two runs.

/** Frames longer than these (milliseconds) are counted. */
export const FRAME_THRESHOLDS_MS = [16.7, 33, 100] as const;

export interface FrameStats {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** Number of frames strictly longer than each threshold, keyed by the threshold. */
  readonly over: Readonly<Record<string, number>>;
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
  const over: Record<string, number> = {};
  for (const threshold of FRAME_THRESHOLDS_MS) over[String(threshold)] = 0;
  let sum = 0;
  for (const v of sorted) {
    sum += v;
    for (const threshold of FRAME_THRESHOLDS_MS) {
      if (v > threshold) over[String(threshold)] = (over[String(threshold)] ?? 0) + 1;
    }
  }
  const n = sorted.length;
  return {
    count: n,
    mean: n === 0 ? Number.NaN : sum / n,
    min: n === 0 ? Number.NaN : (sorted[0] as number),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n === 0 ? Number.NaN : (sorted[n - 1] as number),
    over,
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
  readonly withinTolerance: boolean;
  /** True if the metric decides whether the runs agree; false if it is only shown. */
  readonly decisive: boolean;
}

export interface Comparison {
  readonly tolerance: number;
  /** True if every decisive metric is within the tolerance. */
  readonly agree: boolean;
  readonly metrics: readonly MetricComparison[];
}

/** The parts of a result that compareRuns reads. */
export interface ComparableRun {
  readonly timings: { readonly runMs: number };
  readonly stats: {
    readonly interval: FrameStats;
    readonly callbackInterval: FrameStats;
    readonly script: FrameStats;
  };
}

/**
 * Compares two runs. The decisive metrics are the frame count, the total run time and
 * the mean, median, 95th and 99th percentile of the frame interval. The maximum, the
 * threshold counts, the callback intervals and the script times are shown but do
 * not decide: a single
 * garbage-collection pause moves the maximum, and script times of a near-empty engine
 * are a few microseconds, where timer resolution dominates.
 */
export function compareRuns(
  a: ComparableRun,
  b: ComparableRun,
  tolerance = 0.05,
): Comparison {
  const metrics: MetricComparison[] = [];
  const add = (name: string, va: number, vb: number, decisive: boolean) => {
    const diff = relativeDifference(va, vb);
    metrics.push({
      name,
      a: va,
      b: vb,
      relativeDifference: diff,
      withinTolerance: diff <= tolerance,
      decisive,
    });
  };
  const ia = a.stats.interval;
  const ib = b.stats.interval;
  add("frames", ia.count, ib.count, true);
  add("run time (ms)", a.timings.runMs, b.timings.runMs, true);
  add("frame interval mean (ms)", ia.mean, ib.mean, true);
  add("frame interval p50 (ms)", ia.p50, ib.p50, true);
  add("frame interval p95 (ms)", ia.p95, ib.p95, true);
  add("frame interval p99 (ms)", ia.p99, ib.p99, true);
  add("frame interval max (ms)", ia.max, ib.max, false);
  for (const threshold of FRAME_THRESHOLDS_MS) {
    const key = String(threshold);
    add(`frames over ${key} ms`, ia.over[key] ?? 0, ib.over[key] ?? 0, false);
  }
  const ca = a.stats.callbackInterval;
  const cb = b.stats.callbackInterval;
  add("callback interval p95 (ms)", ca.p95, cb.p95, false);
  add("callback interval max (ms)", ca.max, cb.max, false);
  add("script mean (ms)", a.stats.script.mean, b.stats.script.mean, false);
  add("script p95 (ms)", a.stats.script.p95, b.stats.script.p95, false);
  return {
    tolerance,
    agree: metrics.every((m) => !m.decisive || m.withinTolerance),
    metrics,
  };
}
