// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fillImagePixels, GRID_SPACING } from "./images.ts";
import { hashString } from "./prng.ts";
import type { ImageAsset } from "./scene.ts";

// Pinned hash of the pixels of a small test image.
const SMALL_IMAGE_HASH = "9f958900";

function pixels(asset: ImageAsset): Uint8ClampedArray {
  const data = new Uint8ClampedArray(asset.width * asset.height * 4);
  fillImagePixels(asset, data);
  return data;
}

function hashBytes(data: Uint8ClampedArray): string {
  let text = "";
  for (let i = 0; i < data.length; i += 4096) {
    text += String.fromCharCode(...data.subarray(i, i + 4096));
  }
  return hashString(text);
}

describe("fillImagePixels", () => {
  const asset: ImageAsset = { id: "test", width: 300, height: 200, seed: 12345 };

  it("is the same every time, and matches the pinned hash", () => {
    const a = pixels(asset);
    expect(pixels(asset)).toEqual(a);
    expect(hashBytes(a)).toBe(SMALL_IMAGE_HASH);
  });

  it("depends on the seed", () => {
    expect(pixels({ ...asset, seed: 1 })).not.toEqual(pixels(asset));
  });

  it("is opaque, varied, and has the grid", () => {
    const data = pixels(asset);
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i + 3]).toBe(255);
      colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    }
    expect(colours.size).toBeGreaterThan(1000);
    // A grid pixel is a quarter of the brightness of what it covers, so darker than
    // its neighbour on average along a grid row.
    let gridSum = 0;
    let neighbourSum = 0;
    for (let x = 1; x < asset.width; x++) {
      gridSum += data[(0 * asset.width + x) * 4]!;
      neighbourSum += data[(1 * asset.width + x) * 4]!;
    }
    expect(gridSum).toBeLessThan(neighbourSum);
    expect(GRID_SPACING).toBe(128);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => fillImagePixels(asset, new Uint8ClampedArray(10))).toThrow(RangeError);
  });
});
