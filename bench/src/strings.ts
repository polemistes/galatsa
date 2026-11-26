// SPDX-License-Identifier: GPL-3.0-or-later

// Every piece of text that the bench shows to people (the harness page and the
// result summary), in one place, so that it can move to the translation files once
// they exist. English only for now. JSON field names and error messages for
// developers are not listed here.

const ms = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(2)} ms`);
const mb = (v: number | null): string =>
  v === null ? "n/a" : `${(v / 1e6).toFixed(1)} MB`;
const pct = (ratio: number): string => `${(ratio * 100).toFixed(2)} %`;

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
  capturesNote:
    "Captures pause the run at the end of each hold, so use this run to look at the images, not for timing.",
  comparisonTitle: (tolerance: number, agree: boolean) =>
    `Comparison (tolerance ${(tolerance * 100).toFixed(0)} % or an absolute floor): ${agree ? "the runs agree" : "the runs DIFFER"}`,
  comparisonRow: (
    name: string,
    a: number,
    b: number,
    allowed: number,
    decisive: boolean,
  ) =>
    `${decisive ? "*" : " "} ${name}: ${a.toFixed(3)} / ${b.toFixed(3)} (difference ${Math.abs(a - b).toFixed(3)}, allowed ${allowed.toFixed(3)})`,
  comparisonFootnote: "* decides whether the runs agree",

  summary: {
    run: (engine: string, frames: number, runMs: number, loadMs: number) =>
      `engine ${engine}, ${frames} frames, run ${ms(runMs)}, load ${ms(loadMs)}`,
    refresh: (intervalMs: number, rateHz: number) =>
      `display refresh ${ms(intervalMs)} (${rateHz.toFixed(1)} Hz)`,
    missed: (count: number, ratio: number, thresholdMs: number) =>
      `missed frames (over ${ms(thresholdMs)}): ${count} (${pct(ratio)})`,
    long: (count: number, ratio: number, thresholdMs: number) =>
      `long frames (over ${ms(thresholdMs)}): ${count} (${pct(ratio)})`,
    at60Hz: (missedRatio: number, longRatio: number) =>
      `against a 60 Hz display: missed ${pct(missedRatio)}, long ${pct(longRatio)}`,
    stalls: (count: number, max: number) =>
      `frames over 100 ms: ${count}, longest ${ms(max)}`,
    frame: (mean: number, p50: number, p95: number, p99: number) =>
      `frame time mean ${ms(mean)}, p50 ${ms(p50)}, p95 ${ms(p95)}, p99 ${ms(p99)}`,
    render: (p50: number, p95: number, p99: number, max: number) =>
      `render() p50 ${ms(p50)}, p95 ${ms(p95)}, p99 ${ms(p99)}, max ${ms(max)}`,
    textSharp: (
      reported: number,
      missing: number,
      p50: number | null,
      max: number | null,
    ) =>
      `text sharp after stop: ${reported} reported, ${missing} missing, p50 ${ms(p50)}, max ${ms(max)}`,
    memory: (bytes: number, source: string) => `memory peak ${mb(bytes)} (${source})`,
    memoryUnavailable: "memory: no measurement available in this browser",
    environment: (width: number, height: number, dpr: number, timerStep: number) =>
      `drawing area ${width} x ${height} CSS px at ${dpr}x, timer step ${timerStep} ms`,
    problem: (text: string) => `NOT VALID: ${text}`,
  },

  problems: {
    hidden: "the page was hidden during the run",
    resized: "the window was resized during the run",
    stageNotVisible: "the drawing area was not fully inside the window",
  },
} as const;
