// SPDX-License-Identifier: GPL-3.0-or-later

// run.html: runs one engine of the plan (a capture run, then the timing runs),
// saves each result with the host's facts, adds the engine to the session summary,
// then loads the page again for the next engine, or the start page at the end.

import type { BenchResult } from "@galatsa/bench";
import { startHarness } from "@galatsa/bench/harness";
import { ENGINES } from "./engines.ts";
import { type HostInfo, host } from "./host.ts";
import { engineName, summaryLines, t } from "./i18n.ts";
import { MemoryRecorder } from "./memory-recorder.ts";
import { pageInfo } from "./page-info.ts";
import {
  captureFileName,
  nextPlan,
  planFromQuery,
  planToQuery,
  resultFileName,
  RUNS_PER_ENGINE,
  type EngineId,
  type RunPlan,
} from "./plan.ts";
import { captureStageCanvases } from "./stage-capture.ts";
import {
  emptySummary,
  type EngineSummary,
  parseSummary,
  type RunSummary,
  SUMMARY_FILE,
  SUMMARY_TEXT_FILE,
  summarizeRun,
  timingAgreement,
  withEngine,
} from "./summary.ts";

export const RUN_FORMAT = "galatsa-bench-shell-run";
export const RUN_VERSION = 1;

/** Pause between runs, so that the previous run's garbage can be collected. */
const PAUSE_BETWEEN_RUNS_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Saves the capture images as files and leaves their names in the result. */
async function saveCaptures(
  plan: RunPlan,
  platform: string,
  engine: EngineId,
  result: BenchResult,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [i, capture] of result.captures.entries()) {
    const file = captureFileName(platform, engine, i, capture.label);
    await host.saveBinary(plan.session, file, dataUrlBytes(capture.dataUrl));
    out.push({ label: capture.label, frame: capture.frame, by: capture.by, file });
  }
  return out;
}

async function updateSummary(
  plan: RunPlan,
  platform: string,
  hostInfo: HostInfo | null,
  entry: EngineSummary,
): Promise<void> {
  const previous = parseSummary(await host.readText(plan.session, SUMMARY_FILE));
  const summary = withEngine(
    previous ?? emptySummary(plan.session, platform, hostInfo),
    entry,
    plan.engines,
  );
  await host.saveText(
    plan.session,
    SUMMARY_FILE,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await host.saveText(
    plan.session,
    SUMMARY_TEXT_FILE,
    `${summaryLines(summary).join("\n")}\n`,
  );
}

async function main(): Promise<void> {
  const root = document.getElementById("app") ?? document.body;
  const progress = document.createElement("p");
  progress.className = "progress";
  progress.setAttribute("role", "status");

  const plan = planFromQuery(location.search);
  if (plan === null) {
    progress.textContent = t("run.badPlan");
    root.append(progress);
    return;
  }
  const engine = plan.engines[plan.index] as EngineId;
  document.title = engineName(engine);

  const [settings, source] = await Promise.all([host.settings(), host.memorySource()]);
  const page = pageInfo();
  const api = startHarness({ root, engines: ENGINES });
  // Our progress line goes above the harness's own controls, below the stage.
  (root.querySelector(".panel") ?? root).prepend(progress);
  const recorder = new MemoryRecorder(source, host.memorySample);
  api.setMemorySampler(recorder.sampler);
  window.galatsaBenchHostCapture = captureStageCanvases;
  const hostInfo = await host.hostInfo().catch(() => null);

  const results: BenchResult[] = [];
  const runs: RunSummary[] = [];
  let error: string | null = null;
  const total = plan.engines.length * RUNS_PER_ENGINE.length;
  for (const [i, mode] of RUNS_PER_ENGINE.entries()) {
    const step = plan.index * RUNS_PER_ENGINE.length + i + 1;
    progress.textContent = `${t("run.progress", {
      step,
      total,
      engine: engineName(engine),
      kind: t(`run.kind.${mode}`),
    })} ${t("run.leaveAlone")}`;
    if (i > 0) await sleep(PAUSE_BETWEEN_RUNS_MS);
    recorder.reset();
    try {
      const output = await api.run(1, engine, { capture: mode === "capture" });
      const result = output.results[0];
      if (result === undefined) throw new Error("no result");
      progress.textContent = t("run.saving");
      const run = i + 1;
      const file = resultFileName(settings.platform, engine, run, mode);
      const memory = recorder.report();
      const captures = await saveCaptures(plan, settings.platform, engine, result);
      const saved = {
        format: RUN_FORMAT,
        version: RUN_VERSION,
        platform: settings.platform,
        session: plan.session,
        engine,
        run,
        mode,
        host: hostInfo,
        page,
        hostMemory: memory,
        result: { ...result, captures },
      };
      await host.saveText(plan.session, file, `${JSON.stringify(saved)}\n`);
      results.push(result);
      runs.push(summarizeRun(run, file, result, memory));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      progress.textContent = t("run.failed", {
        engine: engineName(engine),
        message: error,
      });
      break;
    }
  }

  await updateSummary(plan, settings.platform, hostInfo, {
    engine,
    runs,
    timingRunsAgree: timingAgreement(results),
    error,
  });
  if (error !== null) await sleep(5000); // leave the message readable for a moment
  const next = nextPlan(plan);
  location.href =
    next === null
      ? `index.html?${new URLSearchParams({ session: plan.session, done: "1" }).toString()}`
      : `run.html${planToQuery(next)}`;
}

void main();
