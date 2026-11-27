// SPDX-License-Identifier: GPL-3.0-or-later

// Image versions: which version is picked for a size on screen, that originals
// are not decoded when opening, the stand-in while a version loads, and the
// byte budget.

import { describe, expect, it } from "vitest";
import {
  ImageCache,
  pickVersion,
  versionsOf,
  type Decoded,
  type ImageSource,
} from "./images.ts";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, IMAGE, RecordingContext, record, testHost } from "./test-support.ts";

const LEVELS = [
  { width: 256, height: 192 },
  { width: 512, height: 384 },
  { width: 1024, height: 768 },
  { width: 4000, height: 3000 },
];

/** A source with one image and a decoder that records what it decodes. */
function fake() {
  const decoded: Array<{ level: number; width: number; height: number }> = [];
  const source: ImageSource = {
    levels: (asset) => (asset === "sha256-a" ? LEVELS : undefined),
    blob: (asset, level) => new Blob([`${asset}:${level}`]),
  };
  const decode = async (blob: Blob, width: number, height: number): Promise<Decoded> => {
    const level = Number((await blob.text()).split(":")[1]);
    decoded.push({ level, width, height });
    return { image: {} as CanvasImageSource, width, height, close: () => {} };
  };
  return { source, decode, decoded };
}

describe("versions", () => {
  it("picks the smallest version at least as wide as the image on screen", () => {
    const versions = versionsOf(LEVELS, false);
    expect(pickVersion(versions, 100)).toBe(0);
    expect(pickVersion(versions, 256)).toBe(0);
    expect(pickVersion(versions, 257)).toBe(1);
    expect(pickVersion(versions, 1000)).toBe(2);
    expect(pickVersion(versions, 1025)).toBe(3);
    expect(pickVersion(versions, 99999)).toBe(3);
  });

  it("offers reduced decodes of the original where the decoder can do them", () => {
    const versions = versionsOf(LEVELS, true);
    expect(versions.map((v) => [v.level, v.width])).toEqual([
      [0, 256],
      [1, 512],
      [2, 1024],
      [3, 2000],
      [3, 4000],
    ]);
    // 1,500 pixels on screen: the original decoded at half size, not in full.
    expect(versions[pickVersion(versions, 1500)]).toEqual({
      level: 3,
      width: 2000,
      height: 1500,
    });
  });
});

describe("ImageCache", () => {
  it("decodes only the smallest version when preloading", async () => {
    const { source, decode, decoded } = fake();
    const cache = new ImageCache(source, { decode });
    await cache.preload(["sha256-a", "sha256-missing"]);
    expect(decoded).toEqual([{ level: 0, width: 256, height: 192 }]);
    expect(cache.stats.originalDecodes).toBe(0);
  });

  it("says loading, then draws a stand-in version until the right one arrives", async () => {
    const { source, decode, decoded } = fake();
    let changes = 0;
    const cache = new ImageCache(source, { decode, onChange: () => changes++ });
    cache.beginFrame();
    expect(cache.pick("sha256-a", 600).state).toBe("loading");
    expect(cache.pick("sha256-b", 600).state).toBe("missing");
    cache.endFrame();
    await cache.settle();
    expect(decoded).toEqual([{ level: 2, width: 1024, height: 768 }]);
    expect(changes).toBe(1);
    cache.beginFrame();
    const exact = cache.pick("sha256-a", 600);
    expect(exact).toMatchObject({ state: "drawn", exact: true });
    // Smaller on screen: the larger decoded version stands in while 256 loads.
    const smaller = cache.pick("sha256-a", 200);
    expect(smaller).toMatchObject({ state: "drawn", exact: false });
    expect(smaller.state === "drawn" && smaller.decoded.width).toBe(1024);
    cache.endFrame();
    await cache.settle();
    expect(decoded.at(-1)).toEqual({ level: 0, width: 256, height: 192 });
  });

  it("closes the least recently drawn versions beyond the budget, never the smallest", async () => {
    const { source, decode } = fake();
    const closed: number[] = [];
    const tracked = async (blob: Blob, w: number, h: number): Promise<Decoded> => {
      const d = await decode(blob, w, h);
      return { ...d, close: () => closed.push(w) };
    };
    // Room for the 1024 version (3 MB) but not for it and the 4000 one.
    const cache = new ImageCache(source, { decode: tracked, budgetBytes: 4 * 2 ** 20 });
    for (const pixels of [100, 1000, 4000]) {
      cache.beginFrame();
      cache.pick("sha256-a", pixels);
      cache.endFrame();
      await cache.settle();
      cache.beginFrame();
      cache.pick("sha256-a", pixels);
      cache.endFrame();
    }
    expect(closed).toEqual([1024]);
    expect(cache.stats.evictions).toBe(1);
  });
});

describe("drawing images", () => {
  it("asks for the version that matches the size in device pixels", async () => {
    const { source, decode, decoded } = fake();
    const { host } = testHost();
    let invalidated = 0;
    const renderer = new CanvasRenderer({
      host,
      images: source,
      imageOptions: { decode },
      onInvalidate: () => invalidated++,
    });
    const ctx = new RecordingContext();
    renderer.attach(ctx, { width: 800, height: 600, devicePixelRatio: 2 });
    renderer.setScene(
      sceneFromSnapshot({
        elements: record([
          ["i", box(IMAGE, 0, 0, 400, 300, { data: { asset: "sha256-a" } })],
        ]),
      }),
    );
    // 400 units at zoom 1 and ratio 2: 800 device pixels, so the 1024 version.
    renderer.setCamera({ space: null, cx: 200, cy: 150, zoom: 1 });
    renderer.render();
    expect(ctx.named("drawImage")).toHaveLength(0);
    expect(renderer.stats.imagesIncomplete).toBe(true);
    await renderer.images!.settle();
    expect(decoded).toEqual([{ level: 2, width: 1024, height: 768 }]);
    expect(invalidated).toBe(1);
    ctx.calls = [];
    renderer.render();
    const [call] = ctx.named("drawImage");
    // The whole decoded image into the whole box (local units, matrix scales).
    expect(call?.args.slice(1)).toEqual([0, 0, 1024, 768, 0, 0, 400, 300]);
    expect(renderer.stats.imagesIncomplete).toBe(false);
  });

  it("draws only the visible part of an image at deep zoom", async () => {
    const { source, decode } = fake();
    const { host } = testHost();
    const renderer = new CanvasRenderer({
      host,
      images: source,
      imageOptions: { decode },
    });
    const ctx = new RecordingContext();
    renderer.attach(ctx, { width: 100, height: 100, devicePixelRatio: 1 });
    renderer.setScene(
      sceneFromSnapshot({
        elements: record([
          ["i", box(IMAGE, 0, 0, 400, 300, { data: { asset: "sha256-a" } })],
        ]),
      }),
    );
    renderer.setCamera({ space: null, cx: 200, cy: 150, zoom: 1000 });
    renderer.render();
    await renderer.images!.settle();
    ctx.calls = [];
    renderer.render();
    const [call] = ctx.named("drawImage");
    const [sx, sy, sw, sh, , , dw, dh] = call!.args.slice(1) as number[];
    // About 0.1 x 0.1 units around the centre, from the original.
    expect(dw!).toBeLessThan(0.11);
    expect(dh!).toBeLessThan(0.11);
    expect(sx!).toBeGreaterThan(1999);
    expect(sy!).toBeGreaterThan(1499);
    expect(sw!).toBeLessThan(1.2);
    expect(sh!).toBeLessThan(1.2);
    const transforms = ctx.named("setTransform").map((c) => c.args as number[]);
    for (const t of transforms) {
      expect(Math.abs(t[4]!)).toBeLessThan(200);
      expect(Math.abs(t[5]!)).toBeLessThan(200);
    }
  });
});
