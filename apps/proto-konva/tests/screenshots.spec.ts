// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshots of the same text at zoom 0.1, 1, 8 and 40, at device pixel ratio 1
// and 2, saved to results/. The text is the one the camera run zooms in on. At 0.1
// and 1 the text box is centred; at 8 and 40 the view starts just above and left of
// the start of its first line.

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  openPlayground,
  RESULTS_DIR,
  setCamera,
  textBox,
  zoomTargetId,
} from "./playground.ts";

const ZOOMS = [0.1, 1, 8, 40] as const;
const VIEW = { width: 1280, height: 720 };

for (const dpr of [1, 2]) {
  test.describe(`device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test("the same text at zoom 0.1, 1, 8 and 40", async ({ page, browserName }) => {
      await openPlayground(page);
      const id = await zoomTargetId(page);
      const box = await textBox(page, id);
      // Where the first line starts, after alignment.
      const first = await page.evaluate(
        (id) => window.protoKonva!.engine.textLines(id)[0]!,
        id,
      );
      const lineX =
        box.align === "right"
          ? box.x + box.width - first.width
          : box.align === "center"
            ? box.x + (box.width - first.width) / 2
            : box.x;
      for (const zoom of ZOOMS) {
        const pose =
          zoom <= 1
            ? { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom }
            : {
                x: lineX - 24 / zoom + VIEW.width / 2 / zoom,
                y: box.y - 24 / zoom + VIEW.height / 2 / zoom,
                zoom,
              };
        await setCamera(page, pose);
        const stats = await page.evaluate(() => window.protoKonva!.engine.stats());
        expect(stats.pixelRatio).toBe(dpr);
        await page.locator(".stage").screenshot({
          path: join(RESULTS_DIR, `text-${browserName}-dpr${dpr}-zoom-${zoom}.png`),
        });
      }
    });
  });
}
