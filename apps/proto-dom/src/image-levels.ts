// SPDX-License-Identifier: GPL-3.0-or-later

// Image level of detail for the DOM prototype. The scene's images are 2 to 12
// megapixels each (1,400 MP in all), so they are never shown at full size unless
// the camera is close. Each image has levels k = 0, 1, 2, ...: level k is the image
// scaled to 1 / 2^k of its width. The engine asks for the level that gives at least
// one image pixel per device pixel; this module decodes it in the background with
// createImageBitmap's resize options, re-encodes it as a small JPEG and hands out an
// object URL that an <img> element can show.
//
// Why <img> with an object URL rather than a <canvas> per image: an <img> is painted
// into its parent's layer, while a canvas may get its own compositor layer (in
// Chromium, an accelerated canvas does), and many layers on top of each other turn
// into many more layers for everything that overlaps them. The price is one extra
// small encode and decode per level.

import type { ImageAsset, ImageSource } from "@galatsa/bench";

/** Smallest level width worth making, in pixels. */
const MIN_LEVEL_WIDTH = 16;
/** Decodes running at the same time. */
const CONCURRENCY = 3;
/** Cached levels may hold up to this many pixels (encoded, but decoded when shown). */
const CACHE_PIXEL_BUDGET = 120_000_000;

export interface Level {
  readonly k: number;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly bytes: number;
  lastUsed: number;
}

interface Request {
  readonly asset: ImageAsset;
  k: number;
  priority: number;
}

export function levelSize(asset: ImageAsset, k: number): [number, number] {
  const width = Math.max(1, Math.ceil(asset.width / 2 ** k));
  const height = Math.max(1, Math.ceil(asset.height / 2 ** k));
  return [width, height];
}

/** The coarsest level that still has at least `devicePixels` pixels across. */
export function wantedLevel(asset: ImageAsset, devicePixels: number): number {
  let k = 0;
  while (
    asset.width / 2 ** (k + 1) >= Math.max(devicePixels, MIN_LEVEL_WIDTH) &&
    k < 12
  ) {
    k++;
  }
  return k;
}

export class ImageLevels {
  private readonly levels = new Map<string, Map<number, Level>>();
  private readonly queue = new Map<string, Request>();
  private readonly inFlight = new Set<string>();
  private cachedPixels = 0;
  private disposed = false;
  private clock = 0;
  /** Called when a level becomes available, so the engine can swap it in. */
  onLevel: (assetId: string) => void = () => {};
  /** Statistics, for the report. */
  readonly stats = { decodes: 0, decodeMs: 0, evictions: 0, encodedBytes: 0 };

  private readonly source: ImageSource;

  constructor(source: ImageSource) {
    this.source = source;
  }

  /** Advance the clock used for least-recently-used eviction (once per frame). */
  tick(): void {
    this.clock++;
  }

  /**
   * The best level available for showing at level `k` or finer: the coarsest
   * cached level at most k, else the finest cached level coarser than k.
   */
  best(assetId: string, k: number): Level | undefined {
    const cached = this.levels.get(assetId);
    if (cached === undefined) return undefined;
    let finer: Level | undefined;
    let coarser: Level | undefined;
    for (const level of cached.values()) {
      if (level.k <= k) {
        if (finer === undefined || level.k > finer.k) finer = level;
      } else if (coarser === undefined || level.k < coarser.k) {
        coarser = level;
      }
    }
    const chosen = finer ?? coarser;
    if (chosen !== undefined) chosen.lastUsed = this.clock;
    return chosen;
  }

  has(assetId: string, k: number): boolean {
    return this.levels.get(assetId)?.has(k) ?? false;
  }

  /**
   * Ask for level k of an asset. A newer request for the same asset replaces an
   * older one that has not started. Lower priority numbers go first.
   */
  request(asset: ImageAsset, k: number, priority: number): void {
    if (this.has(asset.id, k)) return;
    const queued = this.queue.get(asset.id);
    if (queued !== undefined) {
      queued.k = k;
      queued.priority = priority;
    } else {
      this.queue.set(asset.id, { asset, k, priority });
    }
    this.pump();
  }

  /** Forget queued requests for assets not in `keep`. */
  prune(keep: ReadonlySet<string>): void {
    for (const id of this.queue.keys()) if (!keep.has(id)) this.queue.delete(id);
  }

  /** Resolves when nothing is queued or decoding. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed || (this.queue.size === 0 && this.inFlight.size === 0))
          resolve();
        else setTimeout(check, 20);
      };
      check();
    });
  }

  get pending(): number {
    return this.queue.size + this.inFlight.size;
  }

  get pixels(): number {
    return this.cachedPixels;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.clear();
    for (const cached of this.levels.values())
      for (const level of cached.values()) URL.revokeObjectURL(level.url);
    this.levels.clear();
    this.cachedPixels = 0;
  }

  private pump(): void {
    while (this.inFlight.size < CONCURRENCY && this.queue.size > 0) {
      let next: Request | undefined;
      for (const r of this.queue.values()) {
        if (this.inFlight.has(r.asset.id)) continue;
        if (next === undefined || r.priority < next.priority) next = r;
      }
      if (next === undefined) return;
      this.queue.delete(next.asset.id);
      this.inFlight.add(next.asset.id);
      const { asset, k } = next;
      this.decode(asset, k)
        .catch((error: unknown) => {
          console.error(`proto-dom: decoding ${asset.id} level ${k} failed`, error);
        })
        .finally(() => {
          this.inFlight.delete(asset.id);
          if (!this.disposed) this.pump();
        });
    }
  }

  private async decode(asset: ImageAsset, k: number): Promise<void> {
    const start = performance.now();
    const [width, height] = levelSize(asset, k);
    const blob = this.source.getBlob(asset.id);
    let url: string;
    let bytes: number;
    if (k === 0) {
      // Full size: show the original file.
      url = URL.createObjectURL(blob);
      bytes = blob.size;
    } else {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "medium",
      });
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("No 2D context");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const small = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      url = URL.createObjectURL(small);
      bytes = small.size;
    }
    if (this.disposed) {
      URL.revokeObjectURL(url);
      return;
    }
    let cached = this.levels.get(asset.id);
    if (cached === undefined) {
      cached = new Map();
      this.levels.set(asset.id, cached);
    }
    cached.set(k, { k, width, height, url, bytes, lastUsed: this.clock });
    this.cachedPixels += width * height;
    this.stats.decodes++;
    this.stats.decodeMs += performance.now() - start;
    this.stats.encodedBytes += bytes;
    this.evict(asset.id, k);
    this.onLevel(asset.id);
  }

  /** Drop least recently used levels over budget, but never the newest one. */
  private evict(keepAsset: string, keepK: number): void {
    if (this.cachedPixels <= CACHE_PIXEL_BUDGET) return;
    const all: { assetId: string; level: Level }[] = [];
    for (const [assetId, cached] of this.levels)
      for (const level of cached.values()) all.push({ assetId, level });
    // Oldest first; among equally old, the largest first. Keep the smallest level
    // of every asset, so something can always be shown.
    all.sort(
      (a, b) =>
        a.level.lastUsed - b.level.lastUsed ||
        b.level.width * b.level.height - a.level.width * a.level.height,
    );
    for (const { assetId, level } of all) {
      if (this.cachedPixels <= CACHE_PIXEL_BUDGET) break;
      if (assetId === keepAsset && level.k === keepK) continue;
      if (level.lastUsed >= this.clock - 1) continue; // shown in the last frame
      const cached = this.levels.get(assetId);
      if (cached === undefined || cached.size <= 1) continue;
      const coarsest = Math.max(...cached.keys());
      if (level.k === coarsest) continue;
      cached.delete(level.k);
      URL.revokeObjectURL(level.url);
      this.cachedPixels -= level.width * level.height;
      this.stats.evictions++;
    }
  }
}
