// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the benchmark's camera run with the DOM engine variants and saves the
// results under results/<project>/<variant>.json. Choose the variants with
// BENCH_VARIANTS (comma-separated, default "dom"). The images are generated once per
// page, then each variant runs in turn. Takes about a minute per variant at 60 Hz,
// more for slow variants.

import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";
import { browserPssBytes, sampleMemory } from "./proc-memory.ts";

const RESULTS = new URL("../results/", import.meta.url);

test("camera run", async ({ page }, testInfo) => {
  const variants = (process.env["BENCH_VARIANTS"] ?? "dom").split(",");
  test.setTimeout(variants.length * 6 * 60_000 + 2 * 60_000);
  await page.goto(`/?engine=${variants[0]}`);
  const status = page.getByRole("status");
  await expect(status).toBeVisible();
  const folder = new URL(`${testInfo.project.name}/`, RESULTS);
  mkdirSync(folder, { recursive: true });

  for (const variant of variants) {
    const sampler = sampleMemory(250);
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    let baselineBytes: number | null = null;
    const running = page.evaluate(
      (id) => window.galatsaBench!.run(1, id),
      variant,
    ) as Promise<HarnessOutput>;
    let finished = false;
    void running.finally(() => {
      finished = true;
    });
    // Note when the phases start, to tell image generation apart from the run.
    while (!finished) {
      const text = (await status.textContent()) ?? "";
      if (text.startsWith("Loading") && marks["load"] === undefined) {
        marks["load"] = Date.now() - t0;
        baselineBytes = browserPssBytes();
      }
      if (text.startsWith("Running") && marks["run"] === undefined)
        marks["run"] = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 100));
    }
    const output = await running;
    marks["end"] = Date.now() - t0;
    const memory = sampler.stop();
    const fromLoad = memory.samples.filter((s) => s.t >= (marks["load"] ?? 0));
    const result = output.results[0]!;
    const engineStats = await page.evaluate(
      () =>
        (globalThis as { protoDomLastStats?: Record<string, number> })
          .protoDomLastStats ?? null,
    );
    const saved = {
      project: testInfo.project.name,
      variant,
      processMemory: {
        note: "Sum of PSS of the browser's processes (Linux /proc), sampled every 250 ms",
        baselineBeforeLoadBytes: baselineBytes,
        peakFromLoadBytes:
          fromLoad.length > 0 ? Math.max(...fromLoad.map((s) => s.bytes)) : null,
        marksMs: marks,
        samples: memory.samples.filter((_, i) => i % 4 === 0),
      },
      engineStats,
      result,
    };
    // BENCH_SUFFIX names a repeat run, e.g. "-run2".
    const suffix = process.env["BENCH_SUFFIX"] ?? "";
    writeFileSync(
      new URL(`${variant}${suffix}.json`, folder),
      JSON.stringify(saved, null, 1),
    );
    const s = result.stats;
    console.log(
      [
        `${testInfo.project.name} ${variant}: load ${Math.round(result.timings.loadMs)} ms, run ${Math.round(result.timings.runMs)} ms`,
        `  frame (wall clock) p95 ${s.frameMs.p95} max ${s.frameMs.max}; work p95 ${s.workMs.p95} max ${s.workMs.max}`,
        `  frames over 33 ms ${result.verdictInputs.targets.frames33.count} (${result.verdictInputs.targets.frames33.judgedBy}), stalls ${result.verdictInputs.targets.stalls.count}`,
        `  render() mean ${s.renderMs.mean.toFixed(2)} p95 ${s.renderMs.p95} max ${s.renderMs.max}`,
        `  text sharp p50 ${result.textSharp.p50Ms} max ${result.textSharp.maxMs} missing ${result.textSharp.missing}`,
        `  process PSS peak ${((saved.processMemory.peakFromLoadBytes ?? 0) / 2 ** 20).toFixed(0)} MiB`,
        `  engine ${JSON.stringify(engineStats)}`,
      ].join("\n"),
    );
    expect(result.environment.hiddenDuringRun).toBe(false);
    expect(result.scene.elements).toBe(2000);
  }
});
