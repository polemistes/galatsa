// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshots of the same text at zoom 0.1, 1, 8 and 40, with the camera still, and
// screenshots taken while the camera moves and in the frames after it stops, to show
// how sharp the text is at each point. Saved under
// results/<project>/text/<variant>-*.png, with a summary.json of sharpness scores
// (mean brightness difference between neighbouring pixels) and the time until the
// engine reported sharp text.

import { mkdirSync, writeFileSync } from "node:fs";
import type { CameraPose } from "@galatsa/bench";
import { expect, type Page, test } from "@playwright/test";
import type { LabScene } from "../src/lab.ts";

const RESULTS = new URL("../results/", import.meta.url);
const X = 28800;
const Y = 6600;
const CLIP = { x: 0, y: 0, width: 1280, height: 720 };

const VARIANTS = (
  process.env["TEXT_VARIANTS"] ?? "dom,dom-wc-text,dom-screen,dom-layer,dom-layer-wc"
).split(",");

/** The camera for each zoom: the whole card at 0.1 and 1, the body text start at 8 and 40. */
function still(zoom: number): CameraPose {
  if (zoom <= 1) return { x: X + 250, y: Y + 160, zoom };
  if (zoom <= 8) return { x: X + 70, y: Y + 110, zoom };
  return { x: X + 14, y: Y + 78, zoom };
}

async function init(page: Page, variant: string, scene: LabScene) {
  await page.goto("/lab.html");
  await page.waitForFunction(() => window.protoLab !== undefined);
  await page.evaluate(
    ([v, s]) => window.protoLab!.init(v!, s as LabScene),
    [variant, scene],
  );
}

async function shot(page: Page, file: URL): Promise<number> {
  const png = await page.screenshot({ clip: CLIP });
  writeFileSync(file, png);
  return page.evaluate((b64) => window.protoLab!.sharpness(b64), png.toString("base64"));
}

for (const variant of VARIANTS) {
  test(`text at four zooms, moving and after stopping: ${variant}`, async ({
    page,
  }, testInfo) => {
    const folder = new URL(`${testInfo.project.name}/text/`, RESULTS);
    mkdirSync(folder, { recursive: true });
    const summary: Record<string, unknown> = { variant, project: testInfo.project.name };
    await init(page, variant, "text");

    // Still camera.
    for (const zoom of [0.1, 1, 8, 40]) {
      await page.evaluate((pose) => window.protoLab!.setCamera(pose), still(zoom));
      const latency = await page.evaluate(() => window.protoLab!.waitSharp(5000));
      await page.evaluate(() => window.protoLab!.frames(2));
      summary[`still-${zoom}`] = {
        sharpness: await shot(page, new URL(`${variant}-zoom-${zoom}.png`, folder)),
        reportedSharpAfterMs: latency,
      };
      expect(latency, `zoom ${zoom}: sharp text reported`).not.toBeNull();
    }
    // Fine print (3 world units) at zoom 40.
    await page.evaluate((pose) => window.protoLab!.setCamera(pose), {
      x: X + 16,
      y: Y + 207,
      zoom: 40,
    });
    await page.evaluate(() => window.protoLab!.waitSharp(5000));
    await page.evaluate(() => window.protoLab!.frames(2));
    summary["still-fine-40"] = {
      sharpness: await shot(page, new URL(`${variant}-fine-zoom-40.png`, folder)),
    };

    // Moving: from a still camera at zoom `from` to zoom `to` over 30 frames, then
    // keep moving (by a millionth of a pixel) and take a screenshot; stop and take
    // screenshots one and two frames later and once the engine reports sharp text.
    for (const [from, to] of [
      [1, 8],
      [8, 40],
    ] as const) {
      const name = `${variant}-move-${from}-to-${to}`;
      await page.evaluate((pose) => window.protoLab!.setCamera(pose), still(from));
      await page.evaluate(() => window.protoLab!.waitSharp(5000));
      await page.evaluate(() => window.protoLab!.frames(2));
      const target = { ...still(to) };
      await page.evaluate((pose) => window.protoLab!.play(pose, 30, true), target);
      await page.evaluate(() => window.protoLab!.frames(3));
      const during = await shot(page, new URL(`${name}-during.png`, folder));
      const sharp = page.evaluate(() => window.protoLab!.waitSharp(5000));
      await page.evaluate(() => window.protoLab!.stop());
      await page.evaluate(() => window.protoLab!.frames(1));
      const after1 = await shot(page, new URL(`${name}-after-1-frame.png`, folder));
      await page.evaluate(() => window.protoLab!.frames(1));
      const after2 = await shot(page, new URL(`${name}-after-2-frames.png`, folder));
      const latency = await sharp;
      await page.evaluate(() => window.protoLab!.frames(2));
      const afterSharp = await shot(page, new URL(`${name}-after-sharp.png`, folder));
      await page.evaluate(() => window.protoLab!.frames(30));
      const afterHalfSecond = await shot(
        page,
        new URL(`${name}-after-30-frames.png`, folder),
      );
      summary[`move-${from}-to-${to}`] = {
        sharpness: { during, after1, after2, afterSharp, afterHalfSecond },
        reportedSharpAfterMs: latency,
      };
    }
    writeFileSync(
      new URL(`${variant}-summary.json`, folder),
      JSON.stringify(summary, null, 1),
    );
    console.log(JSON.stringify(summary));
  });
}
