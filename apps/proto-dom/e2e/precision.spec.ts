// SPDX-License-Identifier: GPL-3.0-or-later

// Precision at extreme zoom: when the camera moves by one screen pixel, does an edge
// on screen move by one pixel? Two edges: the left edge of the stem of a glyph "H"
// (12 world units, at x = 28800) and the left edge of a rectangle. The camera homes
// in on each edge with zoom 10, 100, ... 10^8, then moves right by 1 / zoom world
// units three times; the edge should move left by 1 pixel each time. Results go to
// results/<project>/precision-<variant>.json, with screenshots of the glyph edge.

import { mkdirSync, writeFileSync } from "node:fs";
import type { CameraPose } from "@galatsa/bench";
import { type Page, test } from "@playwright/test";

const RESULTS = new URL("../results/", import.meta.url);
const X = 28800;
const Y = 6600;
const W = 1280;
const ROW = 360;
const VARIANTS = (process.env["PRECISION_VARIANTS"] ?? "dom,dom-layer").split(",");

async function edgeAt(
  page: Page,
  pose: CameraPose,
): Promise<{ edge: number | null; png: Buffer }> {
  await page.evaluate((p) => window.protoLab!.setCamera(p), pose);
  // Wait until the engine has laid the text out for this zoom, then two frames.
  await page.evaluate(() => window.protoLab!.waitSharp(3000));
  await page.evaluate(() => window.protoLab!.frames(2));
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: 720 } });
  const edge = await page.evaluate(
    ([b64, row]) => window.protoLab!.findEdge(b64 as string, row as number, 0, 1280),
    [png.toString("base64"), ROW] as const,
  );
  return { edge, png };
}

for (const variant of VARIANTS) {
  test(`one-pixel camera moves at extreme zoom: ${variant}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const folder = new URL(`${testInfo.project.name}/`, RESULTS);
    mkdirSync(new URL("precision/", folder), { recursive: true });
    await page.goto("/lab.html");
    await page.waitForFunction(() => window.protoLab !== undefined);
    await page.evaluate((v) => window.protoLab!.init(v, "precision"), variant);

    const targets = [
      // Middle of the glyph's height; the stem edge is found at zoom 10.
      { name: "glyph", y: Y + 6, startX: X + 20, knownEdge: null as number | null },
      // The rectangle's left edge is at exactly X + 100.
      { name: "rect", y: Y + 50, startX: X + 100, knownEdge: X + 100 },
    ];
    const report: Record<string, unknown[]> = {};
    for (const target of targets) {
      const rows: unknown[] = [];
      let edgeWorld: number | null = null;
      // Find the edge at zoom 10 by scanning the whole row.
      {
        const zoom = 10;
        const { edge } = await edgeAt(page, { x: target.startX, y: target.y, zoom });
        if (edge !== null) edgeWorld = target.startX + (edge - W / 2) / zoom;
      }
      for (const zoom of [10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]) {
        if (edgeWorld === null) {
          rows.push({ zoom, note: "edge lost" });
          continue;
        }
        const x0 = edgeWorld;
        const first = await edgeAt(page, { x: x0, y: target.y, zoom });
        if (zoom >= 1e4 && target.name === "glyph") {
          writeFileSync(
            new URL(`precision/${variant}-glyph-zoom-1e${Math.log10(zoom)}.png`, folder),
            first.png,
          );
        }
        const positions: (number | null)[] = [first.edge];
        for (let step = 1; step <= 3; step++) {
          const { edge } = await edgeAt(page, { x: x0 + step / zoom, y: target.y, zoom });
          positions.push(edge);
        }
        const moves = positions
          .slice(1)
          .map((p, i) =>
            p === null || positions[i] === null ? null : positions[i]! - p,
          );
        const expected =
          target.knownEdge === null ? null : W / 2 + (target.knownEdge - x0) * zoom;
        rows.push({
          zoom,
          // Where the edge appeared, in screen pixels from the left (null: not found).
          positions: positions.map((p) =>
            p === null ? null : Math.round(p * 1000) / 1000,
          ),
          // How far the edge moved for each one-pixel camera move (1 is right).
          moves: moves.map((m) => (m === null ? null : Math.round(m * 1000) / 1000)),
          // For the rectangle: where the edge should be, from float64 arithmetic.
          expected: expected === null ? null : Math.round(expected * 1000) / 1000,
        });
        // Home in: the camera centre goes to the edge just measured.
        if (first.edge !== null) edgeWorld = x0 + (first.edge - W / 2) / zoom;
      }
      report[target.name] = rows;
    }
    const out = { variant, project: testInfo.project.name, report };
    writeFileSync(
      new URL(`precision-${variant}.json`, folder),
      JSON.stringify(out, null, 1),
    );
    console.log(JSON.stringify(out, null, 1));
  });
}
