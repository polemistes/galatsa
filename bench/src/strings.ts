// SPDX-License-Identifier: GPL-3.0-or-later

// Every piece of text that the bench shows to people (the harness page and the
// result summary), in one place, so that it can move to the translation files once
// they exist. English only for now. JSON field names and error messages for
// developers are not listed here.

import type { FrameTargetCheck } from "./stats.ts";

const ms = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(2)} ms`);
const mb = (v: number | null): string =>
  v === null ? "n/a" : `${(v / 1e6).toFixed(1)} MB`;
const pct = (ratio: number): string => `${(ratio * 100).toFixed(2)} %`;
const verdict = (pass: boolean | null): string =>
  pass === null ? "cannot judge" : pass ? "PASS" : "FAIL";

export const STRINGS = {
  pageTitle: "Galatsa benchmark",
  engineLabel: "Engine",
  runButton: "Run",
  runTwiceButton: "Run twice and compare",
  captureButton: "Run with captures",
  downloadButton: "Download JSON",
  statusIdle: "Ready.",
  statusGenerating: (done: number, total: number) =>
    `Generating images: ${done} / ${total}`,
  statusSettling: "Waiting for the page to become idle…",
  statusCalibrating: "Measuring the display's refresh rate…",
  statusMeasuringMemory: "Measuring memory…",
  statusLoading: "Loading the scene into the engine…",
  statusRunning: (run: number, runs: number) =>
    `Running ${run} of ${runs}. Keep this window visible and do not touch it.`,
  statusDone: "Done.",
  statusFailed: (message: string) => `Failed: ${message}`,
  stageNotVisible: (width: number, height: number) =>
    `The ${width} x ${height} drawing area does not fit in the window. Make the window larger (or choose a smaller size with ?width= and ?height=) and run again.`,
  stageObstructed:
    "Something covers the drawing area. Scroll to the top of the page and close anything in front of it, then run again.",
  capturesNote:
    "Captures pause the run at the end of each hold, so this run shows what was drawn but is not valid for timing.",
  comparisonTitle: (agree: boolean) =>
    `Comparison: ${agree ? "both runs reach the same verdict on every target" : "the runs reach DIFFERENT verdicts"}`,
  comparisonVerdictRow: (
    target: string,
    a: boolean | null,
    b: boolean | null,
    valueA: number | null,
    valueB: number | null,
  ) =>
    `${target}: ${verdict(a)} / ${verdict(b)} (${valueA === null ? "n/a" : valueA.toFixed(4)} / ${valueB === null ? "n/a" : valueB.toFixed(4)})`,
  comparisonDeltasTitle: (tolerance: number) =>
    `Raw differences (for information; allowed ${(tolerance * 100).toFixed(0)} % or an absolute floor):`,
  comparisonRow: (name: string, a: number, b: number, allowed: number, within: boolean) =>
    `${within ? " " : "!"} ${name}: ${a.toFixed(3)} / ${b.toFixed(3)} (difference ${Math.abs(a - b).toFixed(3)}, allowed ${allowed.toFixed(3)})`,

  summary: {
    run: (engine: string, mode: string, frames: number, runMs: number, loadMs: number) =>
      `engine ${engine} (${mode} run), ${frames} frames, run ${ms(runMs)}, load ${ms(loadMs)}`,
    refresh: (intervalMs: number, rateHz: number) =>
      `display refresh ${ms(intervalMs)} (${rateHz.toFixed(1)} Hz)`,
    frameTarget: (t: FrameTargetCheck) =>
      `frames over ${t.thresholdMs} ms: ${t.count} (${pct(t.ratio)}, target at most ${pct(t.maxRatio)}): ${verdict(t.pass)}; judged by ${t.judgedBy} (work ${t.workOver}${t.presentedOver === null ? "" : `, display ${t.presentedOver} over ${ms(t.presentedThresholdMs)}`})`,
    stalls: (count: number, pass: boolean, max: number) =>
      `frames over 100 ms: ${count}, longest ${ms(max)}: ${verdict(pass)}`,
    textSharp: (
      reported: number,
      missing: number,
      p50: number | null,
      max: number | null,
      pass: boolean,
    ) =>
      `text sharp after stop: ${reported} reported, ${missing} missing, p50 ${ms(p50)}, max ${ms(max)} (target at most 200 ms): ${verdict(pass)}`,
    memory: (bytes: number, pass: boolean) =>
      `memory peak (host sampler) ${mb(bytes)} (target at most 1500 MB): ${verdict(pass)}`,
    memoryUnavailable:
      "memory: cannot judge without a host memory sampler (the page cannot see the program's memory)",
    refreshes: (missed: number, ratio: number, long: number) =>
      `on this display: ${missed} frames missed a refresh (${pct(ratio)}), ${long} took over 2.5 refreshes`,
    frame: (
      mean: number,
      p95: number,
      workP50: number,
      workP95: number,
      workMax: number,
    ) =>
      `frame interval mean ${ms(mean)}, p95 ${ms(p95)}; main-thread work p50 ${ms(workP50)}, p95 ${ms(workP95)}, max ${ms(workMax)}`,
    render: (p50: number, p95: number, max: number) =>
      `render() p50 ${ms(p50)}, p95 ${ms(p95)}, max ${ms(max)}`,
    environment: (width: number, height: number, dpr: number, timerStep: number) =>
      `drawing area ${width} x ${height} CSS px at ${dpr}x, timer step ${timerStep} ms`,
    problem: (text: string) => `NOT VALID FOR A DECISION: ${text}`,
  },

  problems: {
    hidden: "the page was hidden during the run",
    resized: "the window was resized during the run",
    stageNotVisible: "the drawing area was not fully inside the window",
    stageObstructed: "something covered the drawing area",
    capture: "capture run: the run paused at each hold to take images",
    refreshChanged: (before: number, after: number) =>
      `the refresh interval changed during the run (${before.toFixed(2)} ms before, ${after.toFixed(2)} ms after)`,
    framesNotSteady: "the frame rate did not become steady before the run",
    refreshUnmeasured: "the refresh rate could not be measured",
    refreshUnsteady: (share: number) =>
      `the refresh interval was not steady while idle (${(share * 100).toFixed(0)} % of frames near the median)`,
    refreshLowPower: (hz: number) =>
      `the display refreshed at about ${hz.toFixed(0)} Hz, as in a low-power mode`,
    refreshUnusual: (hz: number) =>
      `the measured refresh rate ${hz.toFixed(1)} Hz is not a usual display rate`,
  },
} as const;
