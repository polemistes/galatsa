// SPDX-License-Identifier: GPL-3.0-or-later

// The JSON result of one benchmark run.

import type { Segment, SegmentKind } from "./camera.ts";
import type { BenchViewport } from "./engine.ts";
import type { MemoryReport } from "./memory.ts";
import type { SceneSummary } from "./scene.ts";
import { type FrameStats, frameStats, type VerdictInputs } from "./stats.ts";
import { STRINGS } from "./strings.ts";

export const RESULT_FORMAT = "galatsa-bench-result";
/**
 * 2: wall-clock frame times, verdictInputs, captures.
 * 3: per-frame main-thread work time, targets judged on any refresh rate, run mode,
 *    memory verdict from the host sampler only.
 */
export const RESULT_VERSION = 3;

export interface TextSharpEvent {
  /** Label of the hold segment in which the camera stood still. */
  readonly label: string;
  /** First frame of the hold segment. */
  readonly frame: number;
  /**
   * The frame in which the camera reached its final pose: the last frame of the
   * movement before the hold. The clock starts there.
   */
  readonly stopFrame: number;
  /**
   * Milliseconds from just before render() of the stop frame to the start of
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
  /**
   * True if nothing covered the stage at the start and at the end (checked with
   * elementFromPoint at its centre and corners).
   */
  readonly unobstructed: boolean;
}

export interface BenchResult {
  readonly format: typeof RESULT_FORMAT;
  readonly version: typeof RESULT_VERSION;
  readonly engine: string;
  /**
   * "timing" for a normal run; "capture" for a run paused at each hold for images,
   * which is never valid for decisions.
   */
  readonly mode: "timing" | "capture";
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
      /** Before the run (see estimateRefresh in stats.ts). */
      readonly intervalMs: number;
      readonly rateHz: number;
      readonly medianMs: number;
      /** Share of calibration samples within 25 % of the median. */
      readonly stableShare: number;
      readonly samples: number;
      /** Calibration attempts needed to get a steady estimate (at most 3). */
      readonly attempts: number;
      /** Measured again after the run; a change of more than 3 % is a problem. */
      readonly afterRunMs: number;
    };
    /** Time waited before the run for the page to become idle and frames steady. */
    readonly settle: {
      readonly ms: number;
      /** Null where the browser has no requestIdleCallback. */
      readonly idleDetected: boolean | null;
      readonly framesSteady: boolean;
    };
    readonly hiddenDuringRun: boolean;
    readonly resizedDuringRun: boolean;
  };
  readonly scene: SceneSummary & {
    /** The original image files. */
    readonly encodedImageBytes: number;
    /** Their reduced-size versions (ImageSource.getReduced), 0 if none were made. */
    readonly encodedReducedImageBytes: number;
  };
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
     * Main-thread time of this frame: from the start of its animation-frame callback
     * to the first task after the browser's rendering step (render(), style, layout,
     * paint). Not rounded to display refreshes.
     */
    readonly workMs: readonly number[];
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
    readonly workMs: FrameStats;
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
  const t = v.targets;
  const env = result.environment;
  const lines = [
    s.run(result.engine, result.mode, v.frames, result.timings.runMs, v.loadMs),
    s.refresh(v.refreshIntervalMs, v.refreshRateHz),
    s.frameTarget(t.frames16_7),
    s.frameTarget(t.frames33),
    s.stalls(t.stalls.count, t.stalls.pass, v.frameMs.max),
    s.textSharp(
      result.textSharp.reported,
      t.textSharp.missing,
      v.textSharp.p50Ms,
      t.textSharp.maxMs,
      t.textSharp.pass,
    ),
    t.memory.pass === null
      ? s.memoryUnavailable
      : s.memory(t.memory.peakBytes ?? 0, t.memory.pass),
    s.refreshes(v.missedRefreshes.count, v.missedRefreshes.ratio, v.longRefreshes.count),
    s.frame(v.frameMs.mean, v.frameMs.p95, v.workMs.p50, v.workMs.p95, v.workMs.max),
    s.render(v.renderMs.p50, v.renderMs.p95, v.renderMs.max),
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
