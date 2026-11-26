// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark meter, run twice in a row in a real browser, must give the same
// decision numbers (compareRuns: 5 % or an absolute floor), both for the empty
// engine and for the synthetic engine, which keeps the main thread busy for a
// seeded 5 to 25 ms per frame and so misses many frames. Takes 4 to 5 minutes per
// browser.

import { writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";

test("the meter repeats for the empty and the synthetic engine", async ({
  page,
}, testInfo) => {
  test.setTimeout(20 * 60_000);
  await page.goto("/?engine=noop");
  await expect(page.getByRole("status")).toBeVisible();

  const outputs: Record<string, HarnessOutput> = {};
  for (const engine of ["noop", "synthetic"]) {
    const output: HarnessOutput = await page.evaluate((id) => {
      const api = window.galatsaBench;
      if (api === undefined) throw new Error("The harness did not start");
      return api.run(2, id);
    }, engine);
    outputs[engine] = output;
    const summaries = await page.locator("pre").textContent();
    console.log(`\n=== ${testInfo.project.name}: ${engine} ===\n${summaries ?? ""}`);
  }
  const file = testInfo.outputPath("bench-repeatability.json");
  writeFileSync(file, JSON.stringify(outputs, null, 1));
  console.log(`Full results: ${file}`);

  for (const [engine, output] of Object.entries(outputs)) {
    expect(output.results).toHaveLength(2);
    for (const result of output.results) {
      expect(result.verdictInputs.problems, engine).toEqual([]);
      expect(result.environment.stage.fullyVisible).toBe(true);
      expect(result.verdictInputs.frames).toBe(result.cameraRun.frames);
      expect(result.textSharp.missing).toBe(0);
    }
    const comparison = output.comparison!;
    for (const metric of comparison.metrics.filter((m) => m.decisive)) {
      expect(
        Math.abs(metric.a - metric.b),
        `${engine}: ${metric.name}`,
      ).toBeLessThanOrEqual(metric.allowed);
    }
    expect(comparison.agree).toBe(true);
  }

  // The empty engine misses (almost) no frames; the synthetic one misses many.
  for (const result of outputs["noop"]!.results) {
    expect(result.verdictInputs.missedFrames.ratio).toBeLessThan(0.01);
  }
  for (const result of outputs["synthetic"]!.results) {
    expect(result.verdictInputs.missedFrames.ratio).toBeGreaterThan(0.2);
  }
});
