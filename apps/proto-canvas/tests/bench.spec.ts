// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the bench camera run with the canvas engine and saves the result, with the
// engine's own counters, to results/bench-<browser>.json. Set RUNS=2 for two runs
// and a comparison.

import { writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";
import type { EngineStats } from "../src/engine.ts";

test("camera run with the canvas engine", async ({ page, browserName }) => {
  test.setTimeout(20 * 60_000);
  const runs = Number(process.env["RUNS"] ?? "1");
  await page.goto("/?engine=canvas2d");
  await expect(page.getByRole("status")).toBeVisible();

  const { output, stats } = await page.evaluate(async (runs) => {
    const api = window.galatsaBench;
    if (api === undefined) throw new Error("The harness did not start");
    const output = await api.run(runs, "canvas2d");
    return { output, stats: window.protoCanvasStats };
  }, runs);
  const engineStats: EngineStats | undefined = stats;

  const file = new URL(`../results/bench-${browserName}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ ...output, engineStats }, null, 1)}\n`);
  console.log(await page.locator("pre").textContent());
  console.log(JSON.stringify(engineStats, null, 1));

  const result = (output as HarnessOutput).results[0]!;
  expect(result.environment.hiddenDuringRun).toBe(false);
  expect(result.scene.elements).toBe(2000);
  expect(result.frames.intervalMs).toHaveLength(result.cameraRun.frames);
  expect(result.textSharp.missing).toBe(0);
});
