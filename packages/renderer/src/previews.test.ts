// SPDX-License-Identifier: GPL-3.0-or-later

// The sizes of reduced versions, the versions of a vector original, and that
// SVG goes to its own decoder (docs/adr/0012). Encoding itself needs a browser
// and is tested in tests/e2e/images.spec.ts.

import { describe, expect, it } from "vitest";
import { ImageCache, versionsOf, type Decoded, type ImageSource } from "./images.ts";
import { previewSizes } from "./previews.ts";

describe("reduced versions", () => {
  it("halves from 256 up to the largest clearly smaller than the original", () => {
    expect(previewSizes(4000, 3000)).toEqual([
      { width: 256, height: 192 },
      { width: 512, height: 384 },
      { width: 1024, height: 768 },
      { width: 2048, height: 1536 },
    ]);
    // A portrait image: by its long side.
    expect(previewSizes(1000, 2000).map((s) => s.height)).toEqual([256, 512, 1024]);
    // Nothing for small images; one for an image just large enough.
    expect(previewSizes(380, 200)).toEqual([]);
    expect(previewSizes(384, 200)).toEqual([{ width: 256, height: 133 }]);
    // Up to 4096 for a huge one, and never a side under one pixel.
    expect(previewSizes(20000, 10).map((s) => s.width)).toEqual([
      256, 512, 1024, 2048, 4096,
    ]);
    expect(previewSizes(20000, 10)[0]!.height).toBe(1);
    expect(previewSizes(0, 0)).toEqual([]);
    expect(previewSizes(Number.NaN, 5)).toEqual([]);
  });

  it("offers a vector original at halves and at multiples of its natural size", () => {
    const levels = [
      { width: 256, height: 128 },
      { width: 1000, height: 500, scalable: true },
    ];
    expect(versionsOf(levels, false).map((v) => [v.level, v.width])).toEqual([
      [0, 256],
      [1, 500],
      [1, 1000],
      [1, 2000],
      [1, 4000],
      [1, 8000],
    ]);
  });

  it("decodes SVG with its own decoder and raster files with the usual one", async () => {
    const decoded: string[] = [];
    const fake =
      (name: string) =>
      async (_blob: Blob, width: number, height: number): Promise<Decoded> => {
        decoded.push(`${name}:${width}`);
        return { image: {} as CanvasImageSource, width, height, close: () => {} };
      };
    const source: ImageSource = {
      levels: (asset) =>
        asset === "svg"
          ? [{ width: 100, height: 100, scalable: true }]
          : [{ width: 100, height: 100 }],
      blob: (asset) =>
        new Blob(["x"], { type: asset === "svg" ? "image/svg+xml" : "image/png" }),
    };
    const cache = new ImageCache(source, {
      decode: fake("raster"),
      decodeSvg: fake("svg"),
    });
    await cache.preload(["svg", "png"], 1);
    expect(decoded.map((d) => d.split(":")[0]).sort()).toEqual(["raster", "svg"]);
    expect(cache.stats.originalLevelDecodes).toBe(2);
    // The raster original at its own size; the SVG at a reduced size.
    expect(cache.stats.originalDecodes).toBe(1);
    cache.dispose();
  });
});
