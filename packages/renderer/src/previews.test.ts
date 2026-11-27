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

describe("versions that fail, and the budget", () => {
  it("draws another version while a stored one does not decode, and tells the source", async () => {
    let now = 0;
    const failed: string[] = [];
    const source: ImageSource = {
      levels: () => [
        { width: 256, height: 192 },
        { width: 4000, height: 3000 },
      ],
      blob: (_asset, level) => new Blob([String(level)], { type: "image/webp" }),
      failed: (asset, level) => failed.push(`${asset}:${level}`),
    };
    const cache = new ImageCache(source, {
      now: () => now,
      decode: async (blob, width, height): Promise<Decoded> => {
        if ((await blob.text()) === "0") throw new Error("does not decode");
        return { image: {} as CanvasImageSource, width, height, close: () => {} };
      },
    });
    const states: string[] = [];
    for (let frame = 0; frame < 6; frame++) {
      cache.beginFrame();
      states.push(cache.pick("a", 100).state);
      cache.endFrame();
      await cache.settle();
      now += 10;
    }
    expect(failed).toEqual(["a:0"]);
    // The original stands in for the version that does not decode.
    expect(states.at(-1)).toBe("drawn");
    cache.dispose();
  });

  it("counts a large smallest version in the byte budget, so it can be closed", async () => {
    const source: ImageSource = {
      levels: (asset) => [{ width: asset === "big" ? 2000 : 256, height: 1000 }],
      blob: () => new Blob(["x"]),
    };
    let closed = 0;
    const cache = new ImageCache(source, {
      budgetBytes: 1,
      decode: async (_blob, width, height): Promise<Decoded> => ({
        image: {} as CanvasImageSource,
        width,
        height,
        close: () => closed++,
      }),
    });
    await cache.preload(["big", "small"], 1);
    cache.beginFrame();
    cache.endFrame();
    // 2000 by 1000 is over KEPT_PIXELS: closed to keep the budget; 256 by 1000 is kept.
    expect(closed).toBe(1);
    expect(cache.stats.decodedBytes).toBe(256 * 1000 * 4);
    cache.dispose();
  });
});
