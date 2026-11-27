// SPDX-License-Identifier: GPL-3.0-or-later

// What the renderer hands a real canvas, checked by its pixels in each browser
// (bench/canvas-check.html): a clipped closed outline keeps the join at its
// corner, and a stroke far wider than the screen moves exactly one device pixel
// per pixel of camera movement at deep zoom.

import { expect, test } from "@playwright/test";

/** What bench/src/canvas-check.ts puts on the page. */
interface CanvasCheck {
  cornerDarkness(): number;
  thickEdges(zoom: number, steps: number): number[];
}
type CheckWindow = Window & { galatsaCanvasCheck?: CanvasCheck };

test.beforeEach(async ({ page }) => {
  await page.goto("/canvas-check.html");
  await page.waitForFunction(
    () => (window as CheckWindow).galatsaCanvasCheck !== undefined,
  );
});

test("a clipped closed outline keeps its corner", async ({ page }) => {
  const darkness = await page.evaluate(() =>
    (window as CheckWindow).galatsaCanvasCheck!.cornerDarkness(),
  );
  expect(darkness).toBeGreaterThan(200);
});

for (const zoom of [2 ** 14, 2 ** 20, 2 ** 24]) {
  test(`a thick stroke moves one pixel per step at zoom 2^${Math.log2(zoom)}`, async ({
    page,
  }) => {
    const edges = await page.evaluate(
      (z) => (window as CheckWindow).galatsaCanvasCheck!.thickEdges(z, 6),
      zoom,
    );
    expect(edges[0]).toBeGreaterThanOrEqual(199);
    expect(edges[0]).toBeLessThanOrEqual(201);
    expect(edges.map((x) => x - edges[0]!)).toEqual([0, 1, 2, 3, 4, 5]);
  });
}
