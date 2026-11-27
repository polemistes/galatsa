// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshot test of every shape kind: the shape gallery (apps/web/shapes.html)
// draws each kind in the same set of cases with the real renderer, and each
// kind's canvas is compared with its stored picture,
// shapes-visual.spec.ts-snapshots/<kind>-<project>-<platform>.png. The
// pixels come from the canvas itself (toDataURL), not from a screenshot of the
// page, so the compositor, scroll bars and the screen's pixel ratio play no
// part.
//
// A new kind is picked up from the gallery. Its pictures are made by running
//
//   pnpm --filter @galatsa/e2e exec playwright test shapes-visual.spec.ts \
//     --project=chromium --project=editor-firefox --update-snapshots=missing
//
// which writes the pictures that are missing and passes; they are looked at
// and checked in. Until they are, `pnpm check` fails
// (scripts/lib/shape-pictures.test.ts checks that every listed kind has its
// pictures), and a run of this test without the option fails on them.
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
    // Rendering is deterministic in one browser build (the same pictures in
    // runs after each other). The allowance is small on purpose: a colour
    // channel may differ by about 1 % in a few pixels, which covers rounding
    // on another machine with the same build, while a changed cap, join,
    // colour, opacity or a half-unit change of the outline width fails.
    expect.soft(Buffer.from(png, "base64")).toMatchSnapshot(`${kind}.png`, {
      threshold: 0.01,
      maxDiffPixels: 8,
    });
  }
  expect(errors).toEqual([]);
});
