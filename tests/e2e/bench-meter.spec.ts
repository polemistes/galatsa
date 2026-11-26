// SPDX-License-Identifier: GPL-3.0-or-later

// Self-checks of the benchmark meter in a real browser, on short runs.

import type { BenchResult } from "@galatsa/bench";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";

type Bench = typeof import("@galatsa/bench");

// Frames 10-19 block 17 ms, 30-39 block 30 ms, 50-59 block 45 ms, frame 80 blocks
// 110 ms. Expected at 60 Hz: 30 ms frames are missed (over 25 ms), 45 ms frames are
// long (over 41.7 ms), the 110 ms frame is a stall. A 17 ms frame counts as missed
// only where the browser waits for the next display refresh after it (33 ms); headless
// Chromium and Firefox start the next frame at once, so it reads about 17 ms there.
test("the meter counts missed, long and stalled frames", async ({ page }) => {
  await page.goto("/?engine=noop");
  await expect(page.getByRole("status")).toBeVisible();
  const result: BenchResult = await page.evaluate(async () => {
    // The harness dev server serves the bench sources; load them in the page.
    const entry = "/src/index.ts";
    const bench = (await import(entry)) as Bench;
    const scene = bench.generateScene();
    const full = bench.createCameraRun(scene);
    const cameraRun = {
      ...full,
      poses: full.poses.slice(0, 120),
      segments: [{ kind: "pan" as const, label: "slow", start: 0, end: 120 }],
    };
    const blockFor = (frame: number) =>
      frame === 80
        ? 110
        : frame >= 10 && frame < 20
          ? 17
          : frame >= 30 && frame < 40
            ? 30
            : frame >= 50 && frame < 60
              ? 45
              : 0;
    let frame = 0;
    const engine = {
      name: "blocking",
      load: () => Promise.resolve(),
      render: () => {
        const end = performance.now() + blockFor(frame++);
        while (performance.now() < end) {
          // Block the main thread.
        }
      },
      dispose: () => {},
    };
    return bench.runBenchmark({
      engine,
      container: document.querySelector<HTMLElement>(".stage")!,
      images: { encodedBytes: 0, generationMs: 0, getBlob: () => new Blob() },
      scene,
      cameraRun,
      warmupFrames: 0,
      measureMemory: false,
    });
  });
  const v = result.verdictInputs;
  const t = v.targets;
  const at = (series: readonly number[]) =>
    [15, 35, 55, 80].map((i) => series[i]).join("/");
  console.log(
    `${test.info().project.name}: refresh ${v.refreshIntervalMs.toFixed(3)} ms; over 16.7 ms ${t.frames16_7.count} (work ${t.frames16_7.workOver}, display ${t.frames16_7.presentedOver}), over 33 ms ${t.frames33.count}, stalls ${t.stalls.count}, missed refreshes ${v.missedRefreshes.count}; ` +
      `frames 15/35/55/80: work ${at(result.frames.workMs)} ms, wall ${at(result.frames.frameMs)} ms, timestamps ${at(result.frames.timestampMs)} ms`,
  );
  expect(v.refreshIntervalMs).toBeGreaterThan(15);
  expect(v.refreshIntervalMs).toBeLessThan(18.5);
  // By work time every blocked frame is counted, whether or not the browser waits
  // for the next refresh after it: 10 + 10 + 10 + 1 over 16.7 ms, 10 + 1 over 33 ms.
  expect(t.frames16_7.count).toBe(31);
  expect(t.frames16_7.workOver).toBe(31);
  expect(t.frames33.count).toBe(11);
  expect(t.stalls.count).toBe(1);
  expect(result.frames.workMs[15]).toBeGreaterThanOrEqual(17);
  expect(result.frames.workMs[80]).toBeGreaterThanOrEqual(110);
  expect(result.frames.frameMs[80]).toBeGreaterThanOrEqual(110);
  // The display-native count depends on whether the browser waits for vsync after a
  // late frame (headless browsers do not): 21 to 31.
  expect(v.missedRefreshes.count).toBeGreaterThanOrEqual(21);
  expect(v.missedRefreshes.count).toBeLessThanOrEqual(31);
});

test("the harness refuses to run when the stage does not fit in the window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto("/?engine=noop");
  await expect(page.getByRole("status")).toContainText("does not fit in the window");
  const error = await page.evaluate(() =>
    window.galatsaBench!.run(1, "noop").then(
      () => "ran",
      (e: unknown) => String(e),
    ),
  );
  expect(error).toContain("does not fit in the window");
});

test("the stage stays in place between runs", async ({ page }) => {
  await page.goto("/?engine=noop");
  const before = await page.locator(".stage").boundingBox();
  await page.locator("pre").evaluate((pre) => {
    pre.textContent = "line\n".repeat(40);
  });
  const after = await page.locator(".stage").boundingBox();
  expect(before).toEqual({ x: 0, y: 0, width: 960, height: 540 });
  expect(after).toEqual(before);
});

test("nothing can cover the stage, even after scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/?engine=noop");
  await page.locator("pre").evaluate((pre) => {
    pre.textContent = "line\n".repeat(200);
  });
  await page.evaluate(() => window.scrollTo(0, 500));
  const hits = await page.evaluate(() => {
    const stage = document.querySelector(".stage")!;
    return [
      [480, 270],
      [2, 2],
      [957, 537],
    ].map(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (hit === stage || stage.contains(hit));
    });
  });
  expect(hits).toEqual([true, true, true]);
});

test("capture runs keep an image at the end of each hold", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "One browser is enough for this check.");
  test.setTimeout(5 * 60_000);
  // The host (here Playwright) takes screenshots for engines without snapshot().
  await page.exposeFunction(
    "takeStageScreenshot",
    async (rect: { x: number; y: number; width: number; height: number }) => {
      const png = await page.screenshot({ clip: rect });
      return `data:image/png;base64,${png.toString("base64")}`;
    },
  );
  await page.goto("/?engine=outline");
  await page.evaluate(() => {
    const take = (
      window as unknown as { takeStageScreenshot: (r: unknown) => Promise<string> }
    ).takeStageScreenshot;
    window.galatsaBenchHostCapture = (rect) => take(rect);
  });
  for (const engine of ["outline", "noop"]) {
    const output: HarnessOutput = await page.evaluate(
      (id) => window.galatsaBench!.run(1, id, { capture: true }),
      engine,
    );
    const result = output.results[0]!;
    const holds = result.cameraRun.segments.filter((s) => s.kind === "hold").length;
    expect(result.captures).toHaveLength(holds);
    expect(result.captures[0]!.by).toBe(engine === "outline" ? "engine" : "host");
    expect(result.captures[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.frames.excluded).toHaveLength(holds);
    expect(result.verdictInputs.frames).toBe(result.cameraRun.frames - holds);
  }
});
