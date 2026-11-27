// SPDX-License-Identifier: GPL-3.0-or-later

// The camera run with the real renderer (@galatsa/renderer), judged against the
// frame and text targets of the benchmark. RUNS sets the number of runs
// (default 2). The full result is written to the test's output folder.
//
// Memory is sampled from /proc on Linux (PSS of the browser's processes) and
// handed to the meter as the host's sampler, after a run of the empty engine for
// the baseline (the browser, the page and the encoded image files). It is
// reported, not judged: a headless browser's memory says little about the
// desktop app's.
//
//   pnpm --filter @galatsa/e2e exec playwright test bench-renderer --project bench-chromium
//
// Headless browsers pace frames evenly and have no real display, so these
// numbers are a regression check, not a measurement on a user's machine.

import { writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";
import { browserMemory } from "./process-memory.ts";

test("camera run with the renderer", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000);
  const runs = Number(process.env["RUNS"] ?? "2");
  await page.exposeFunction("galatsaHostMemory", () => browserMemory());
  await page.goto("/?engine=renderer");
  await expect(page.getByRole("status")).toBeVisible();
  await page.evaluate(() => {
    const api = window.galatsaBench;
    if (api === undefined) throw new Error("The harness did not start");
    const sample = (
      window as unknown as { galatsaHostMemory?: () => Promise<number | null> }
    ).galatsaHostMemory;
    if (sample === undefined) return;
    api.setMemorySampler({
      source: "PSS of the browser's processes (/proc), sampled by the test",
      sample,
      intervalMs: 500,
    });
  });
  const baseline: HarnessOutput = await page.evaluate(() =>
    window.galatsaBench!.run(1, "noop"),
  );
  const output: HarnessOutput = await page.evaluate(
    (n) => window.galatsaBench!.run(n, "renderer"),
    runs,
  );
  const engine = await page.evaluate(() => {
    const r = (
      window as unknown as {
        galatsaRenderer?: { stats: unknown; imageStats: unknown; decoder: string };
      }
    ).galatsaRenderer;
    return {
      stats: r?.stats ?? null,
      imageStats: r?.imageStats ?? null,
      decoder: r?.decoder ?? "",
    };
  });
  const file = testInfo.outputPath(`bench-renderer-${testInfo.project.name}.json`);
  const baselinePeak = baseline.results[0]?.memory.external.peakBytes ?? null;
  writeFileSync(file, JSON.stringify({ ...output, engine, baselinePeak }, null, 1));
  console.log(`\n=== ${testInfo.project.name}: renderer (${engine.decoder}) ===`);
  console.log(await page.locator("pre").textContent());
  const mb = (b: number | null | undefined) =>
    b == null ? "n/a" : `${(b / 1e6).toFixed(0)} MB`;
  console.log(
    `memory peak: empty engine ${mb(baselinePeak)}, renderer ${output.results.map((r) => mb(r.memory.external.peakBytes)).join(", ")}`,
  );
  console.log(`image decoding: ${JSON.stringify(engine.imageStats)}`);
  console.log(`Full results: ${file}`);

  const chromium = testInfo.project.name.includes("chromium");
  for (const result of output.results) {
    expect(result.environment.hiddenDuringRun).toBe(false);
    expect(result.scene.elements).toBe(2000);
    expect(result.textSharp.missing).toBe(0);
    const t = result.verdictInputs.targets;
    if (chromium) expect(t.frames16_7.pass, "frames within 16.7 ms").toBe(true);
    expect(t.frames33.pass, "frames within 33 ms").toBe(true);
    expect(t.stalls.pass, "no frame over 100 ms").toBe(true);
    expect(t.textSharp.pass, "text sharp within 200 ms").toBe(true);
  }
});
