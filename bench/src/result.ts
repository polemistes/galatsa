// SPDX-License-Identifier: GPL-3.0-or-later

// The JSON result of one benchmark run.

import type { Segment, SegmentKind } from "./camera.ts";
import type { BenchViewport } from "./engine.ts";
import type { MemoryReport } from "./memory.ts";
import type { SceneSummary } from "./scene.ts";
import { type FrameStats, frameStats, type VerdictInputs } from "./stats.ts";
import { STRINGS } from "./strings.ts";

export const RESULT_FORMAT = "galatsa-bench-result";
/** 2: wall-clock frame times as the primary measure, verdictInputs, captures. */
export const RESULT_VERSION = 2;

export interface TextSharpEvent {
  /** Label of the hold segment in which the camera stood still. */
  readonly label: string;
  /** First frame of the hold. */
  readonly frame: number;
  /**
   * Milliseconds from just before render() of the first still frame to the start of
   * the first animation frame after the engine's first reportTextSharp() call, that
   * is, after the browser has had a chance to show what the engine drew. At least
   * one refresh interval. Null if the engine did not report before the camera moved.
   */
  readonly latencyMs: number | null;
  /** Milliseconds from the same start to the reportTextSharp() call itself. */
  readonly reportMs: number | null;
}

/** An image of the stage at the end of a hold, for side-by-side review. */
export interface Capture {
  readonly label: string;
  /** Last frame of the hold. */
  readonly frame: number;
  /** Who made the image: "engine" (BenchEngine.snapshot) or "host" (the page's host). */
  readonly by: "engine" | "host";
  /** A data: URL (PNG or another image type). */
  readonly dataUrl: string;
}

export interface StageInfo {
  /** Position of the stage in the window, CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The window's inner size when checked. */
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** True if the whole stage was inside the window at the start and at the end. */
  readonly fullyVisible: boolean;
}

export interface BenchResult {
  readonly format: typeof RESULT_FORMAT;
  readonly version: typeof RESULT_VERSION;
  readonly engine: string;
  /** Wall-clock start time (ISO 8601). Metadata only. */
  readonly startedAt: string;
  /** The numbers to judge the engine by. See VerdictInputs in stats.ts. */
  readonly verdictInputs: VerdictInputs;
  readonly environment: {
    readonly userAgent: string;
    readonly viewport: BenchViewport;
    readonly stage: StageInfo;
    readonly crossOriginIsolated: boolean;
    /** Smallest step of performance.now() seen; frame times are no finer than this. */
    readonly timerResolutionMs: number;
    readonly refresh: {
      /** Trimmed mean of animation-frame timestamp differences while idle. */
      readonly intervalMs: number;
      readonly rateHz: number;
      /** Median of the same differences, to show how regular the display clock is. */
      readonly medianMs: number;
      readonly samples: number;
    };
    /** Time waited before the run for the page to become idle. */
    readonly settle: { readonly ms: number; readonly idleDetected: boolean };
    readonly hiddenDuringRun: boolean;
    readonly resizedDuringRun: boolean;
  };
  readonly scene: SceneSummary & { readonly encodedImageBytes: number };
  readonly cameraRun: { readonly frames: number; readonly segments: readonly Segment[] };
  readonly timings: {
    /** Time to generate and encode the images (once per page, before any run). */
    readonly imageGenerationMs: number;
    /** engine.load(). */
    readonly loadMs: number;
    /** Frames rendered at the first pose before timing starts. */
    readonly warmupFrames: number;
    /** Wall-clock time from the first timed frame to the end of the last one. */
    readonly runMs: number;
  };
  /** Per frame, in run order. */
  readonly frames: {
    /**
     * Wall-clock time from the start of this frame's animation-frame callback to the
     * start of the next one. The primary frame time.
     */
    readonly frameMs: readonly number[];
    /** Difference of the timestamps the browser passed to the same two callbacks. */
    readonly timestampMs: readonly number[];
    /** Time spent in engine.render(). */
    readonly renderMs: readonly number[];
    /** Frames left out of all statistics (paused for a capture). */
    readonly excluded: readonly number[];
  };
  readonly stats: {
    readonly frameMs: FrameStats;
    readonly timestampMs: FrameStats;
    readonly renderMs: FrameStats;
    /** Wall-clock frame times grouped by segment kind. */
    readonly frameMsByKind: Readonly<Partial<Record<SegmentKind, FrameStats>>>;
  };
  readonly textSharp: {
    readonly events: readonly TextSharpEvent[];
    readonly reported: number;
    readonly missing: number;
    /** Over the reported latencies; null if none were reported. */
    readonly p50Ms: number | null;
    readonly maxMs: number | null;
  };
  readonly memory: MemoryReport;
  /** Empty unless the run was made with captures. */
  readonly captures: readonly Capture[];
}

/** Frame stats per segment kind, leaving out excluded frames. */
export function statsByKind(
  values: ArrayLike<number>,
  segments: readonly Segment[],
  excluded: ReadonlySet<number> = new Set(),
): Partial<Record<SegmentKind, FrameStats>> {
  const groups = new Map<SegmentKind, number[]>();
  for (const segment of segments) {
    let group = groups.get(segment.kind);
    if (group === undefined) groups.set(segment.kind, (group = []));
    for (let i = segment.start; i < segment.end && i < values.length; i++) {
      if (!excluded.has(i)) group.push(values[i] as number);
    }
  }
  const out: Partial<Record<SegmentKind, FrameStats>> = {};
  for (const [kind, group] of groups) out[kind] = frameStats(group);
  return out;
}

/** Text-sharpness summary from the events. */
export function summarizeTextSharp(
  events: readonly TextSharpEvent[],
): BenchResult["textSharp"] {
  const reported = events
    .map((e) => e.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const stats = reported.length > 0 ? frameStats(reported) : undefined;
  return {
    events,
    reported: reported.length,
    missing: events.length - reported.length,
    p50Ms: stats?.p50 ?? null,
    maxMs: stats?.max ?? null,
  };
}

/** A short plain-text summary of a result, for logs and the harness page. */
export function formatSummary(result: BenchResult): string {
  const s = STRINGS.summary;
  const v = result.verdictInputs;
  const env = result.environment;
  const lines = [
    s.run(result.engine, v.frames, result.timings.runMs, v.loadMs),
    s.refresh(v.refreshIntervalMs, v.refreshRateHz),
    s.missed(v.missedFrames.count, v.missedFrames.ratio, v.missedFrames.thresholdMs),
    s.long(v.longFrames.count, v.longFrames.ratio, v.longFrames.thresholdMs),
    s.at60Hz(v.missedFrames60Hz.ratio, v.longFrames60Hz.ratio),
    s.stalls(v.stalls.count, v.frameMs.max),
    s.frame(v.frameMs.mean, v.frameMs.p50, v.frameMs.p95, v.frameMs.p99),
    s.render(v.renderMs.p50, v.renderMs.p95, v.renderMs.p99, v.renderMs.max),
    s.textSharp(
      result.textSharp.reported,
      v.textSharp.missing,
      v.textSharp.p50Ms,
      v.textSharp.maxMs,
    ),
    v.peakMemory === null
      ? s.memoryUnavailable
      : s.memory(v.peakMemory.bytes, v.peakMemory.source),
    s.environment(
      env.viewport.width,
      env.viewport.height,
      env.viewport.devicePixelRatio,
      env.timerResolutionMs,
    ),
  ];
  for (const problem of v.problems) lines.push(s.problem(problem));
  return lines.join("\n");
}
