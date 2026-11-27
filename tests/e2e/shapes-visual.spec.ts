// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshot test of every shape kind: the shape gallery (apps/web/shapes.html)
// draws each kind in the same set of cases with the real renderer, and each
// kind's canvas is compared with its stored picture,
// shapes-visual.spec.ts-snapshots/<kind>-<project>-<platform>.png. The
// pixels come from the canvas itself (toDataURL), not from a screenshot of the
// page, so the compositor, scroll bars and the screen's pixel ratio play no
// part.
//
// A new kind is picked up from the gallery; its first run fails and writes the
// picture, which is looked at and checked in:
//
//   pnpm --filter @galatsa/e2e exec playwright test shapes-visual.spec.ts \
//     --project=chromium --project=editor-firefox --update-snapshots=missing
//
// Pictures are made per browser and platform; only Chromium and Firefox on
// Linux are stored so far.

import { expect, test } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/shapes.html?lang=en`;

test("every shape kind looks as stored", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(URL);
  const kinds = await page.evaluate(
    () =>
      (window as unknown as { galatsaShapeGallery: { ready: Promise<string[]> } })
        .galatsaShapeGallery.ready,
  );
  expect(kinds.length).toBeGreaterThanOrEqual(3);
  for (const kind of kinds) {
    const png = await page.evaluate((k) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `canvas[data-kind="${k}"]`,
      )!;
      return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    }, kind);
    // Rendering is deterministic in one browser build; the small allowance
    // covers antialiasing differences between machines with the same build.
    expect.soft(Buffer.from(png, "base64")).toMatchSnapshot(`${kind}.png`, {
      maxDiffPixelRatio: 0.002,
    });
  }
  expect(errors).toEqual([]);
});
