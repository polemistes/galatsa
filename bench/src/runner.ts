// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the camera run against an engine in the browser and measures it. Browser only.
//
// Frame time is the interval between consecutive requestAnimationFrame callbacks.
// It covers everything between two frames: the engine's render(), any work the
// engine schedules, and the browser's style, layout, paint and compositing, as
// paced by the display. Two versions are recorded per frame:
//
// - intervalMs: difference of the timestamps the browser passes to the callbacks.
//   Browsers set these to the start of the display frame (vsync), so they have no
//   scheduling jitter and count dropped display frames well. But a long frame is
//   rounded down to a whole number of display frames: in Chromium, a frame that
//   blocks for 40 ms reads as 33.3 ms at 60 Hz.
// - callbackIntervalMs: difference of performance.now() at the start of the
//   callbacks. Wall-clock time, so long stalls show at their real length, but with
//   some jitter around the display interval.
//
// Time spent in render() itself is recorded separately.
//
// The page must stay visible: browsers pause or slow down animation frames in
// hidden tabs. A result whose page was hidden is marked.

import { type CameraRun, createCameraRun } from "./camera.ts";
import type { BenchEngine, BenchViewport, ImageSource } from "./engine.ts";
import { MemoryRecorder } from "./memory.ts";
import {
  type BenchResult,
  RESULT_FORMAT,
  RESULT_VERSION,
  statsByKind,
  summarizeTextSharp,
  type TextSharpEvent,
} from "./result.ts";
import { generateScene, type Scene, summarizeScene } from "./scene.ts";
import { frameStats, percentile } from "./stats.ts";

export interface RunOptions {
  readonly engine: BenchEngine;
  /**
   * Element the engine draws in. The runner empties it, sizes it to the viewport and
   * sets `position: relative; overflow: hidden`.
   */
  readonly container: HTMLElement;
  /** The scene's encoded images, from prepareImages(). */
  readonly images: ImageSource & {
    readonly encodedBytes: number;
    readonly generationMs: number;
  };
  /** Defaults to generateScene(). Must be the scene the images were made for. */
  readonly scene?: Scene;
  /** Defaults to createCameraRun(scene). */
  readonly cameraRun?: CameraRun;
  /** CSS pixels. Defaults to the reference viewport, 1280 x 720. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Frames rendered at the first pose before timing starts. Default 60. */
  readonly warmupFrames?: number;
  /** Call measureUserAgentSpecificMemory() before load, after load and after the run. Default true. */
  readonly measureMemory?: boolean;
  /** Time limit for each measureUserAgentSpecificMemory() call. Default 30000 ms. */
  readonly memoryTimeoutMs?: number;
  /** Called when the runner moves to a new phase, for status display. */
  readonly onPhase?: (phase: "memory" | "load" | "run") => void;
}

/** Sample performance.memory every this many frames. */
const HEAP_SAMPLE_EVERY = 30;

/** Smallest positive step of performance.now(), from a short busy loop. */
export function estimateTimerResolution(samples = 20): number {
  let smallest = Infinity;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    let next = performance.now();
    const giveUp = start + 50;
    while (next === start && next < giveUp) next = performance.now();
    if (next > start) smallest = Math.min(smallest, next - start);
  }
  return Number.isFinite(smallest) ? Math.round(smallest * 1e6) / 1e6 : Number.NaN;
}

function round3(values: Float64Array): number[] {
  return Array.from(values, (v) => Math.round(v * 1000) / 1000);
}

/** Runs the benchmark once and returns its result. */
export async function runBenchmark(options: RunOptions): Promise<BenchResult> {
  const { engine, container, images } = options;
  const scene = options.scene ?? generateScene();
  const run = options.cameraRun ?? createCameraRun(scene);
  const warmupFrames = options.warmupFrames ?? 60;
  const memory = new MemoryRecorder(
    options.measureMemory ?? true,
    options.memoryTimeoutMs ?? 30000,
  );
  const startedAt = new Date().toISOString();

  const viewport: BenchViewport = {
    width: options.viewport?.width ?? 1280,
    height: options.viewport?.height ?? 720,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  };
  container.replaceChildren();
  container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;

  let hiddenDuringRun = document.visibilityState !== "visible";
  const onVisibility = () => {
    if (document.visibilityState !== "visible") hiddenDuringRun = true;
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Text-sharpness events: one per hold segment.
  const holds = run.segments.filter((s) => s.kind === "hold");
  const holdByStart = new Map(holds.map((s) => [s.start, s]));
  const events: TextSharpEvent[] = [];
  let pending: { label: string; frame: number; end: number; start: number } | undefined;
  let pendingLatency: number | null = null;
  const closePending = () => {
    if (pending === undefined) return;
    events.push({
      label: pending.label,
      frame: pending.frame,
      latencyMs: pendingLatency,
    });
    pending = undefined;
    pendingLatency = null;
  };
  const reportTextSharp = () => {
    if (pending !== undefined && pendingLatency === null) {
      pendingLatency = performance.now() - pending.start;
    }
  };

  try {
    const timerResolutionMs = estimateTimerResolution();

    options.onPhase?.("memory");
    memory.sampleHeap(-1);
    await memory.measure("beforeLoad");

    options.onPhase?.("load");
    const loadStart = performance.now();
    await engine.load({ container, viewport, scene, images, reportTextSharp });
    const loadMs = performance.now() - loadStart;

    options.onPhase?.("memory");
    await memory.measure("afterLoad");

    options.onPhase?.("run");
    const n = run.poses.length;
    const intervals = new Float64Array(n);
    const callbackIntervals = new Float64Array(n);
    const scriptMs = new Float64Array(n);
    const warmupIntervals: number[] = [];
    const firstPose = run.poses[0];
    if (firstPose === undefined) throw new Error("The camera run has no frames");

    await new Promise<void>((resolve, reject) => {
      let index = -warmupFrames;
      let previousTimestamp: number | undefined;
      let previousCallback = 0;
      const step = (timestamp: number) => {
        const callback = performance.now();
        try {
          const previous = index - 1;
          if (previousTimestamp !== undefined) {
            if (previous >= 0) {
              intervals[previous] = timestamp - previousTimestamp;
              callbackIntervals[previous] = callback - previousCallback;
            } else {
              warmupIntervals.push(timestamp - previousTimestamp);
            }
          }
          previousTimestamp = timestamp;
          previousCallback = callback;
          if (index >= n) {
            resolve();
            return;
          }
          if (index >= 0) {
            if (pending !== undefined && index >= pending.end) closePending();
            const hold = holdByStart.get(index);
            if (hold !== undefined) {
              pending = {
                label: hold.label,
                frame: index,
                end: hold.end,
                start: performance.now(),
              };
            }
          }
          const pose = index < 0 ? firstPose : run.poses[index]!;
          const t0 = performance.now();
          engine.render(pose);
          const t1 = performance.now();
          if (index >= 0) {
            scriptMs[index] = t1 - t0;
            if (index % HEAP_SAMPLE_EVERY === 0) memory.sampleHeap(index);
          }
          index++;
          requestAnimationFrame(step);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      requestAnimationFrame(step);
    });
    closePending();
    memory.sampleHeap(n);

    options.onPhase?.("memory");
    await memory.measure("afterRun");

    const sortedWarmup = Float64Array.from(warmupIntervals).sort();
    const runMs = intervals.reduce((sum, v) => sum + v, 0);
    return {
      format: RESULT_FORMAT,
      version: RESULT_VERSION,
      engine: engine.name,
      startedAt,
      environment: {
        userAgent: navigator.userAgent,
        viewport,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        timerResolutionMs,
        warmupIntervalMs: sortedWarmup.length > 0 ? percentile(sortedWarmup, 50) : null,
        hiddenDuringRun,
      },
      scene: { ...summarizeScene(scene), encodedImageBytes: images.encodedBytes },
      cameraRun: { frames: n, segments: run.segments },
      timings: {
        imageGenerationMs: images.generationMs,
        loadMs,
        warmupFrames,
        runMs,
      },
      frames: {
        intervalMs: round3(intervals),
        callbackIntervalMs: round3(callbackIntervals),
        scriptMs: round3(scriptMs),
      },
      stats: {
        interval: frameStats(intervals),
        callbackInterval: frameStats(callbackIntervals),
        script: frameStats(scriptMs),
        intervalByKind: statsByKind(intervals, run.segments),
      },
      textSharp: summarizeTextSharp(events),
      memory: memory.report(),
    };
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
    engine.dispose();
    container.replaceChildren();
  }
}
