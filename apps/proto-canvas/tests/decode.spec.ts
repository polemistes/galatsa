// SPDX-License-Identifier: GPL-3.0-or-later

// Experiment: what does it cost to get a 256-pixel thumbnail of a large JPEG?
// Compares createImageBitmap with resize options against WebCodecs ImageDecoder
// with desiredWidth/desiredHeight (which may decode at reduced size), by decode
// time and by the memory of the browser's processes. Prints the numbers and saves
// them to results/decode-<project>.json. Not part of the engine's acceptance.

import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { ProcessMemorySampler } from "./process-memory.ts";

const COUNT = 24;
const WIDTH = 4000;
const HEIGHT = 3000;

test("thumbnail decoding: createImageBitmap resize vs ImageDecoder", async ({
  page,
}, testInfo) => {
  test.setTimeout(10 * 60_000);
  const results: Record<string, unknown>[] = [];
  for (const method of ["bitmap", "imagedecoder"] as const) {
    await page.goto("/demo.html?width=200&height=100");
    const supported = await page.evaluate(() => "ImageDecoder" in window);
    if (method === "imagedecoder" && !supported) {
      results.push({ method, supported: false });
      continue;
    }
    // Generate the JPEG files in the page (12 MP each).
    await page.evaluate(
      async ({ count, width, height }) => {
        const blobs: Blob[] = [];
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d")!;
        for (let i = 0; i < count; i++) {
          const g = ctx.createLinearGradient(0, 0, width, height);
          g.addColorStop(0, `hsl(${i * 37}, 70%, 50%)`);
          g.addColorStop(1, `hsl(${i * 37 + 120}, 70%, 40%)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, width, height);
          for (let k = 0; k < 400; k++) {
            ctx.fillStyle = `hsl(${(k * 13 + i) % 360}, 60%, 60%)`;
            ctx.fillRect((k * 997) % width, (k * 613) % height, 120, 80);
          }
          blobs.push(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
        }
        (window as unknown as { blobs: Blob[] }).blobs = blobs;
      },
      { count: COUNT, width: WIDTH, height: HEIGHT },
    );
    const memory = new ProcessMemorySampler();
    // Let the generation garbage settle.
    await page.waitForTimeout(3000);
    const before = memory.sample()?.pssBytes ?? 0;
    memory.begin(200);
    const timing = await page.evaluate(
      async ({ method, width, height }) => {
        const blobs = (window as unknown as { blobs: Blob[] }).blobs;
        const w = Math.round(width / 16);
        const h = Math.round(height / 16);
        const kept: ImageBitmap[] = [];
        const times: number[] = [];
        const sizes: string[] = [];
        const one = async (blob: Blob) => {
          const t0 = performance.now();
          let bitmap: ImageBitmap;
          if (method === "bitmap") {
            bitmap = await createImageBitmap(blob, {
              resizeWidth: w,
              resizeHeight: h,
              resizeQuality: "medium",
            });
          } else {
            const decoder = new ImageDecoder({
              data: blob.stream(),
              type: blob.type,
              desiredWidth: w,
              desiredHeight: h,
            });
            const { image } = await decoder.decode();
            sizes.push(`${image.displayWidth}x${image.displayHeight}`);
            bitmap = await createImageBitmap(image, {
              resizeWidth: w,
              resizeHeight: h,
              resizeQuality: "medium",
            });
            image.close();
            decoder.close();
          }
          times.push(performance.now() - t0);
          kept.push(bitmap);
        };
        const start = performance.now();
        const queue = [...blobs];
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let b = queue.shift(); b !== undefined; b = queue.shift()) await one(b);
          }),
        );
        const total = performance.now() - start;
        (window as unknown as { kept: ImageBitmap[] }).kept = kept;
        times.sort((a, b) => a - b);
        return {
          totalMs: Math.round(total),
          medianMs: Math.round(times[times.length >> 1]!),
          maxMs: Math.round(times[times.length - 1]!),
          decodedFrameSizes: [...new Set(sizes)],
        };
      },
      { method, width: WIDTH, height: HEIGHT },
    );
    await page.waitForTimeout(3000);
    memory.end();
    const after = memory.samples.at(-1)!.pssBytes;
    const peak = memory.peak();
    results.push({
      method,
      supported: true,
      ...timing,
      pssBeforeMiB: Math.round(before / 2 ** 20),
      pssPeakMiB: Math.round(peak / 2 ** 20),
      pssAfter3sMiB: Math.round(after / 2 ** 20),
    });
  }
  console.log(JSON.stringify(results, null, 1));
  writeFileSync(
    new URL(`../results/decode-${testInfo.project.name}.json`, import.meta.url),
    `${JSON.stringify({ count: COUNT, width: WIDTH, height: HEIGHT, results }, null, 1)}\n`,
  );
});
