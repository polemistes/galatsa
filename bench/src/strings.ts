// SPDX-License-Identifier: GPL-3.0-or-later

// Every piece of text that the bench shows to people (the harness page and the
// result summary), in one place, so that it can move to the translation files once
// they exist. English only for now. JSON field names and error messages for
// developers are not listed here.

const ms = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(2)} ms`);
const mb = (v: number | null): string =>
  v === null ? "n/a" : `${(v / 1e6).toFixed(1)} MB`;

export const STRINGS = {
  pageTitle: "Galatsa benchmark",
  engineLabel: "Engine",
  runButton: "Run",
  runTwiceButton: "Run twice and compare",
  downloadButton: "Download JSON",
  statusIdle: "Ready.",
  statusGenerating: (done: number, total: number) =>
    `Generating images: ${done} / ${total}`,
  statusMeasuringMemory: "Measuring memory…",
  statusLoading: "Loading the scene into the engine…",
  statusRunning: (run: number, runs: number) =>
    `Running ${run} of ${runs}. Keep this window visible and do not touch it.`,
  statusDone: "Done.",
  statusFailed: (message: string) => `Failed: ${message}`,
  hiddenWarning: "The page was hidden during the run, so the frame times are not valid.",
  comparisonTitle: (tolerance: number, agree: boolean) =>
    `Comparison (tolerance ${(tolerance * 100).toFixed(0)} %): ${agree ? "the runs agree" : "the runs DIFFER"}`,
  comparisonRow: (name: string, a: number, b: number, diff: number, decisive: boolean) =>
    `${decisive ? "*" : " "} ${name}: ${a.toFixed(3)} / ${b.toFixed(3)} (${(diff * 100).toFixed(2)} %)`,
  comparisonFootnote: "* decides whether the runs agree",

  summary: {
    run: (engine: string, frames: number, runMs: number, loadMs: number) =>
      `engine ${engine}, ${frames} frames, run ${ms(runMs)}, load ${ms(loadMs)}`,
    interval: (mean: number, p50: number, p95: number, p99: number, max: number) =>
      `frame interval mean ${ms(mean)}, p50 ${ms(p50)}, p95 ${ms(p95)}, p99 ${ms(p99)}, max ${ms(max)}`,
    over: (counts: readonly (readonly [string, number])[]) =>
      `frames ${counts.map(([threshold, n]) => `over ${threshold} ms: ${n}`).join(", ")}`,
    callback: (
      p95: number,
      max: number,
      counts: readonly (readonly [string, number])[],
    ) =>
      `callback interval (wall clock) p95 ${ms(p95)}, max ${ms(max)}, ${counts.map(([threshold, n]) => `over ${threshold} ms: ${n}`).join(", ")}`,
    script: (mean: number, p95: number) => `render() mean ${ms(mean)}, p95 ${ms(p95)}`,
    textSharp: (
      reported: number,
      missing: number,
      p50: number | null,
      max: number | null,
    ) =>
      `text sharp after stop: ${reported} reported, ${missing} missing, p50 ${ms(p50)}, max ${ms(max)}`,
    uaMemory: (afterLoad: number | null, afterRun: number | null) =>
      `memory (measureUserAgentSpecificMemory): after load ${mb(afterLoad)}, after run ${mb(afterRun)}`,
    uaMemoryUnavailable: (note: string | null) =>
      `memory (measureUserAgentSpecificMemory): unavailable (${note ?? "unknown"})`,
    heapMemory: (peak: number | null) => `memory (JavaScript heap, peak): ${mb(peak)}`,
    heapMemoryUnavailable: "memory (JavaScript heap): unavailable in this browser",
    environment: (width: number, height: number, dpr: number, timerStep: number) =>
      `viewport ${width}x${height} CSS px at ${dpr}x, timer step ${timerStep} ms`,
  },
} as const;
