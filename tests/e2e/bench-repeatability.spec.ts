// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark meter, run twice in a row in a real browser, must give the same
// decision numbers (compareRuns: 5 % or an absolute floor), both for the empty
// engine and for the synthetic engine, which keeps the main thread busy for a
// seeded mix of short, missed, long and stalled frames. Takes 4 to 5 minutes per
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
      expect(result.environment.stage.unobstructed).toBe(true);
      expect(result.mode).toBe("timing");
      expect(result.verdictInputs.frames).toBe(result.cameraRun.frames);
      expect(result.textSharp.missing).toBe(0);
    }
    const comparison = output.comparison!;
    // The verdict on every target is the same in both runs.
    expect(comparison.agree, engine).toBe(true);
    // And the meter itself is steady: the raw numbers agree within 5 % or their
    // absolute floor.
    for (const metric of comparison.metrics) {
      expect(
        Math.abs(metric.a - metric.b),
        `${engine}: ${metric.name}`,
      ).toBeLessThanOrEqual(metric.allowed);
    }
  }

  // The empty engine passes the frame targets; the synthetic one, by construction,
  // has 829 frames over 16.7 ms, 286 over 33 ms and 16 over 100 ms (see
  // syntheticBusyMs).
  for (const result of outputs["noop"]!.results) {
    const t = result.verdictInputs.targets;
    // An isolated frame may be delayed by the browser (24 to 35 ms seen in headless
    // runs, with under 1 ms of work); it counts, as it should, but stays rare.
    expect(t.frames16_7.ratio).toBeLessThanOrEqual(0.002);
    expect(t.frames33.ratio).toBeLessThanOrEqual(0.002);
    expect(t.frames16_7.workOver).toBe(0);
    expect(t.stalls.count).toBe(0);
    expect(t.textSharp.pass).toBe(true);
  }
  for (const result of outputs["synthetic"]!.results) {
    const t = result.verdictInputs.targets;
    expect(t.frames16_7.workOver).toBe(829);
    expect(t.frames16_7.count).toBeLessThan(829 * 1.02);
    expect(t.frames33.workOver).toBe(286);
    expect(t.frames33.count).toBeLessThan(286 * 1.02);
    expect(t.stalls.count).toBeGreaterThanOrEqual(16);
    expect(t.stalls.count).toBeLessThanOrEqual(17);
    expect(t.frames16_7.pass).toBe(false);
    expect(t.stalls.pass).toBe(false);
  }
});
