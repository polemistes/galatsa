// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the camera run against an engine in the browser and measures it. Browser only.
//
// One run:
//   1. settle: wait until the page is idle and frames come at a steady rate, so that
//      garbage from earlier work (image generation, a previous run) does not land in
//      this run;
//   2. calibrate: animation frames with nothing drawing, to measure the display's
//      refresh interval (retried up to three times until steady);
//   3. load the engine (timed);
//   4. warm up: 60 frames at the first pose (not timed);
//   5. the run: one camera pose per animation frame;
//   6. measure the refresh interval again, to catch a display that changed rate.
//
// Two times are recorded per frame:
// - frameMs, the wall-clock interval between the starts of consecutive
//   animation-frame callbacks: what the display paced, in whole refreshes on a
//   vsync-paced display;
// - workMs, the main-thread time of the frame: from the start of its callback to the
//   first task after the browser's rendering step, that is render() plus style,
//   layout and paint. No display rounds it, so it can be judged against a target in
//   milliseconds on any refresh rate. It does not see work on other threads
//   (rasterisation, the GPU); delays there show in frameMs.
// See stats.ts for how the targets use the two. The timestamps the browser passes to
// the callbacks are recorded for reference only: they are display-frame start times,
// not durations.
//
// The page must stay visible and the drawing area must be fully inside the window,
// with nothing in front of it: browsers slow down hidden pages and skip painting what
// is off-screen or covered.

import { type CameraRun, createCameraRun, REFERENCE_VIEWPORT } from "./camera.ts";
import type { BenchEngine, BenchViewport, ImageSource } from "./engine.ts";
import {
  type ExternalMemorySampler,
  externalPeakMemory,
  MemoryRecorder,
} from "./memory.ts";
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
  estimateRefresh,
  frameStats,
  MIN_STABLE_SHARE,
  type RefreshEstimate,
  refreshProblems,
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
   * inline position already. It must be fully inside the window, with nothing in
   * front of it.
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
  /** CSS pixels. Defaults to the reference viewport (see camera.ts). */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Frames rendered at the first pose before timing starts. Default 60. */
  readonly warmupFrames?: number;
  /** Idle frames for measuring the refresh interval. Default 120. */
  readonly calibrationFrames?: number;
  /** Minimum and maximum time to wait for an idle, steady page before the run. Default 2 s and 15 s. */
  readonly settle?: { readonly minMs: number; readonly maxMs: number };
  /** Refuse to run if the stage is not fully visible and unobstructed. Default true. */
  readonly requireVisibleStage?: boolean;
  /** Call measureUserAgentSpecificMemory() before load, after load and after the run. Default true. */
  readonly measureMemory?: boolean;
  /** Time limit for each measureUserAgentSpecificMemory() call. Default 30000 ms. */
  readonly memoryTimeoutMs?: number;
  /** The host's memory sampler; the only source for the memory verdict. */
  readonly memorySampler?: ExternalMemorySampler;
  /** Called at each phase of the run. Must return quickly. */
  readonly onEvent?: (event: BenchEvent) => void;
  /**
   * If given, the run pauses at the end of each hold and calls it; the paused frame
   * is left out of the statistics, and the run is marked as a capture run, not valid
   * for decisions.
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

/**
 * Waits until the page is ready for a run: at least `minMs`; then, where the browser
 * has requestIdleCallback, until five idle callbacks in a row offer 40 ms or more;
 * then until two consecutive windows of 30 frames are steady (90 % near their median,
 * medians within 3 % of each other); three windows where there is no idle callback
 * (WebKit), as frame steadiness is then the only sign. Gives up at `maxMs`.
 */
export async function settle(
  minMs: number,
  maxMs: number,
): Promise<{ ms: number; idleDetected: boolean | null; framesSteady: boolean }> {
  const start = performance.now();
  const timeLeft = () => maxMs - (performance.now() - start);
  await new Promise((resolve) => setTimeout(resolve, minMs));

  const idle = globalThis.requestIdleCallback as typeof requestIdleCallback | undefined;
  let idleDetected: boolean | null = null;
  if (typeof idle === "function") {
    idleDetected = false;
    let streak = 0;
    while (timeLeft() > 0) {
      const remaining = await new Promise<number>((resolve) =>
        idle((deadline) => resolve(deadline.timeRemaining()), { timeout: 1000 }),
      );
      streak = remaining >= 40 ? streak + 1 : 0;
      if (streak >= 5) {
        idleDetected = true;
        break;
      }
    }
  }

  const needed = idleDetected === null ? 3 : 2;
  let steadyWindows = 0;
  let previousMedian = Number.NaN;
  let framesSteady = false;
  do {
    const estimate = estimateRefresh(await sampleFrameTimestamps(30));
    const steady =
      estimate.stableShare >= MIN_STABLE_SHARE &&
      (Number.isNaN(previousMedian) ||
        Math.abs(estimate.medianMs - previousMedian) <= 0.03 * previousMedian);
    steadyWindows = steady ? steadyWindows + 1 : 0;
    previousMedian = estimate.medianMs;
    if (steadyWindows >= needed) {
      framesSteady = true;
      break;
    }
  } while (timeLeft() > 0);
  return { ms: performance.now() - start, idleDetected, framesSteady };
}

/** Measures the refresh interval, retrying up to `attempts` times until steady. */
export async function calibrate(
  frames: number,
  attempts = 3,
): Promise<RefreshEstimate & { attempts: number }> {
  let estimate = estimateRefresh(await sampleFrameTimestamps(frames));
  let tries = 1;
  while (estimate.stableShare < MIN_STABLE_SHARE && tries < attempts) {
    estimate = estimateRefresh(await sampleFrameTimestamps(frames));
    tries++;
  }
  return { ...estimate, attempts: tries };
}

function round3(values: Float64Array): number[] {
  return Array.from(values, (v) => Math.round(v * 1000) / 1000);
}

function measureStage(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const windowWidth = document.documentElement.clientWidth;
  const windowHeight = document.documentElement.clientHeight;
  const inside =
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= windowWidth + 0.5 &&
    rect.bottom <= windowHeight + 0.5;
  // Nothing may be in front of the stage: the topmost element at its centre and
  // near its corners must be the stage or something inside it.
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + 1, rect.top + 1],
    [rect.right - 2, rect.top + 1],
    [rect.left + 1, rect.bottom - 2],
    [rect.right - 2, rect.bottom - 2],
  ] as const;
  const unobstructed =
    typeof document.elementFromPoint !== "function" ||
    points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === container || container.contains(hit));
    });
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    windowWidth,
    windowHeight,
    inside,
    unobstructed,
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
  const mode = options.capture === undefined ? "timing" : "capture";

  const viewport: BenchViewport = {
    width: options.viewport?.width ?? run.viewport?.width ?? REFERENCE_VIEWPORT.width,
    height: options.viewport?.height ?? run.viewport?.height ?? REFERENCE_VIEWPORT.height,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  };
  container.replaceChildren();
  if (!container.style.position) container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  const stageAtStart = measureStage(container);
  if (options.requireVisibleStage !== false) {
    if (!stageAtStart.inside)
      throw new Error(STRINGS.stageNotVisible(viewport.width, viewport.height));
    if (!stageAtStart.unobstructed) throw new Error(STRINGS.stageObstructed);
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

  // Text-sharpness bookkeeping: one entry per hold. The clock starts at the stop
  // frame, the last frame of the movement, which already shows the final pose.
  interface PendingHold {
    readonly label: string;
    readonly frame: number;
    readonly stopFrame: number;
    readonly end: number;
    readonly start: number;
    reportMs: number | null;
    latencyMs: number | null;
    closed: boolean;
  }
  const holds = run.segments.filter((s) => s.kind === "hold");
  const holdByStopFrame = new Map(holds.map((s) => [Math.max(0, s.start - 1), s]));
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

  // Main-thread work per frame: a message posted after render() is delivered as the
  // first task after the browser's rendering step.
  const channel = new MessageChannel();

  try {
    emit("settle-start");
    const settled = await settle(
      options.settle?.minMs ?? 2000,
      options.settle?.maxMs ?? 15000,
    );
    emit("settle-end");

    const timerResolutionMs = estimateTimerResolution();
    emit("calibrate-start");
    const refresh = await calibrate(options.calibrationFrames ?? 120);
    emit("calibrate-end");

    memory.sampleHeap(-1);
    await memory.measure("beforeLoad");

    const n = run.poses.length;
    let currentFrame: number | null = null;
    emit("load-start");
    memory.startPolling(() => currentFrame);
    memory.sampleExternal("load-start", null);
    const loadStart = performance.now();
    await engine.load({ container, viewport, scene, images, reportTextSharp });
    const loadMs = performance.now() - loadStart;
    emit("load-end");
    memory.sampleExternal("load-end", null);

    await memory.measure("afterLoad");

    const frameMs = new Float64Array(n);
    const workMs = new Float64Array(n);
    const timestampMs = new Float64Array(n);
    const renderMs = new Float64Array(n);
    const callbackStart = new Float64Array(n);
    const excluded = new Set<number>();
    const captures: Capture[] = [];
    const firstPose = run.poses[0];
    if (firstPose === undefined) throw new Error("The camera run has no frames");
    let runStart = 0;
    let runEnd = 0;
    channel.port1.onmessage = (message: MessageEvent<number>) => {
      const frame = message.data;
      if (frame >= 0 && frame < n)
        workMs[frame] = performance.now() - (callbackStart[frame] ?? 0);
    };

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
            currentFrame = index;
            callbackStart[index] = callback;
            if (pending !== undefined && index >= pending.end) closePending();
            const stopped = holdByStopFrame.get(index);
            if (stopped !== undefined) {
              closePending();
              pending = {
                label: stopped.label,
                frame: stopped.start,
                stopFrame: index,
                end: stopped.end,
                start: performance.now(),
                reportMs: null,
                latencyMs: null,
                closed: false,
              };
            }
            const hold = holdByStart.get(index);
            if (hold !== undefined) {
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
            channel.port2.postMessage(index);
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
    memory.stopPolling();
    memory.sampleHeap(n);
    const stageAtEnd = measureStage(container);

    const refreshAfter = estimateRefresh(await sampleFrameTimestamps(60));
    await memory.measure("afterRun");
    await memory.settleExternal();

    const stage: StageInfo = {
      x: stageAtStart.x,
      y: stageAtStart.y,
      width: stageAtStart.width,
      height: stageAtStart.height,
      windowWidth: stageAtStart.windowWidth,
      windowHeight: stageAtStart.windowHeight,
      fullyVisible: stageAtStart.inside && stageAtEnd.inside,
      unobstructed: stageAtStart.unobstructed && stageAtEnd.unobstructed,
    };
    const p = STRINGS.problems;
    const problems: string[] = [];
    if (mode === "capture") problems.push(p.capture);
    if (hiddenDuringRun) problems.push(p.hidden);
    if (resizedDuringRun) problems.push(p.resized);
    if (!stage.fullyVisible) problems.push(p.stageNotVisible);
    if (!stage.unobstructed) problems.push(p.stageObstructed);
    if (!settled.framesSteady) problems.push(p.framesNotSteady);
    problems.push(...refreshProblems(refresh));
    if (
      Math.abs(refreshAfter.intervalMs - refresh.intervalMs) >
      0.03 * refresh.intervalMs
    ) {
      problems.push(p.refreshChanged(refresh.intervalMs, refreshAfter.intervalMs));
    }

    const keep = (values: Float64Array) => values.filter((_, i) => !excluded.has(i));
    const events: TextSharpEvent[] = finished.map((h) => ({
      label: h.label,
      frame: h.frame,
      stopFrame: h.stopFrame,
      latencyMs: h.latencyMs,
      reportMs: h.reportMs,
    }));
    const textSharp = summarizeTextSharp(events);
    const memoryReport = memory.report();

    return {
      format: RESULT_FORMAT,
      version: RESULT_VERSION,
      engine: engine.name,
      mode,
      startedAt,
      verdictInputs: verdictInputs({
        refreshIntervalMs: refresh.intervalMs,
        frameMs: keep(frameMs),
        workMs: keep(workMs),
        renderMs: keep(renderMs),
        textSharp: {
          p50Ms: textSharp.p50Ms,
          maxMs: textSharp.maxMs,
          missing: textSharp.missing,
        },
        loadMs,
        peakMemory: externalPeakMemory(memoryReport),
        problems,
      }),
      environment: {
        userAgent: navigator.userAgent,
        viewport,
        stage,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        timerResolutionMs,
        refresh: {
          intervalMs: refresh.intervalMs,
          rateHz: 1000 / refresh.intervalMs,
          medianMs: refresh.medianMs,
          stableShare: refresh.stableShare,
          samples: refresh.samples,
          attempts: refresh.attempts,
          afterRunMs: refreshAfter.intervalMs,
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
        workMs: round3(workMs),
        frameMs: round3(frameMs),
        timestampMs: round3(timestampMs),
        renderMs: round3(renderMs),
        excluded: [...excluded].sort((a, b) => a - b),
      },
      stats: {
        frameMs: frameStats(keep(frameMs)),
        workMs: frameStats(keep(workMs)),
        timestampMs: frameStats(keep(timestampMs)),
        renderMs: frameStats(keep(renderMs)),
        frameMsByKind: statsByKind(frameMs, run.segments, excluded),
      },
      textSharp,
      memory: memoryReport,
      captures,
    };
  } finally {
    memory.stopPolling();
    channel.port1.close();
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener?.("resize", onResize);
    engine.dispose();
    container.replaceChildren();
  }
}
