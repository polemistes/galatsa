// SPDX-License-Identifier: GPL-3.0-or-later

// A minimal page that runs the benchmark: pick an engine, run once or twice, read
// the summary and download the JSON results. Engine packages can reuse it with their
// own engine:
//
//   import { startHarness } from "@galatsa/bench/harness";
//   startHarness({ root: document.body, engines: [{ id: "x", create: createXEngine }] });
//
// The drawing area (stage) is fixed at the top-left corner of the window, so that it
// never moves between runs; the controls and the text sit below it. A run refuses to
// start unless the whole stage is inside the window.
//
// Query parameters, for automated runs (a desktop shell, a test):
//   engine=<id>     engine to select (default: the first)
//   runs=<n>        start this many runs as soon as the page has loaded
//   capture=1       with runs=<n>: pause at the end of each hold and keep an image
//   width, height   stage size in CSS pixels (default 960 x 540, see camera.ts)
//   memory=0        skip measureUserAgentSpecificMemory()
//
// For scripts and hosts, the page sets window.galatsaBench (see HarnessApi) and
// dispatches every BenchEvent as a "galatsa-bench" CustomEvent on window. A host
// that can take screenshots may set window.galatsaBenchHostCapture (see below); it
// is used in capture runs for engines without snapshot().

import { REFERENCE_VIEWPORT } from "../camera.ts";
import type { BenchEngine } from "../engine.ts";
import { type ImageStore, prepareImages } from "../image-store.ts";
import type { ExternalMemorySampler } from "../memory.ts";
import { type BenchResult, type Capture, formatSummary } from "../result.ts";
import { type BenchEvent, type CaptureFunction, runBenchmark } from "../runner.ts";
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
  /** First against last run, when there were two or more. */
  readonly comparison: Comparison | null;
}

export interface HarnessRunOptions {
  /** Pause at the end of each hold and keep an image of the stage. */
  readonly capture?: boolean;
}

export interface HarnessApi {
  /** Runs `runs` times in a row (1 or more) with the given or selected engine. */
  run(
    runs?: number,
    engineId?: string,
    options?: HarnessRunOptions,
  ): Promise<HarnessOutput>;
  /** The output of the last finished run, or null. */
  readonly lastOutput: HarnessOutput | null;
  /** Every event of every run since the page loaded. */
  readonly events: readonly BenchEvent[];
  /**
   * Sets an external memory sampler (for example a desktop shell reading its process
   * memory) for the next runs; null removes it.
   */
  setMemorySampler(sampler: ExternalMemorySampler | null): void;
}

/** Host screenshot of the stage; returns a data: URL or Blob, or null. */
export type HostCapture = (stage: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => Promise<string | Blob | null>;

declare global {
  interface Window {
    galatsaBench?: HarnessApi;
    galatsaBenchHostCapture?: HostCapture;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

function comparisonText(comparison: Comparison): string {
  return [
    STRINGS.comparisonTitle(comparison.agree),
    ...comparison.verdicts.map((v) =>
      STRINGS.comparisonVerdictRow(v.target, v.a, v.b, v.valueA, v.valueB),
    ),
    STRINGS.comparisonDeltasTitle(comparison.tolerance),
    ...comparison.metrics.map((m) =>
      STRINGS.comparisonRow(m.name, m.a, m.b, m.allowed, m.withinTolerance),
    ),
  ].join("\n");
}

export function startHarness(options: HarnessOptions): HarnessApi {
  const { root, engines } = options;
  if (engines.length === 0) throw new Error("startHarness needs at least one engine");
  const params = new URLSearchParams(location.search);
  const viewport = {
    width: positiveInt(params.get("width"), REFERENCE_VIEWPORT.width),
    height: positiveInt(params.get("height"), REFERENCE_VIEWPORT.height),
  };
  const measureMemory = params.get("memory") !== "0";
  // reduced=0 generates only the originals, as the first versions of the bench did.
  const generateReduced = params.get("reduced") !== "0";

  document.title = STRINGS.pageTitle;

  // The stage: fixed in the window, independent of the text below.
  const stage = element("div");
  stage.className = "stage";
  stage.style.position = "fixed";
  stage.style.left = "0";
  stage.style.top = "0";
  stage.style.width = `${viewport.width}px`;
  stage.style.height = `${viewport.height}px`;
  // Above everything else on the page, so that nothing can be drawn over it.
  stage.style.zIndex = "2147483647";
  stage.style.background = "#fff";

  const panel = element("div");
  panel.className = "panel";
  panel.style.position = "absolute";
  panel.style.left = "12px";
  panel.style.right = "12px";
  panel.style.top = `${viewport.height + 12}px`;
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
  const captureButton = element("button", STRINGS.captureButton);
  const downloadButton = element("button", STRINGS.downloadButton);
  downloadButton.disabled = true;
  controls.append(label, runButton, runTwiceButton, captureButton, downloadButton);
  const status = element("p", STRINGS.statusIdle);
  status.setAttribute("role", "status");
  const output = element("pre");
  panel.append(controls, status, output);
  root.append(stage, panel);

  const stageFits = () =>
    viewport.width <= document.documentElement.clientWidth &&
    viewport.height <= document.documentElement.clientHeight;
  if (!stageFits())
    status.textContent = STRINGS.stageNotVisible(viewport.width, viewport.height);

  const scene = generateScene();
  let images: Promise<ImageStore> | undefined;
  let busy = false;
  let lastOutput: HarnessOutput | null = null;
  let memorySampler: ExternalMemorySampler | undefined;
  const events: BenchEvent[] = [];

  // During a run the page is scrolled to the top and cannot scroll, so that the
  // stage and the panel stay where they are.
  const lockScroll = (locked: boolean) => {
    if (locked) window.scrollTo(0, 0);
    document.documentElement.style.overflow = locked ? "hidden" : "";
  };

  const setBusy = (value: boolean) => {
    busy = value;
    lockScroll(value);
    runButton.disabled = value;
    runTwiceButton.disabled = value;
    captureButton.disabled = value;
    select.disabled = value;
    downloadButton.disabled = value || lastOutput === null;
    root.dataset["benchState"] = value
      ? "running"
      : lastOutput !== null
        ? "done"
        : "idle";
  };

  const makeCapture =
    (engine: BenchEngine): CaptureFunction =>
    async (hold) => {
      let image: Blob | string | null = null;
      let by: Capture["by"] = "engine";
      if (engine.snapshot !== undefined) {
        image = await engine.snapshot();
      } else if (window.galatsaBenchHostCapture !== undefined) {
        by = "host";
        const rect = stage.getBoundingClientRect();
        image = await window.galatsaBenchHostCapture({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }
      if (image === null) return null;
      const dataUrl = typeof image === "string" ? image : await blobToDataUrl(image);
      return { label: hold.label, frame: hold.frame, by, dataUrl };
    };

  const run = async (
    runs = 1,
    engineId = select.value,
    runOptions: HarnessRunOptions = {},
  ): Promise<HarnessOutput> => {
    if (busy) throw new Error("A run is already in progress");
    const entry = engines.find((e) => e.id === engineId);
    if (entry === undefined) throw new Error(`Unknown engine ${engineId}`);
    // Refuse at once, before generating images, if the stage cannot fit.
    if (!stageFits()) {
      const message = STRINGS.stageNotVisible(viewport.width, viewport.height);
      status.textContent = STRINGS.statusFailed(message);
      throw new Error(message);
    }
    setBusy(true);
    output.textContent = runOptions.capture === true ? STRINGS.capturesNote : "";
    try {
      images ??= prepareImages(
        scene,
        (done, total) => {
          status.textContent = STRINGS.statusGenerating(done, total);
        },
        { reduced: generateReduced },
      ).catch((error: unknown) => {
        images = undefined; // try again on the next run
        throw error;
      });
      const store = await images;
      const results: BenchResult[] = [];
      for (let i = 0; i < runs; i++) {
        const engine = entry.create();
        const result = await runBenchmark({
          engine,
          container: stage,
          images: store,
          scene,
          viewport,
          measureMemory,
          ...(memorySampler !== undefined ? { memorySampler } : {}),
          ...(runOptions.capture === true ? { capture: makeCapture(engine) } : {}),
          onEvent: (event) => {
            events.push(event);
            window.dispatchEvent(new CustomEvent("galatsa-bench", { detail: event }));
            // Status text changes only outside the timed frames.
            if (event.type === "settle-start")
              status.textContent = STRINGS.statusSettling;
            else if (event.type === "calibrate-start")
              status.textContent = STRINGS.statusCalibrating;
            else if (event.type === "load-start")
              status.textContent = STRINGS.statusLoading;
            else if (event.type === "load-end")
              status.textContent = STRINGS.statusRunning(i + 1, runs);
            else if (event.type === "run-end")
              status.textContent = STRINGS.statusMeasuringMemory;
          },
        });
        results.push(result);
        output.textContent = results.map(formatSummary).join("\n\n");
      }
      const first = results[0];
      const last = results[results.length - 1];
      const comparison =
        results.length >= 2 && first !== undefined && last !== undefined
          ? compareRuns(first.verdictInputs, last.verdictInputs)
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
  captureButton.addEventListener("click", () =>
    run(1, select.value, { capture: true }).catch(ignore),
  );
  downloadButton.addEventListener("click", download);
  setBusy(false);

  const api: HarnessApi = {
    run,
    get lastOutput() {
      return lastOutput;
    },
    events,
    setMemorySampler(sampler) {
      memorySampler = sampler ?? undefined;
    },
  };
  window.galatsaBench = api;

  const autorun = positiveInt(params.get("runs"), 0);
  if (autorun > 0) {
    run(autorun, select.value, { capture: params.get("capture") === "1" }).catch(ignore);
  }
  return api;
}
