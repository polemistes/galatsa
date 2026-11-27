// SPDX-License-Identifier: GPL-3.0-or-later

// Images that are missing at first, decodes that fail, forget() while a decode
// runs, the worker decoder's way out when its worker does not work, and the
// version for an image squeezed out of its proportions.

import { describe, expect, it, vi } from "vitest";
import {
  ImageCache,
  RETRY_FIRST_MS,
  workerDecoder,
  type Decoded,
  type DecodeFn,
  type WorkerLike,
} from "./images.ts";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, IMAGE, RecordingContext, record, testHost } from "./test-support.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

function decoded(width: number, height: number, onClose = () => {}): Decoded {
  return { image: {} as CanvasImageSource, width, height, close: onClose };
}

/** A decoder whose decodes finish when the test says so. */
function deferredDecoder() {
  const pending: Array<{ resolve: () => void; reject: () => void }> = [];
  let closed = 0;
  const decode: DecodeFn = (_b, w, h) =>
    new Promise<Decoded>((resolve, reject) => {
      pending.push({
        resolve: () => resolve(decoded(w, h, () => closed++)),
        reject: () => reject(new Error("broken file")),
      });
    });
  return { decode, pending, closed: () => closed };
}

const TWO_LEVELS = [
  { width: 100, height: 100 },
  { width: 1000, height: 1000 },
];

describe("images that are not there yet", () => {
  it("asks the source again after a growing wait, and at once after forget()", () => {
    let now = 0;
    let have = false;
    let asked = 0;
    const cache = new ImageCache(
      {
        levels: () => {
          asked++;
          return have ? TWO_LEVELS : undefined;
        },
        blob: () => new Blob([]),
      },
      { decode: () => new Promise<Decoded>(() => {}), now: () => now },
    );
    const pick = () => {
      cache.beginFrame();
      const state = cache.pick("a", 100).state;
      cache.endFrame();
      return state;
    };
    expect(pick()).toBe("missing");
    expect(pick()).toBe("missing");
    expect(asked).toBe(1);
    now = RETRY_FIRST_MS;
    expect(pick()).toBe("missing");
    expect(asked).toBe(2);
    // The wait doubled.
    now = RETRY_FIRST_MS * 2;
    pick();
    expect(asked).toBe(2);
    // The bytes arrive; the host says so.
    have = true;
    cache.forget("a");
    expect(pick()).toBe("loading");
  });

  it("decodes an image after imagesChanged() and redraws", async () => {
    let have = false;
    const { host } = testHost();
    let invalidated = 0;
    const renderer = new CanvasRenderer({
      host,
      images: { levels: () => (have ? TWO_LEVELS : undefined), blob: () => new Blob([]) },
      imageOptions: { decode: (_b, w, h) => Promise.resolve(decoded(w, h)) },
      onInvalidate: () => invalidated++,
    });
    const ctx = new RecordingContext();
    renderer.attach(ctx, { width: 100, height: 100, devicePixelRatio: 1 });
    renderer.setScene(
      sceneFromSnapshot({
        elements: record([
          ["i", box(IMAGE, 0, 0, 100, 100, { data: { asset: "sha256-a" } })],
        ]),
      }),
    );
    renderer.setCamera({ space: null, cx: 50, cy: 50, zoom: 1 });
    renderer.render();
    have = true;
    renderer.imagesChanged(["sha256-a"]);
    expect(invalidated).toBe(1);
    renderer.render();
    await renderer.images!.settle();
    ctx.calls = [];
    renderer.render();
    expect(ctx.named("drawImage")).toHaveLength(1);
  });

  it("tries a failed decode again after a wait", async () => {
    let now = 0;
    const d = deferredDecoder();
    const cache = new ImageCache(
      { levels: () => TWO_LEVELS, blob: () => new Blob([]) },
      { decode: d.decode, now: () => now },
    );
    const frame = () => {
      cache.beginFrame();
      const p = cache.pick("a", 1000);
      cache.endFrame();
      return p;
    };
    frame();
    await flush();
    d.pending[0]!.reject();
    await flush();
    expect(cache.stats.failures).toBe(1);
    frame();
    expect(d.pending).toHaveLength(1);
    now = RETRY_FIRST_MS;
    frame();
    await flush();
    expect(d.pending).toHaveLength(2);
    d.pending[1]!.resolve();
    await flush();
    expect(frame()).toMatchObject({ state: "drawn", exact: true });
  });
});

describe("forget() while a decode runs", () => {
  it("closes what the decode returns and does not count it", async () => {
    const d = deferredDecoder();
    const cache = new ImageCache(
      { levels: () => TWO_LEVELS, blob: () => new Blob([]) },
      { decode: d.decode },
    );
    cache.beginFrame();
    cache.pick("a", 1000);
    cache.endFrame();
    await flush();
    expect(d.pending).toHaveLength(1);
    cache.forget("a");
    d.pending[0]!.resolve();
    await flush();
    expect({ decodedBytes: cache.stats.decodedBytes, closed: d.closed() }).toEqual({
      decodedBytes: 0,
      closed: 1,
    });
    expect(cache.busy).toBe(false);
  });
});

describe("the worker decoder", () => {
  /** A worker stand-in that never answers, or fails on demand. */
  function fakeWorker() {
    const w: WorkerLike & { posted: number } = {
      onmessage: null,
      onerror: null,
      posted: 0,
      postMessage() {
        w.posted++;
      },
      terminate() {},
    };
    return w;
  }
  const blob = new Blob([]);

  it("sends decodes to the fallback when the worker cannot be made", async () => {
    const fallback = vi.fn((_b: Blob, w: number, h: number) =>
      Promise.resolve(decoded(w, h)),
    );
    const dec = workerDecoder({
      create: () => {
        throw new Error("blocked by the content security policy");
      },
      fallback,
    });
    await expect(dec.decode(blob, 10, 20)).resolves.toMatchObject({
      width: 10,
      height: 20,
    });
    expect(dec.broken).toBe(true);
    await dec.decode(blob, 1, 1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("sends waiting decodes to the fallback when the worker reports an error", async () => {
    const worker = fakeWorker();
    const fallback = vi.fn((_b: Blob, w: number, h: number) =>
      Promise.resolve(decoded(w, h)),
    );
    const dec = workerDecoder({ create: () => worker, fallback });
    const a = dec.decode(blob, 1, 1);
    const b = dec.decode(blob, 2, 2);
    expect(worker.posted).toBe(2);
    worker.onerror!(new Event("error"));
    await expect(a).resolves.toMatchObject({ width: 1 });
    await expect(b).resolves.toMatchObject({ width: 2 });
    expect(dec.broken).toBe(true);
  });

  it("gives up on a worker that never answers", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      const fallback = vi.fn((_b: Blob, w: number, h: number) =>
        Promise.resolve(decoded(w, h)),
      );
      const dec = workerDecoder({ create: () => worker, fallback, startTimeoutMs: 100 });
      const a = dec.decode(blob, 3, 3);
      await vi.advanceTimersByTimeAsync(150);
      await expect(a).resolves.toMatchObject({ width: 3 });
      expect(dec.broken).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the worker's answers while it works", async () => {
    const worker = fakeWorker();
    const fallback = vi.fn();
    const dec = workerDecoder({ create: () => worker, fallback });
    const a = dec.decode(blob, 5, 5);
    const bitmap = { width: 5, height: 5, close: () => {} } as unknown as ImageBitmap;
    worker.onmessage!(new MessageEvent("message", { data: { id: 0, bitmap } }));
    await expect(a).resolves.toMatchObject({ width: 5, height: 5 });
    expect(fallback).not.toHaveBeenCalled();
    dec.dispose();
  });
});

describe("the version for a squeezed image", () => {
  it("is chosen by the larger of the two scales", async () => {
    const asked: number[] = [];
    const { host } = testHost();
    const levels = [
      { width: 100, height: 100 },
      { width: 200, height: 200 },
      { width: 400, height: 400 },
      { width: 800, height: 800 },
    ];
    const renderer = new CanvasRenderer({
      host,
      images: { levels: () => levels, blob: () => new Blob([]) },
      imageOptions: {
        decode: (_b, w, h) => {
          asked.push(w);
          return Promise.resolve(decoded(w, h));
        },
      },
    });
    renderer.attach(new RecordingContext(), {
      width: 800,
      height: 800,
      devicePixelRatio: 1,
    });
    // 100 wide but 700 tall: the image needs 700 pixels of height.
    renderer.setScene(
      sceneFromSnapshot({
        elements: record([
          ["i", box(IMAGE, 0, 0, 100, 700, { data: { asset: "sha256-a" } })],
        ]),
      }),
    );
    renderer.setCamera({ space: null, cx: 50, cy: 350, zoom: 1 });
    renderer.render();
    await renderer.images!.settle();
    expect(asked).toEqual([800]);
  });
});
