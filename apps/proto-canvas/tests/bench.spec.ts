// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the bench camera run with the canvas engine and saves the result to
// results/bench-<project>-<decoder>.json, with the engine's own counters, the browser's
// graphics renderer and the memory of the browser's processes (Linux).
//
// The no-op engine runs first. It makes the harness generate the images, and its
// process memory is the baseline: the page, the browser and the 317 MB of encoded
// image files, without any engine. Set RUNS=2 for two engine runs and a comparison,
// DECODER=imagedecoder or createimagebitmap to choose the image decoder.

import { writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, type Page, test } from "@playwright/test";
import type { EngineStats } from "../src/engine.ts";
import { ProcessMemorySampler } from "./process-memory.ts";

function graphicsRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (gl === null) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
}

test("camera run with the canvas engine", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000);
  const runs = Number(process.env["RUNS"] ?? "1");
  const decoder = process.env["DECODER"] ?? "";
  const memory = new ProcessMemorySampler();
  memory.begin(500);
  await page.goto(`/?engine=canvas2d${decoder ? `&decoder=${decoder}` : ""}`);
  await expect(page.getByRole("status")).toBeVisible();
  const renderer = await graphicsRenderer(page);

  const run = (n: number, engine: string) =>
    page.evaluate(([n, engine]) => window.galatsaBench!.run(n, engine), [
      n,
      engine,
    ] as const);

  // Baseline: images generated, no engine drawing.
  const noopStart = performance.now();
  await run(1, "noop");
  const t0 = memory.samples.at(-1)!.t;
  const noopEnd = performance.now();
  const engineStart = performance.now();
  const output: HarnessOutput = await run(runs, "canvas2d");
  const t1 = memory.samples.at(-1)!.t;
  memory.end();
  const engineStats: EngineStats | undefined = await page.evaluate(
    () => window.protoCanvasStats,
  );

  const noopWindow = [0, t0] as const;
  const engineWindow = [t0, t1 + 500] as const;
  const processMemory = {
    available: memory.available,
    note: "Sum of PSS over all browser processes, sampled every 500 ms from /proc. Baseline is the no-op engine run, after the harness generated the images.",
    baselinePeakBytes: memory.peak(...noopWindow),
    /** At the end of the no-op run: images generated and kept, nothing drawn. */
    baselineEndBytes: memory.samples.filter((x) => x.t <= t0).at(-1)?.pssBytes ?? 0,
    enginePeakBytes: memory.peak(...engineWindow),
    noopMs: Math.round(noopEnd - noopStart),
    engineMs: Math.round(performance.now() - engineStart),
    samples: memory.samples,
  };

  const file = new URL(
    `../results/bench-${testInfo.project.name}-${engineStats?.decoder ?? "unknown"}.json`,
    import.meta.url,
  );
  writeFileSync(
    file,
    `${JSON.stringify({ ...output, renderer, engineStats, processMemory }, null, 1)}\n`,
  );
  console.log(await page.locator("pre").textContent());
  console.log(`renderer: ${renderer}`);
  console.log(
    `process memory: no-op end ${(processMemory.baselineEndBytes / 2 ** 20).toFixed(0)} MiB, peak with engine ${(processMemory.enginePeakBytes / 2 ** 20).toFixed(0)} MiB`,
  );
  console.log(JSON.stringify(engineStats, null, 1));

  for (const result of output.results) {
    expect(result.environment.hiddenDuringRun).toBe(false);
    expect(result.scene.elements).toBe(2000);
    expect(result.frames.frameMs).toHaveLength(result.cameraRun.frames);
    expect(result.textSharp.missing).toBe(0);
  }
});
