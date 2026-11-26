// SPDX-License-Identifier: GPL-3.0-or-later

// The JSON result of one benchmark run.

import type { Segment, SegmentKind } from "./camera.ts";
import type { BenchViewport } from "./engine.ts";
import type { MemoryReport } from "./memory.ts";
import type { SceneSummary } from "./scene.ts";
import { type FrameStats, frameStats } from "./stats.ts";
import { STRINGS } from "./strings.ts";

export const RESULT_FORMAT = "galatsa-bench-result";
export const RESULT_VERSION = 1;

export interface TextSharpEvent {
  /** Label of the hold segment in which the camera stood still. */
  readonly label: string;
  /** First frame of the hold. */
  readonly frame: number;
  /**
   * Milliseconds from just before render() of the first still frame to the engine's
   * first reportTextSharp() call after it, or null if the engine did not call it
   * before the camera moved again.
   */
  readonly latencyMs: number | null;
}

export interface BenchResult {
  readonly format: typeof RESULT_FORMAT;
  readonly version: typeof RESULT_VERSION;
  readonly engine: string;
  /** Wall-clock start time (ISO 8601). Metadata only. */
  readonly startedAt: string;
  readonly environment: {
    readonly userAgent: string;
    readonly viewport: BenchViewport;
    readonly crossOriginIsolated: boolean;
    /** Smallest step of performance.now() seen; frame times are no finer than this. */
    readonly timerResolutionMs: number;
    /** Median frame interval during warm-up: about the display's refresh interval. */
    readonly warmupIntervalMs: number | null;
    /** True if the page was hidden at some point; the frame times are then not valid. */
    readonly hiddenDuringRun: boolean;
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
    /** Sum of all frame intervals. */
    readonly runMs: number;
  };
  /** Per frame, in run order. */
  readonly frames: {
    /** From this frame's animation frame callback to the next one. */
    readonly intervalMs: readonly number[];
    /** Time spent in engine.render() for this frame. */
    readonly scriptMs: readonly number[];
  };
  readonly stats: {
    readonly interval: FrameStats;
    readonly script: FrameStats;
    /** Frame intervals grouped by segment kind. */
    readonly intervalByKind: Readonly<Partial<Record<SegmentKind, FrameStats>>>;
  };
  readonly textSharp: {
    readonly events: readonly TextSharpEvent[];
    readonly reported: number;
    readonly missing: number;
    /** Over the reported events; null if none were reported. */
    readonly p50Ms: number | null;
    readonly maxMs: number | null;
  };
  readonly memory: MemoryReport;
}

/** Frame stats per segment kind. */
export function statsByKind(
  values: ArrayLike<number>,
  segments: readonly Segment[],
): Partial<Record<SegmentKind, FrameStats>> {
  const groups = new Map<SegmentKind, number[]>();
  for (const segment of segments) {
    let group = groups.get(segment.kind);
    if (group === undefined) groups.set(segment.kind, (group = []));
    for (let i = segment.start; i < segment.end && i < values.length; i++) {
      group.push(values[i] as number);
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
  const i = result.stats.interval;
  const ua = result.memory.userAgentSpecific;
  const heap = result.memory.jsHeap;
  const env = result.environment;
  const lines = [
    s.run(result.engine, i.count, result.timings.runMs, result.timings.loadMs),
    s.interval(i.mean, i.p50, i.p95, i.p99, i.max),
    s.over(Object.entries(i.over)),
    s.script(result.stats.script.mean, result.stats.script.p95),
    s.textSharp(
      result.textSharp.reported,
      result.textSharp.missing,
      result.textSharp.p50Ms,
      result.textSharp.maxMs,
    ),
    ua.available
      ? s.uaMemory(ua.afterLoadBytes, ua.afterRunBytes)
      : s.uaMemoryUnavailable(ua.note),
    heap.available ? s.heapMemory(heap.peakUsedBytes) : s.heapMemoryUnavailable,
    s.environment(
      env.viewport.width,
      env.viewport.height,
      env.viewport.devicePixelRatio,
      env.timerResolutionMs,
    ),
  ];
  if (env.hiddenDuringRun) lines.push(STRINGS.hiddenWarning);
  return lines.join("\n");
}
