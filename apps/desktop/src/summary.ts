// SPDX-License-Identifier: GPL-3.0-or-later

// The summary of a session (summary.json): per engine, the verdicts of each run,
// so that people can read the outcome without opening the full results. It is
// built up one engine at a time, because each engine runs in its own page.

import { type BenchResult, compareRuns } from "@galatsa/bench";
import type { HostInfo } from "./host.ts";
import type { HostMemoryReport } from "./memory-recorder.ts";
import type { EngineId, RunMode } from "./plan.ts";

export const SUMMARY_FORMAT = "galatsa-bench-shell-summary";
export const SUMMARY_VERSION = 1;
export const SUMMARY_FILE = "summary.json";
export const SUMMARY_TEXT_FILE = "summary.txt";

export interface RunSummary {
  readonly run: number;
  readonly mode: RunMode;
  readonly file: string;
  readonly valid: boolean;
  readonly problems: readonly string[];
  readonly refreshRateHz: number;
  readonly frames: number;
  readonly frames16_7: {
    readonly ratio: number;
    readonly pass: boolean;
    readonly judgedBy: string;
  };
  readonly frames33: {
    readonly ratio: number;
    readonly pass: boolean;
    readonly judgedBy: string;
  };
  readonly stalls: { readonly count: number; readonly pass: boolean };
  readonly textSharp: {
    readonly maxMs: number | null;
    readonly missing: number;
    readonly pass: boolean;
  };
  readonly memory: { readonly peakBytes: number | null; readonly pass: boolean | null };
  /** Problems the host reported while sampling memory (empty when all was read). */
  readonly memoryProblems: readonly string[];
  readonly loadMs: number;
  readonly workP95Ms: number;
  readonly frameP95Ms: number;
}

export interface EngineSummary {
  readonly engine: EngineId;
  readonly runs: readonly RunSummary[];
  /**
   * Whether the timing runs reach the same verdict on every target; null with
   * fewer than two timing runs.
   */
  readonly timingRunsAgree: boolean | null;
  /** Set if the engine's page stopped with an error. */
  readonly error: string | null;
}

export interface SessionSummary {
  readonly format: typeof SUMMARY_FORMAT;
  readonly version: typeof SUMMARY_VERSION;
  readonly session: string;
  readonly platform: string;
  readonly host: HostInfo | null;
  readonly engines: readonly EngineSummary[];
}

export function summarizeRun(
  run: number,
  file: string,
  result: BenchResult,
  memory: HostMemoryReport,
): RunSummary {
  const v = result.verdictInputs;
  const t = v.targets;
  return {
    run,
    mode: result.mode,
    file,
    valid: v.valid,
    problems: v.problems,
    refreshRateHz: v.refreshRateHz,
    frames: v.frames,
    frames16_7: {
      ratio: t.frames16_7.ratio,
      pass: t.frames16_7.pass,
      judgedBy: t.frames16_7.judgedBy,
    },
    frames33: {
      ratio: t.frames33.ratio,
      pass: t.frames33.pass,
      judgedBy: t.frames33.judgedBy,
    },
    stalls: t.stalls,
    textSharp: t.textSharp,
    memory: t.memory,
    memoryProblems: Object.keys(memory.problems),
    loadMs: v.loadMs,
    workP95Ms: v.workMs.p95,
    frameP95Ms: v.frameMs.p95,
  };
}

/** Compares the first and the last timing run, if there are two. */
export function timingAgreement(results: readonly BenchResult[]): boolean | null {
  const timing = results.filter((r) => r.mode === "timing");
  const first = timing[0];
  const last = timing[timing.length - 1];
  if (timing.length < 2 || first === undefined || last === undefined) return null;
  return compareRuns(first.verdictInputs, last.verdictInputs).agree;
}

/** Adds or replaces the engine's entry, keeping the order of the plan. */
export function withEngine(
  summary: SessionSummary,
  entry: EngineSummary,
  order: readonly EngineId[],
): SessionSummary {
  const engines = [...summary.engines.filter((e) => e.engine !== entry.engine), entry];
  engines.sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine));
  return { ...summary, engines };
}

export function emptySummary(
  session: string,
  platform: string,
  host: HostInfo | null,
): SessionSummary {
  return {
    format: SUMMARY_FORMAT,
    version: SUMMARY_VERSION,
    session,
    platform,
    host,
    engines: [],
  };
}

/** Parses summary.json; null if it is missing or not a summary. */
export function parseSummary(text: string | null): SessionSummary | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<SessionSummary>;
    return value.format === SUMMARY_FORMAT && Array.isArray(value.engines)
      ? (value as SessionSummary)
      : null;
  } catch {
    return null;
  }
}
