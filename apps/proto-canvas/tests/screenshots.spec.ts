// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshots of the same texts at zoom 0.1, 1, 8 and 40, at device pixel ratio 1
// and 2, saved to results/. At 0.1 and 1 the camera looks at the middle of the
// text box; at 8 and 40 the start of the first line is near the view's top-left.

import { expect, type Page, test } from "@playwright/test";

const ZOOMS = [0.1, 1, 8, 40] as const;
const WIDTH = 960;
const HEIGHT = 540;

/**
 * Texts of the bench scene (version 1) that no later element covers: body text
 * (24 units, sans-serif, with æ, ø, å), a bold heading (102 units) and fine print
 * (4 units, monospace).
 */
const TEXTS = { body: "t0389", heading: "t0534", fineprint: "t0142" } as const;

async function shoot(page: Page, id: string, zoom: number, file: string): Promise<void> {
  await page.evaluate(
    ({ id, zoom, width, height }) => {
      const api = window.protoCanvas!;
      const e = api.engine.textElement(id)!;
      if (zoom < 2) {
        api.setCamera({
          x: e.x + e.width / 2,
          y: e.y + Math.min(e.height, 400) / 2,
          zoom,
        });
        return;
      }
      // Put the start of the first line 24 px from the view's left edge and its
      // middle half a line plus 24 px from the top. If the line is taller than the
      // view, look at the middle of the first letter instead.
      api.setCamera({ x: e.x, y: e.y, zoom });
      const p = api.engine.caretScreenPoint(id, 0)!;
      const lineHalf = (e.fontSize * e.lineHeight * zoom) / 2;
      const pose = {
        x:
          e.x +
          (p.x - width / 2) / zoom +
          (2 * lineHalf > height ? 0.3 * e.fontSize : (width / 2 - 24) / zoom),
        y:
          e.y +
          (p.y - height / 2) / zoom +
          (height / 2 - Math.min(24 + lineHalf, height / 2)) / zoom,
        zoom,
      };
      api.setCamera(pose);
    },
    { id, zoom, width: WIDTH, height: HEIGHT },
  );
  await page.locator("#stage canvas").screenshot({ path: file });
}

for (const dpr of [1, 2]) {
  test.describe(`device pixel ratio ${dpr}`, () => {
    test.use({
      deviceScaleFactor: dpr,
      viewport: { width: WIDTH + 40, height: HEIGHT + 80 },
    });

    test(`text at zoom ${ZOOMS.join(", ")}`, async ({ page }, testInfo) => {
      await page.goto(`/demo.html?width=${WIDTH}&height=${HEIGHT}`);
      await page.waitForFunction(() => window.protoCanvas !== undefined);
      await page.evaluate(() => window.protoCanvas!.ready);
      for (const [name, id] of Object.entries(TEXTS)) {
        for (const zoom of ZOOMS) {
          const file = new URL(
            `../results/text-${name}-${id}-zoom${zoom}-dpr${dpr}-${testInfo.project.name}.png`,
            import.meta.url,
          ).pathname;
          await shoot(page, id, zoom, file);
        }
      }
      expect(await page.evaluate(() => window.protoCanvas!.frames)).toBeGreaterThan(8);
    });
  });
}
