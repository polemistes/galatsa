// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateScene,
  IMAGE_COUNT,
  MAX_IMAGE_PIXELS,
  MIN_IMAGE_PIXELS,
  type Scene,
  SHAPE_COUNT,
  summarizeScene,
  TEXT_COUNT,
} from "./scene.ts";

// Pinned hash of the default scene. If a change to the generator is intended, bump
// SCENE_VERSION and update this value.
const DEFAULT_SCENE_HASH = "0beb6510";

const scene: Scene = generateScene();

describe("generateScene", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has 2,000 elements: 1,200 shapes, 600 text boxes, 200 images", () => {
    const summary = summarizeScene(scene);
    expect(summary.elements).toBe(2000);
    expect(summary.shapes).toBe(SHAPE_COUNT);
    expect(summary.texts).toBe(TEXT_COUNT);
    expect(summary.images).toBe(IMAGE_COUNT);
    expect(scene.assets).toHaveLength(IMAGE_COUNT);
  });

  it("is the same every time, and matches the pinned hash", () => {
    expect(generateScene()).toEqual(scene);
    expect(summarizeScene(scene).hash).toBe(DEFAULT_SCENE_HASH);
  });

  it("changes with the seed", () => {
    expect(summarizeScene(generateScene(1)).hash).not.toBe(DEFAULT_SCENE_HASH);
  });

  it("does not use Math.random", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random was called");
    });
    expect(() => generateScene(99)).not.toThrow();
    expect(random).not.toHaveBeenCalled();
  });

  it("has unique ids and images that each use one asset", () => {
    const ids = scene.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const assetIds = scene.elements.flatMap((e) =>
      e.kind === "image" ? [e.assetId] : [],
    );
    expect(new Set(assetIds).size).toBe(IMAGE_COUNT);
    for (const id of assetIds) expect(scene.assets.some((a) => a.id === id)).toBe(true);
  });

  it("has images of 2 to 12 megapixels, spread across the range", () => {
    const pixels = scene.assets.map((a) => a.width * a.height);
    for (const p of pixels) {
      expect(p).toBeGreaterThanOrEqual(MIN_IMAGE_PIXELS);
      expect(p).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    }
    expect(Math.min(...pixels)).toBeLessThan(2_100_000);
    expect(Math.max(...pixels)).toBeGreaterThan(11_900_000);
    const summary = summarizeScene(scene);
    // About 1,400 megapixels, 5.6 GB decoded as RGBA.
    expect(summary.imagePixels.total).toBeGreaterThan(1_390_000_000);
    expect(summary.imagePixels.total).toBeLessThan(1_410_000_000);
    expect(summary.decodedImageBytes).toBe(summary.imagePixels.total * 4);
  });

  it("keeps every element inside a cluster, and images at their asset's aspect ratio", () => {
    const assets = new Map(scene.assets.map((a) => [a.id, a]));
    for (const e of scene.elements) {
      const inside = scene.clusters.some(
        (c) =>
          e.x >= c.x &&
          e.y >= c.y &&
          e.x + e.width <= c.x + c.width &&
          e.y + e.height <= c.y + c.height,
      );
      expect(inside, e.id).toBe(true);
      expect(e.width).toBeGreaterThan(0);
      expect(e.height).toBeGreaterThan(0);
      if (e.kind === "image") {
        const asset = assets.get(e.assetId)!;
        expect(e.width / e.height).toBeCloseTo(asset.width / asset.height, 1);
      }
      if (e.kind === "text") expect(e.text.length).toBeGreaterThan(0);
    }
  });

  it("uses integer coordinates, so it is exact in every JavaScript engine", () => {
    for (const e of scene.elements) {
      for (const v of [e.x, e.y, e.width, e.height, e.rotation]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("has text outside ASCII and fine print that needs zooming in", () => {
    const texts = scene.elements.flatMap((e) => (e.kind === "text" ? [e] : []));
    expect(texts.some((t) => /[æøåéü]/.test(t.text))).toBe(true);
    expect(texts.some((t) => t.fontSize <= 8)).toBe(true);
    expect(texts.some((t) => t.fontSize >= 48)).toBe(true);
  });
});
