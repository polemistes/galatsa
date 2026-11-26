// SPDX-License-Identifier: GPL-3.0-or-later

// Runs the benchmark's camera run with the Konva engine on the built harness page and
// saves the results to results/bench-<browser>.json (the harness output plus the
// engine's own counters) and the printed summary to results/bench-<browser>.txt.
// Takes about a minute and a half: the images are generated first (about 17 s in
// Chromium), then the run itself is about 46 s at 60 Hz.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";
import type { EngineStats } from "../src/engine.ts";
import { RESULTS_DIR } from "./playground.ts";

test("camera run with the Konva engine", async ({ page, browserName }) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/?engine=konva");
  await expect(page.getByRole("status")).toBeVisible();

  const output: HarnessOutput = await page.evaluate(() => {
    const api = window.galatsaBench;
    if (api === undefined) throw new Error("The harness did not start");
    return api.run(1, "konva");
  });
  const engineStats: EngineStats = await page.evaluate(() =>
    window.protoKonvaEngine!.stats(),
  );
  const summary = (await page.locator("pre").textContent()) ?? "";

  writeFileSync(
    join(RESULTS_DIR, `bench-${browserName}.json`),
    `${JSON.stringify({ ...output, engineStats })}\n`,
  );
  writeFileSync(
    join(RESULTS_DIR, `bench-${browserName}.txt`),
    `${summary}\n\nEngine counters:\n${JSON.stringify(engineStats, null, 2)}\n`,
  );
  console.log(summary);
  console.log(engineStats);

  const result = output.results[0]!;
  expect(result.environment.hiddenDuringRun).toBe(false);
  expect(result.stats.interval.count).toBe(result.cameraRun.frames);
  expect(result.scene.elements).toBe(2000);
  expect(result.textSharp.reported).toBeGreaterThan(0);
});
