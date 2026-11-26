// SPDX-License-Identifier: GPL-3.0-or-later

// A minimal page that runs the benchmark: pick an engine, run once or twice, read
// the summary and download the JSON results. Engine packages can reuse it with their
// own engine:
//
//   import { startHarness } from "@galatsa/bench/harness";
//   startHarness({ root: document.body, engines: [{ id: "x", create: createXEngine }] });
//
// Query parameters, for automated runs (a desktop shell, a test):
//   engine=<id>     engine to select (default: the first)
//   runs=1|2        start this many runs as soon as the page has loaded
//   width, height   viewport in CSS pixels (default 1280 x 720)
//   memory=0        skip measureUserAgentSpecificMemory()
//
// The page also exposes window.galatsaBench (see HarnessApi) for scripts.

import type { BenchEngine } from "../engine.ts";
import { type ImageStore, prepareImages } from "../image-store.ts";
import { type BenchResult, formatSummary } from "../result.ts";
import { runBenchmark } from "../runner.ts";
import { generateScene } from "../scene.ts";
import { type Comparison, compareRuns } from "../stats.ts";
import { STRINGS } from "../strings.ts";

export interface HarnessEngine {
  /** Used in the `engine` query parameter. */
  readonly id: string;
  readonly create: () => BenchEngine;
}

export interface HarnessOptions {
  readonly root: HTMLElement;
  readonly engines: readonly HarnessEngine[];
}

export interface HarnessOutput {
  readonly results: readonly BenchResult[];
  readonly comparison: Comparison | null;
}

export interface HarnessApi {
  /** Runs `runs` times in a row (1 or more) with the given or selected engine. */
  run(runs?: number, engineId?: string): Promise<HarnessOutput>;
  /** The output of the last finished run, or null. */
  readonly lastOutput: HarnessOutput | null;
}

declare global {
  interface Window {
    galatsaBench?: HarnessApi;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

function positiveInt(value: string | null, fallback: number): number {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function comparisonText(comparison: Comparison): string {
  return [
    STRINGS.comparisonTitle(comparison.tolerance, comparison.agree),
    ...comparison.metrics.map((m) =>
      STRINGS.comparisonRow(m.name, m.a, m.b, m.relativeDifference, m.decisive),
    ),
    STRINGS.comparisonFootnote,
  ].join("\n");
}

export function startHarness(options: HarnessOptions): HarnessApi {
  const { root, engines } = options;
  if (engines.length === 0) throw new Error("startHarness needs at least one engine");
  const params = new URLSearchParams(location.search);
  const viewport = {
    width: positiveInt(params.get("width"), 1280),
    height: positiveInt(params.get("height"), 720),
  };
  const measureMemory = params.get("memory") !== "0";

  document.title = STRINGS.pageTitle;
  const controls = element("div");
  controls.className = "controls";
  const label = element("label", `${STRINGS.engineLabel} `);
  const select = element("select");
  for (const engine of engines) {
    const option = element("option", engine.id);
    option.value = engine.id;
    select.append(option);
  }
  const requested = params.get("engine");
  if (requested !== null && engines.some((e) => e.id === requested))
    select.value = requested;
  label.append(select);
  const runButton = element("button", STRINGS.runButton);
  const runTwiceButton = element("button", STRINGS.runTwiceButton);
  const downloadButton = element("button", STRINGS.downloadButton);
  downloadButton.disabled = true;
  controls.append(label, runButton, runTwiceButton, downloadButton);
  const status = element("p", STRINGS.statusIdle);
  status.setAttribute("role", "status");
  const output = element("pre");
  const stage = element("div");
  stage.className = "stage";
  root.append(controls, status, output, stage);

  const scene = generateScene();
  let images: Promise<ImageStore> | undefined;
  let busy = false;
  let lastOutput: HarnessOutput | null = null;

  const setBusy = (value: boolean) => {
    busy = value;
    runButton.disabled = value;
    runTwiceButton.disabled = value;
    select.disabled = value;
    downloadButton.disabled = value || lastOutput === null;
    root.dataset["benchState"] = value
      ? "running"
      : lastOutput !== null
        ? "done"
        : "idle";
  };

  const run = async (runs = 1, engineId = select.value): Promise<HarnessOutput> => {
    if (busy) throw new Error("A run is already in progress");
    const engine = engines.find((e) => e.id === engineId);
    if (engine === undefined) throw new Error(`Unknown engine ${engineId}`);
    setBusy(true);
    output.textContent = "";
    try {
      images ??= prepareImages(scene, (done, total) => {
        status.textContent = STRINGS.statusGenerating(done, total);
      }).catch((error: unknown) => {
        images = undefined; // try again on the next run
        throw error;
      });
      const store = await images;
      const results: BenchResult[] = [];
      for (let i = 0; i < runs; i++) {
        const result = await runBenchmark({
          engine: engine.create(),
          container: stage,
          images: store,
          scene,
          viewport,
          measureMemory,
          onPhase: (phase) => {
            status.textContent =
              phase === "memory"
                ? STRINGS.statusMeasuringMemory
                : phase === "load"
                  ? STRINGS.statusLoading
                  : STRINGS.statusRunning(i + 1, runs);
          },
        });
        results.push(result);
        output.textContent = results.map(formatSummary).join("\n\n");
      }
      const comparison =
        results.length >= 2
          ? compareRuns(results[0]!, results[results.length - 1]!)
          : null;
      if (comparison !== null) output.textContent += `\n\n${comparisonText(comparison)}`;
      lastOutput = { results, comparison };
      status.textContent = STRINGS.statusDone;
      return lastOutput;
    } catch (error) {
      status.textContent = STRINGS.statusFailed(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (lastOutput === null) return;
    const first = lastOutput.results[0];
    const stamp = (first?.startedAt ?? "").replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(lastOutput, null, 1)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = `galatsa-bench-${first?.engine ?? "result"}-${stamp}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Errors are shown in the status line by run(); nothing more to do here.
  const ignore = () => {};
  runButton.addEventListener("click", () => run(1).catch(ignore));
  runTwiceButton.addEventListener("click", () => run(2).catch(ignore));
  downloadButton.addEventListener("click", download);
  setBusy(false);

  const api: HarnessApi = {
    run,
    get lastOutput() {
      return lastOutput;
    },
  };
  window.galatsaBench = api;

  const autorun = positiveInt(params.get("runs"), 0);
  if (autorun > 0) run(autorun).catch(ignore);
  return api;
}
