// SPDX-License-Identifier: GPL-3.0-or-later

// How the textarea overlay used for editing compares with the canvas text:
// 1. Screenshots of the overlay at zoom 0.1, 1, 8 and 40 in both sizing modes, with
//    the first word selected, saved to results/overlay-<mode>-zoom-<zoom>.png (the
//    canvas text at the same camera is results/text-chromium-dpr1-zoom-<zoom>.png).
// 2. Line-break agreement: for every text box of the scene, the number of lines the
//    browser's own layout gives (an element styled like the overlay) against the
//    number of lines Konva wrapped the text into. Saved to
//    results/overlay-wrap-<browser>.json.

import { writeFileSync } from "node:fs";
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

for (const mode of ["screen", "scaled"] as const) {
  test(`overlay screenshots, ${mode} mode`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots are taken in Chromium");
    await openPlayground(page, `?edit=${mode}`);
    const id = await zoomTargetId(page);
    const box = await textBox(page, id);
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
      // The same cameras as screenshots.spec.ts.
      const pose =
        zoom <= 1
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom }
          : {
              x: lineX - 24 / zoom + 640 / zoom,
              y: box.y - 24 / zoom + 360 / zoom,
              zoom,
            };
      await setCamera(page, pose);
      await page.evaluate((id) => window.protoKonva!.engine.beginEdit(id), id);
      const textarea = page.locator("textarea.galatsa-text-editor");
      await expect(textarea).toBeFocused();
      // Select the first word.
      await page.evaluate(() => {
        const t = window.protoKonva!.engine.textarea!;
        t.setSelectionRange(0, t.value.indexOf(" "));
      });
      await page.evaluate(() => window.protoKonva!.nextFrame());
      await page
        .locator(".stage")
        .screenshot({ path: join(RESULTS_DIR, `overlay-${mode}-zoom-${zoom}.png`) });
      await page.evaluate(() => window.protoKonva!.engine.endEdit());
      await expect(textarea).toBeHidden();
    }
  });
}

test("line breaks of the overlay against Konva's", async ({ page, browserName }) => {
  await openPlayground(page);
  const report = await page.evaluate((zooms) => {
    const api = window.protoKonva!;
    const probe = document.createElement("div");
    Object.assign(probe.style, {
      position: "absolute",
      left: "0",
      top: "0",
      visibility: "hidden",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      padding: "0",
      margin: "0",
      border: "0",
    });
    document.body.append(probe);
    const texts = api.scene.elements.filter((e) => e.kind === "text");
    const rows: {
      sizing: string;
      zoom: number;
      boxes: number;
      differentLineCount: number;
      examples: { id: string; fontPx: number; konva: number; browser: number }[];
    }[] = [];
    // "scaled" lays out at world size whatever the zoom: the same as "screen" at 1.
    for (const zoom of zooms) {
      let different = 0;
      const examples: { id: string; fontPx: number; konva: number; browser: number }[] =
        [];
      for (const e of texts) {
        if (e.kind !== "text") continue;
        const fontPx = e.fontSize * zoom;
        probe.style.fontFamily = e.fontFamily;
        probe.style.fontWeight = String(e.fontWeight);
        probe.style.fontSize = `${fontPx}px`;
        probe.style.lineHeight = String(e.lineHeight);
        probe.style.width = `${e.width * zoom}px`;
        probe.textContent = e.text;
        const browserLines = Math.round(
          probe.getBoundingClientRect().height / (fontPx * e.lineHeight),
        );
        const konvaLines = api.engine.textLines(e.id).length;
        if (browserLines !== konvaLines) {
          different++;
          if (examples.length < 5)
            examples.push({ id: e.id, fontPx, konva: konvaLines, browser: browserLines });
        }
      }
      rows.push({
        sizing: zoom === 1 ? "screen at zoom 1, and scaled at any zoom" : "screen",
        zoom,
        boxes: texts.length,
        differentLineCount: different,
        examples,
      });
    }
    probe.remove();
    return { userAgent: navigator.userAgent, rows };
  }, ZOOMS);
  writeFileSync(
    join(RESULTS_DIR, `overlay-wrap-${browserName}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report.rows.map((r) => [r.zoom, r.differentLineCount])));
  expect(report.rows).toHaveLength(ZOOMS.length);
});
