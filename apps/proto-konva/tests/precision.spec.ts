// SPDX-License-Identifier: GPL-3.0-or-later

// Precision of text at zooms far beyond the benchmark's (100 to 10^9), at the end of
// the last line of a large text box far from the world origin, where the node-local
// coordinates Konva hands the canvas are largest. Konva composes transforms in
// float64, but the canvas applies them to glyph outlines in its own precision.
//
// Method: find the left edge of the last glyph on the middle row of the view at zoom
// 100, then zoom in by 10 at a time, re-centring on the edge each time. At each zoom,
// move the camera by exactly one screen pixel and check that the edge moves by one
// pixel. Saves results/precision-<project>.json and
// results/precision-<project>-zoom-<zoom>.png.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openPlayground, RESULTS_DIR, setCamera } from "./playground.ts";

const ZOOMS = [100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/** Columns of the middle canvas row where text colour starts (left to right). */
function edges(page: Page, color: string): Promise<number[]> {
  return page.evaluate((color) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".stage canvas")!;
    const ctx = canvas.getContext("2d")!;
    const y = Math.floor(canvas.height / 2);
    const row = ctx.getImageData(0, y, canvas.width, 1).data;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const isText = (i: number) =>
      Math.abs(row[i * 4]! - r) +
        Math.abs(row[i * 4 + 1]! - g) +
        Math.abs(row[i * 4 + 2]! - b) <
      90;
    const found: number[] = [];
    for (let x = 1; x < canvas.width; x++) if (isText(x) && !isText(x - 1)) found.push(x);
    return found;
  }, color);
}

const nearest = (values: number[], to: number) =>
  values.reduce<number | null>(
    (best, v) => (best === null || Math.abs(v - to) < Math.abs(best - to) ? v : best),
    null,
  );

test("text precision at extreme zoom", async ({ page, browserName }, testInfo) => {
  const project = testInfo.project.name;
  test.skip(browserName !== "chromium", "Runs in Chromium");
  await openPlayground(page);
  const target = await page.evaluate(() => {
    const api = window.protoKonva!;
    let best: { id: string; lines: number } | undefined;
    for (const e of api.scene.elements) {
      if (e.kind !== "text" || e.rotation !== 0 || e.align !== "left" || e.opacity !== 1)
        continue;
      const lines = api.engine.textLines(e.id).length;
      if (best === undefined || lines > best.lines) best = { id: e.id, lines };
    }
    const e = api.scene.elements.find((x) => x.id === best!.id)!;
    if (e.kind !== "text") throw new Error("not text");
    const lines = api.engine.textLines(e.id);
    const last = lines[lines.length - 1]!;
    const lineHeight = e.fontSize * e.lineHeight;
    return {
      id: e.id,
      color: e.color,
      fontSize: e.fontSize,
      lines: lines.length,
      lastLine: last.text,
      // Somewhere in the last glyph of the last line, at about x-height.
      x: e.x + last.width - e.fontSize * 0.3,
      y: e.y + (lines.length - 0.5) * lineHeight + e.fontSize * 0.1,
    };
  });

  const centre = 640;
  let edgeX = target.x;
  const rows: {
    zoom: number;
    edgeOffsetPx: number | null;
    onePixelShiftMovesEdgeBy: number | null;
    drawMs: number;
  }[] = [];
  for (const zoom of ZOOMS) {
    const drawMs = await page.evaluate(
      async (pose) => {
        const start = performance.now();
        await window.protoKonva!.setCamera(pose);
        return Math.round(performance.now() - start);
      },
      { x: edgeX, y: target.y, zoom },
    );
    const before = nearest(await edges(page, target.color), centre);
    await page
      .locator(".stage")
      .screenshot({ path: join(RESULTS_DIR, `precision-${project}-zoom-${zoom}.png`) });
    // Move the camera one screen pixel to the right: the edge should move one left.
    await setCamera(page, { x: edgeX + 1 / zoom, y: target.y, zoom });
    const after =
      before === null ? null : nearest(await edges(page, target.color), before);
    rows.push({
      zoom,
      edgeOffsetPx: before === null ? null : before - centre,
      onePixelShiftMovesEdgeBy: before === null || after === null ? null : after - before,
      drawMs,
    });
    // Re-centre on the edge for the next zoom.
    if (before !== null) edgeX += (before - centre) / zoom;
  }
  writeFileSync(
    join(RESULTS_DIR, `precision-${project}.json`),
    `${JSON.stringify({ userAgent: await page.evaluate(() => navigator.userAgent), target, rows }, null, 2)}\n`,
  );
  console.log(rows);
  expect(rows[0]!.edgeOffsetPx).not.toBeNull();
});
