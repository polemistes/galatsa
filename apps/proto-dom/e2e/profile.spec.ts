// SPDX-License-Identifier: GPL-3.0-or-later

// Where the time goes, in Chromium: records a performance trace of one camera run
// and adds up the browser's own work per thread and kind (style, layout, paint,
// raster, ...), for each kind of camera segment. Opt-in, because the trace is large:
// PROFILE_VARIANT=dom pnpm e2e --project=chromium profile
// Writes results/<project>/profile-<variant>.json (the summary, not the trace).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessOutput } from "@galatsa/bench/harness";
import { expect, test } from "@playwright/test";

const RESULTS = new URL("../results/", import.meta.url);
const VARIANT = process.env["PROFILE_VARIANT"];

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

// Event names worth adding up; others are summed as "other" on the main thread.
const KINDS = [
  "FireAnimationFrame",
  "UpdateLayoutTree",
  "Layout",
  "PrePaint",
  "Paint",
  "Layerize",
  "UpdateLayer",
  "Commit",
  "RasterTask",
  "ImageDecodeTask",
  "Decode Image",
  "GPUTask",
  "MajorGC",
  "MinorGC",
  "V8.GC_MC_BACKGROUND_MARKING",
];

test("profile one camera run", async ({ page, browser, browserName }, testInfo) => {
  test.skip(VARIANT === undefined || browserName !== "chromium", "opt-in, Chromium only");
  test.setTimeout(15 * 60_000);
  await page.goto(`/?engine=${VARIANT}`);
  await expect(page.getByRole("status")).toBeVisible();
  // Generate the images first, outside the trace, with a run of the same variant.
  await page.evaluate((id) => window.galatsaBench!.run(1, id), VARIANT!);
  const tracePath = join(tmpdir(), `proto-dom-trace-${process.pid}.json`);
  await browser.startTracing(page, {
    path: tracePath,
    categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"],
  });
  const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
  const output = (await page.evaluate(
    (id) => window.galatsaBench!.run(1, id),
    VARIANT!,
  )) as HarnessOutput;
  await browser.stopTracing();
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as
    { traceEvents: TraceEvent[] } | TraceEvent[];
  rmSync(tracePath);
  const events = Array.isArray(trace) ? trace : trace.traceEvents;

  // Thread names.
  const threadName = new Map<string, string>();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name" && e.args?.name)
      threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  // The run's frames: find the FireAnimationFrame events on the renderer main thread
  // and the segment each belongs to, by time.
  const result = output.results[0]!;
  const totals: Record<string, Record<string, number>> = {};
  const add = (thread: string, kind: string, ms: number) => {
    totals[thread] ??= {};
    totals[thread]![kind] = (totals[thread]![kind] ?? 0) + ms;
  };
  for (const e of events) {
    if (e.ph !== "X" || e.dur === undefined) continue;
    if (!KINDS.includes(e.name)) continue;
    const thread = (threadName.get(`${e.pid}:${e.tid}`) ?? "?").replace(/\d+$/, "");
    add(thread, e.name, e.dur / 1000);
  }
  for (const t of Object.values(totals))
    for (const k of Object.keys(t)) t[k] = Math.round(t[k]!);
  const summary = {
    variant: VARIANT,
    project: testInfo.project.name,
    note: "Milliseconds summed over one camera run, per thread and event (nested events overlap: Paint includes nothing of Layout, but RasterTask includes image decodes on the same thread)",
    traceStartedAtMs: t0,
    runMs: Math.round(result.timings.runMs),
    renderScriptMs: Math.round(result.frames.scriptMs.reduce((a, b) => a + b, 0)),
    totals,
  };
  const folder = new URL(`${testInfo.project.name}/`, RESULTS);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    new URL(`profile-${VARIANT}.json`, folder),
    JSON.stringify(summary, null, 1),
  );
  console.log(JSON.stringify(summary, null, 1));
});
