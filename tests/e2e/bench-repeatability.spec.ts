// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark meter, run twice in a row against the no-op engine in a real
// browser, must give the same numbers within 5 %. Takes about two minutes: the
// images are generated once, then each run is about 46 seconds at 60 Hz.

import { writeFileSync } from "node:fs";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";

test("the meter repeats within 5 % against the no-op engine", async ({
  page,
}, testInfo) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/?engine=noop");
  await expect(page.getByRole("status")).toBeVisible();

  const output: HarnessOutput = await page.evaluate(() => {
    const api = window.galatsaBench;
    if (api === undefined) throw new Error("The harness did not start");
    return api.run(2, "noop");
  });

  const file = testInfo.outputPath("bench-noop-results.json");
  writeFileSync(file, JSON.stringify(output, null, 1));
  const summaries = await page.locator("pre").textContent();
  console.log(`${summaries ?? ""}\n\nFull results: ${file}`);

  expect(output.results).toHaveLength(2);
  for (const result of output.results) {
    expect(result.environment.hiddenDuringRun).toBe(false);
    expect(result.stats.interval.count).toBe(result.cameraRun.frames);
    expect(result.frames.intervalMs).toHaveLength(result.cameraRun.frames);
    expect(result.scene.elements).toBe(2000);
    expect(result.textSharp.missing).toBe(0);
    expect(result.textSharp.reported).toBeGreaterThan(0);
  }
  const comparison = output.comparison;
  expect(comparison).not.toBeNull();
  for (const metric of comparison!.metrics.filter((m) => m.decisive)) {
    expect(metric.relativeDifference, metric.name).toBeLessThanOrEqual(0.05);
  }
  expect(comparison!.agree).toBe(true);
});

// Self-check of the meter: an engine that blocks for 40 ms in every tenth frame, and
// once for 110 ms, must show up as slow frames. Uses the first 120 poses only and no
// images.
test("the meter detects slow frames", async ({ page }) => {
  test.setTimeout(2 * 60_000);
  await page.goto("/?engine=noop");
  await expect(page.getByRole("status")).toBeVisible();

  const result = await page.evaluate(async () => {
    // The harness dev server serves the bench sources; load them in the page.
    const entry = "/src/index.ts";
    const bench = (await import(entry)) as typeof import("@galatsa/bench");
    const scene = bench.generateScene();
    const full = bench.createCameraRun(scene);
    const cameraRun = {
      ...full,
      poses: full.poses.slice(0, 120),
      segments: [{ kind: "pan" as const, label: "slow", start: 0, end: 120 }],
    };
    let frame = 0;
    const busy = {
      name: "busy",
      load: () => Promise.resolve(),
      render: () => {
        const current = frame++;
        const block = current === 55 ? 110 : current % 10 === 0 ? 40 : 0;
        if (block > 0) {
          const end = performance.now() + block;
          while (performance.now() < end) {
            // Block the main thread.
          }
        }
      },
      dispose: () => {},
    };
    const container = document.createElement("div");
    document.body.append(container);
    return bench.runBenchmark({
      engine: busy,
      container,
      images: {
        encodedBytes: 0,
        generationMs: 0,
        getBlob: () => {
          throw new Error("not used");
        },
      },
      scene,
      cameraRun,
      warmupFrames: 0,
      measureMemory: false,
    });
  });

  const interval = result.stats.interval;
  const callback = result.stats.callbackInterval;
  console.log(
    [
      `busy engine, timestamps: p50 ${interval.p50} ms, max ${interval.max} ms, over ${JSON.stringify(interval.over)}`,
      `busy engine, callbacks:  p50 ${callback.p50} ms, max ${callback.max} ms, over ${JSON.stringify(callback.over)}`,
      `frame 10: timestamp ${result.frames.intervalMs[10]} ms, callback ${result.frames.callbackIntervalMs[10]} ms`,
      `frame 55: timestamp ${result.frames.intervalMs[55]} ms, callback ${result.frames.callbackIntervalMs[55]} ms`,
    ].join("\n"),
  );
  // Frames 0, 10, ..., 110 block for 40 ms and frame 55 for 110 ms: 13 slow frames.
  expect(result.stats.script.over["33"]).toBe(13);
  expect(result.stats.script.over["100"]).toBe(1);
  expect(interval.over["33"]).toBe(13);
  expect(interval.p50).toBeLessThan(20);
  // Wall-clock callback intervals show the stall at its real length.
  expect(callback.over["33"]).toBe(13);
  expect(callback.over["100"]).toBe(1);
  expect(result.frames.callbackIntervalMs[55]).toBeGreaterThanOrEqual(110);
});
