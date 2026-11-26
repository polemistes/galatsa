// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the camera run against an engine in the browser and measures it. Browser only.
//
// One run:
//   1. settle: wait (at least 2 s) until the page is idle, so that garbage from
//      earlier work (image generation, a previous run) does not land in this run;
//   2. calibrate: 120 animation frames with nothing drawing, to measure the
//      display's refresh interval;
//   3. load the engine (timed);
//   4. warm up: 60 frames at the first pose (not timed);
//   5. the run: one camera pose per animation frame.
//
// Frame time is the wall-clock interval between the starts of consecutive
// animation-frame callbacks (performance.now()). It covers everything between two
// frames on the main thread: the engine's render(), any work it schedules, and the
// browser's style, layout and paint. The timestamps the browser passes to the
// callbacks are recorded too, but they are display-frame start times, not
// durations: a frame that blocks 40 ms reads 33.3 ms in Chromium at 60 Hz, and they
// jitter in Firefox and WebKitGTK. Missed and long frames are therefore counted from
// the wall-clock times, against thresholds relative to the measured refresh
// interval (see stats.ts).
//
// The page must stay visible and the drawing area must be fully inside the window:
// browsers slow down hidden pages and skip painting what is off-screen.

import { type CameraRun, createCameraRun } from "./camera.ts";
import type { BenchEngine, BenchViewport, ImageSource } from "./engine.ts";
import { bestPeakMemory, type ExternalMemorySampler, MemoryRecorder } from "./memory.ts";
import {
  type BenchResult,
  type Capture,
  RESULT_FORMAT,
  RESULT_VERSION,
  type StageInfo,
  statsByKind,
  summarizeTextSharp,
  type TextSharpEvent,
} from "./result.ts";
import { generateScene, type Scene, summarizeScene } from "./scene.ts";
import {
  estimateRefreshInterval,
  frameStats,
  percentile,
  verdictInputs,
} from "./stats.ts";
import { STRINGS } from "./strings.ts";

export type BenchEventType =
  | "settle-start"
  | "settle-end"
  | "calibrate-start"
  | "calibrate-end"
  | "load-start"
  | "load-end"
  | "run-start"
  | "hold-start"
  | "hold-end"
  | "run-end";

/**
 * A point in a run, for a host that wants to act at the right moment (for example
 * to sample the memory of the browser's processes from outside).
 */
export interface BenchEvent {
  readonly type: BenchEventType;
  /** performance.now() when it happened. */
  readonly time: number;
  /** Frame index for hold events, otherwise null. */
  readonly frame: number | null;
  /** Hold label for hold events, otherwise null. */
  readonly label: string | null;
}

/** Takes an image of the stage at the end of a hold, while the run is paused. */
export type CaptureFunction = (hold: {
  readonly label: string;
  readonly frame: number;
}) => Promise<Capture | null>;

export interface RunOptions {
  readonly engine: BenchEngine;
  /**
   * Element the engine draws in. The runner empties it, sizes it to the viewport,
   * sets `overflow: hidden`, and sets `position: relative` unless the element has an
   * inline position already. It must be fully inside the window.
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
  /** Idle frames for measuring the refresh interval. Default 120. */
  readonly calibrationFrames?: number;
  /** Minimum and maximum time to wait for an idle page before the run. Default 2 s and 10 s. */
  readonly settle?: { readonly minMs: number; readonly maxMs: number };
  /** Refuse to run if the stage is not fully inside the window. Default true. */
  readonly requireVisibleStage?: boolean;
  /** Call measureUserAgentSpecificMemory() before load, after load and after the run. Default true. */
  readonly measureMemory?: boolean;
  /** Time limit for each measureUserAgentSpecificMemory() call. Default 30000 ms. */
  readonly memoryTimeoutMs?: number;
  /** Sampled at load, run start, each hold start and run end, without waiting. */
  readonly memorySampler?: ExternalMemorySampler;
  /** Called at each phase of the run. Must return quickly. */
  readonly onEvent?: (event: BenchEvent) => void;
  /**
   * If given, the run pauses at the end of each hold and calls it; the paused frame
   * is left out of the statistics. Use for a run to look at, not for timing.
   */
  readonly capture?: CaptureFunction;
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

/**
 * Waits at least `minMs`, then until five idle callbacks in a row offer 40 ms or more
 * (the page has nothing to do), or until `maxMs` has passed. Browsers without
 * requestIdleCallback (Safari) only wait `minMs`.
 */
export async function settle(
  minMs: number,
  maxMs: number,
): Promise<{ ms: number; idleDetected: boolean }> {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, minMs));
  const idle = globalThis.requestIdleCallback as typeof requestIdleCallback | undefined;
  if (typeof idle !== "function")
    return { ms: performance.now() - start, idleDetected: false };
  let streak = 0;
  while (performance.now() - start < maxMs) {
    const remaining = await new Promise<number>((resolve) =>
      idle((deadline) => resolve(deadline.timeRemaining()), { timeout: 1000 }),
    );
    streak = remaining >= 40 ? streak + 1 : 0;
    if (streak >= 5) return { ms: performance.now() - start, idleDetected: true };
  }
  return { ms: performance.now() - start, idleDetected: false };
}

/** Animation-frame timestamp differences over `frames` idle frames. */
export function sampleFrameTimestamps(frames: number): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let previous: number | undefined;
    const step = (timestamp: number) => {
      if (previous !== undefined) deltas.push(timestamp - previous);
      previous = timestamp;
      if (deltas.length >= frames) resolve(deltas);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function round3(values: Float64Array): number[] {
  return Array.from(values, (v) => Math.round(v * 1000) / 1000);
}

function measureStage(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const windowWidth = document.documentElement.clientWidth;
  const windowHeight = document.documentElement.clientHeight;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    windowWidth,
    windowHeight,
    inside:
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= windowWidth + 0.5 &&
      rect.bottom <= windowHeight + 0.5,
  };
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
    options.memorySampler,
  );
  const emit = (
    type: BenchEventType,
    frame: number | null = null,
    label: string | null = null,
  ) => options.onEvent?.({ type, time: performance.now(), frame, label });
  const startedAt = new Date().toISOString();

  const viewport: BenchViewport = {
    width: options.viewport?.width ?? 1280,
    height: options.viewport?.height ?? 720,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  };
  container.replaceChildren();
  if (!container.style.position) container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  const stageAtStart = measureStage(container);
  if (!stageAtStart.inside && options.requireVisibleStage !== false) {
    throw new Error(STRINGS.stageNotVisible(viewport.width, viewport.height));
  }

  let hiddenDuringRun = document.visibilityState !== "visible";
  let resizedDuringRun = false;
  const onVisibility = () => {
    if (document.visibilityState !== "visible") hiddenDuringRun = true;
  };
  const onResize = () => {
    resizedDuringRun = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener?.("resize", onResize);

  // Text-sharpness bookkeeping: one entry per hold segment.
  interface PendingHold {
    readonly label: string;
    readonly frame: number;
    readonly end: number;
    readonly start: number;
    reportMs: number | null;
    latencyMs: number | null;
    closed: boolean;
  }
  const holds = run.segments.filter((s) => s.kind === "hold");
  const holdByStart = new Map(holds.map((s) => [s.start, s]));
  const holdByLastFrame = new Map(holds.map((s) => [s.end - 1, s]));
  const finished: PendingHold[] = [];
  let pending: PendingHold | undefined;
  const closePending = () => {
    if (pending === undefined) return;
    pending.closed = true;
    finished.push(pending);
    emit("hold-end", pending.frame, pending.label);
    pending = undefined;
  };
  const reportTextSharp = () => {
    const hold = pending;
    if (hold === undefined || hold.reportMs !== null) return;
    hold.reportMs = performance.now() - hold.start;
    // Stop the clock when the browser starts the next frame, after it has had the
    // chance to show what the engine drew.
    requestAnimationFrame(() => {
      if (!hold.closed) hold.latencyMs = performance.now() - hold.start;
    });
  };

  try {
    emit("settle-start");
    const settled = await settle(
      options.settle?.minMs ?? 2000,
      options.settle?.maxMs ?? 10000,
    );
    emit("settle-end");

    const timerResolutionMs = estimateTimerResolution();
    emit("calibrate-start");
    const calibration = await sampleFrameTimestamps(options.calibrationFrames ?? 120);
    const refreshIntervalMs = estimateRefreshInterval(calibration);
    emit("calibrate-end");

    memory.sampleHeap(-1);
    await memory.measure("beforeLoad");

    emit("load-start");
    memory.sampleExternal("load-start", null);
    const loadStart = performance.now();
    await engine.load({ container, viewport, scene, images, reportTextSharp });
    const loadMs = performance.now() - loadStart;
    emit("load-end");
    memory.sampleExternal("load-end", null);

    await memory.measure("afterLoad");

    const n = run.poses.length;
    const frameMs = new Float64Array(n);
    const timestampMs = new Float64Array(n);
    const renderMs = new Float64Array(n);
    const excluded = new Set<number>();
    const captures: Capture[] = [];
    const firstPose = run.poses[0];
    if (firstPose === undefined) throw new Error("The camera run has no frames");
    let runStart = 0;
    let runEnd = 0;

    await new Promise<void>((resolve, reject) => {
      let index = -warmupFrames;
      let previousTimestamp: number | undefined;
      let previousCallback = 0;
      const step = (timestamp: number) => {
        const callback = performance.now();
        try {
          const previous = index - 1;
          if (previous >= 0 && previousTimestamp !== undefined) {
            frameMs[previous] = callback - previousCallback;
            timestampMs[previous] = timestamp - previousTimestamp;
          }
          previousTimestamp = timestamp;
          previousCallback = callback;
          if (index >= n) {
            runEnd = callback;
            resolve();
            return;
          }
          if (index === 0) {
            runStart = callback;
            emit("run-start");
            memory.sampleExternal("run-start", 0);
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
                reportMs: null,
                latencyMs: null,
                closed: false,
              };
              emit("hold-start", index, hold.label);
              memory.sampleExternal("hold-start", index);
            }
          }
          const pose = index < 0 ? firstPose : run.poses[index]!;
          const t0 = performance.now();
          engine.render(pose);
          const t1 = performance.now();
          const captureHold =
            index >= 0 && options.capture !== undefined
              ? holdByLastFrame.get(index)
              : undefined;
          if (index >= 0) {
            renderMs[index] = t1 - t0;
            if (index % HEAP_SAMPLE_EVERY === 0) memory.sampleHeap(index);
          }
          const frame = index;
          index++;
          if (captureHold !== undefined && options.capture !== undefined) {
            // Pause: this frame's interval includes the capture, so leave it out.
            excluded.add(frame);
            options
              .capture({ label: captureHold.label, frame })
              .then(
                (image) => {
                  if (image !== null) captures.push(image);
                },
                () => {},
              )
              .finally(() => requestAnimationFrame(step));
          } else {
            requestAnimationFrame(step);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      requestAnimationFrame(step);
    });
    closePending();
    emit("run-end");
    memory.sampleExternal("run-end", n);
    memory.sampleHeap(n);

    await memory.measure("afterRun");
    await memory.settleExternal();

    const stageAtEnd = measureStage(container);
    const stage: StageInfo = {
      x: stageAtStart.x,
      y: stageAtStart.y,
      width: stageAtStart.width,
      height: stageAtStart.height,
      windowWidth: stageAtStart.windowWidth,
      windowHeight: stageAtStart.windowHeight,
      fullyVisible: stageAtStart.inside && stageAtEnd.inside,
    };
    const problems: string[] = [];
    if (hiddenDuringRun) problems.push(STRINGS.problems.hidden);
    if (resizedDuringRun) problems.push(STRINGS.problems.resized);
    if (!stage.fullyVisible) problems.push(STRINGS.problems.stageNotVisible);

    const keep = (values: Float64Array) => values.filter((_, i) => !excluded.has(i));
    const events: TextSharpEvent[] = finished.map((h) => ({
      label: h.label,
      frame: h.frame,
      latencyMs: h.latencyMs,
      reportMs: h.reportMs,
    }));
    const textSharp = summarizeTextSharp(events);
    const memoryReport = memory.report();
    const sortedCalibration = Float64Array.from(calibration).sort();

    return {
      format: RESULT_FORMAT,
      version: RESULT_VERSION,
      engine: engine.name,
      startedAt,
      verdictInputs: verdictInputs({
        refreshIntervalMs,
        frameMs: keep(frameMs),
        renderMs: keep(renderMs),
        textSharp: {
          p50Ms: textSharp.p50Ms,
          maxMs: textSharp.maxMs,
          missing: textSharp.missing,
        },
        loadMs,
        peakMemory: bestPeakMemory(memoryReport),
        problems,
      }),
      environment: {
        userAgent: navigator.userAgent,
        viewport,
        stage,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        timerResolutionMs,
        refresh: {
          intervalMs: refreshIntervalMs,
          rateHz: 1000 / refreshIntervalMs,
          medianMs: percentile(sortedCalibration, 50),
          samples: calibration.length,
        },
        settle: settled,
        hiddenDuringRun,
        resizedDuringRun,
      },
      scene: { ...summarizeScene(scene), encodedImageBytes: images.encodedBytes },
      cameraRun: { frames: n, segments: run.segments },
      timings: {
        imageGenerationMs: images.generationMs,
        loadMs,
        warmupFrames,
        runMs: runEnd - runStart,
      },
      frames: {
        frameMs: round3(frameMs),
        timestampMs: round3(timestampMs),
        renderMs: round3(renderMs),
        excluded: [...excluded].sort((a, b) => a - b),
      },
      stats: {
        frameMs: frameStats(keep(frameMs)),
        timestampMs: frameStats(keep(timestampMs)),
        renderMs: frameStats(keep(renderMs)),
        frameMsByKind: statsByKind(frameMs, run.segments, excluded),
      },
      textSharp,
      memory: memoryReport,
      captures,
    };
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener?.("resize", onResize);
    engine.dispose();
    container.replaceChildren();
  }
}
