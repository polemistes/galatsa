// SPDX-License-Identifier: GPL-3.0-or-later

// Image level of detail: each image is decoded at reduced sizes, never kept at full
// size unless it is that large on screen. Level k has its longest side at
// BASE_LONG_SIDE * 2^k pixels, capped at the natural size (the last level). Level 0
// of every image is decoded during load and kept; higher levels are decoded on
// demand, a few at a time, and evicted least recently used beyond a byte budget.
//
// Decoding uses createImageBitmap with resize options, which in Chromium and Firefox
// decodes off the main thread. A browser that ignores the resize options gets the
// bitmap downscaled through a canvas afterwards.

import type { ImageAsset, ImageSource } from "@galatsa/bench";

export const BASE_LONG_SIDE = 128;
/** Decoded bytes kept for levels above 0 before the least recently used are closed. */
export const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const MAX_CONCURRENT_DECODES = 3;
/** A queued request not repeated within this many frames is dropped. */
const STALE_FRAMES = 30;

interface Level {
  readonly width: number;
  readonly height: number;
  bitmap: ImageBitmap | undefined;
  /** Frame in which the level was last drawn or requested. */
  lastUsed: number;
  state: "none" | "queued" | "decoding" | "ready";
}

interface Entry {
  readonly asset: ImageAsset;
  readonly levels: Level[];
}

export interface ImageLodStats {
  readonly decodedBytes: number;
  readonly decodes: number;
  readonly decodeMs: number;
  readonly evictions: number;
  readonly fallbackResizes: number;
  readonly levelsReady: number;
}

function levelSizes(asset: ImageAsset): { width: number; height: number }[] {
  const long = Math.max(asset.width, asset.height);
  const sizes: { width: number; height: number }[] = [];
  for (let side = BASE_LONG_SIDE; side < long; side *= 2) {
    const scale = side / long;
    sizes.push({
      width: Math.max(1, Math.round(asset.width * scale)),
      height: Math.max(1, Math.round(asset.height * scale)),
    });
  }
  sizes.push({ width: asset.width, height: asset.height });
  return sizes;
}

export class ImageLod {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: { entry: Entry; level: number }[] = [];
  private active = 0;
  private frame = 0;
  private disposed = false;
  private decodedBytes = 0;
  private decodes = 0;
  private decodeMs = 0;
  private evictions = 0;
  private fallbackResizes = 0;

  private readonly source: ImageSource;
  private readonly onReady: () => void;
  private readonly budgetBytes: number;

  /** `onReady` is called when a new level is ready, so the caller can redraw. */
  constructor(
    source: ImageSource,
    assets: readonly ImageAsset[],
    onReady: () => void,
    budgetBytes: number = DEFAULT_BUDGET_BYTES,
  ) {
    this.source = source;
    this.onReady = onReady;
    this.budgetBytes = budgetBytes;
    for (const asset of assets) {
      const levels = levelSizes(asset).map((size): Level => ({
        ...size,
        bitmap: undefined,
        lastUsed: -1,
        state: "none",
      }));
      this.entries.set(asset.id, { asset, levels });
    }
  }

  /** Decodes level 0 of every image. */
  async loadBase(concurrency = 6): Promise<void> {
    const entries = [...this.entries.values()];
    let next = 0;
    const worker = async () => {
      while (next < entries.length && !this.disposed) {
        const entry = entries[next++]!;
        const level = entry.levels[0]!;
        level.state = "decoding";
        await this.decode(entry, 0);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /** Marks the start of a frame (for least-recently-used bookkeeping). */
  beginFrame(): void {
    this.frame++;
  }

  /**
   * The best bitmap available now for an image drawn `longSidePx` device pixels long
   * on screen. Asks for the right level if it is missing.
   */
  bitmapFor(assetId: string, longSidePx: number): ImageBitmap | undefined {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return undefined;
    const levels = entry.levels;
    let wanted = levels.length - 1;
    for (let k = 0; k < levels.length; k++) {
      const l = levels[k]!;
      if (Math.max(l.width, l.height) >= longSidePx) {
        wanted = k;
        break;
      }
    }
    const level = levels[wanted]!;
    level.lastUsed = this.frame;
    if (level.state === "ready") return level.bitmap;
    if (level.state === "none") {
      level.state = "queued";
      this.queue.push({ entry, level: wanted });
      this.pump();
    }
    // Until it arrives: the nearest level above, else the nearest below.
    for (let k = wanted + 1; k < levels.length; k++) {
      const l = levels[k]!;
      if (l.state === "ready") {
        l.lastUsed = this.frame;
        return l.bitmap;
      }
    }
    for (let k = wanted - 1; k >= 0; k--) {
      const l = levels[k]!;
      if (l.state === "ready") {
        l.lastUsed = this.frame;
        return l.bitmap;
      }
    }
    return undefined;
  }

  /** True when no decode is queued or running. */
  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  stats(): ImageLodStats {
    let levelsReady = 0;
    for (const entry of this.entries.values())
      for (const l of entry.levels) if (l.state === "ready") levelsReady++;
    return {
      decodedBytes: this.decodedBytes,
      decodes: this.decodes,
      decodeMs: Math.round(this.decodeMs),
      evictions: this.evictions,
      fallbackResizes: this.fallbackResizes,
      levelsReady,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const entry of this.entries.values()) {
      for (const l of entry.levels) {
        l.bitmap?.close();
        l.bitmap = undefined;
        l.state = "none";
      }
    }
    this.decodedBytes = 0;
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_DECODES && this.queue.length > 0) {
      // Drop requests nobody repeated lately, then take the most recently requested.
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const q = this.queue[i]!;
        const l = q.entry.levels[q.level]!;
        if (this.frame - l.lastUsed > STALE_FRAMES) {
          l.state = "none";
          this.queue.splice(i, 1);
        }
      }
      let best = -1;
      let bestUsed = -Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i]!;
        const used = q.entry.levels[q.level]!.lastUsed;
        if (used >= bestUsed) {
          best = i;
          bestUsed = used;
        }
      }
      if (best < 0) return;
      const [q] = this.queue.splice(best, 1);
      const { entry, level } = q!;
      entry.levels[level]!.state = "decoding";
      this.active++;
      void this.decode(entry, level).finally(() => {
        this.active--;
        if (!this.disposed) {
          this.pump();
          this.onReady();
        }
      });
    }
  }

  private async decode(entry: Entry, index: number): Promise<void> {
    const level = entry.levels[index]!;
    const natural = index === entry.levels.length - 1;
    const start = performance.now();
    try {
      const blob = this.source.getBlob(entry.asset.id);
      let bitmap = natural
        ? await createImageBitmap(blob)
        : await createImageBitmap(blob, {
            resizeWidth: level.width,
            resizeHeight: level.height,
            resizeQuality: "medium",
          });
      if (bitmap.width !== level.width || bitmap.height !== level.height) {
        bitmap = await this.resize(bitmap, level.width, level.height);
      }
      this.decodeMs += performance.now() - start;
      this.decodes++;
      if (this.disposed) {
        bitmap.close();
        return;
      }
      level.bitmap = bitmap;
      level.state = "ready";
      this.decodedBytes += level.width * level.height * 4;
      this.evict();
    } catch (error) {
      level.state = "none";
      console.warn(`Decoding ${entry.asset.id} level ${index} failed`, error);
    }
  }

  private async resize(bitmap: ImageBitmap, width: number, height: number) {
    this.fallbackResizes++;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) return bitmap;
    context.imageSmoothingQuality = "medium";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return createImageBitmap(canvas);
  }

  /** Closes least recently used levels above 0 until the budget holds. */
  private evict(): void {
    const base = [...this.entries.values()].reduce((sum, e) => {
      const l = e.levels[0]!;
      return sum + (l.state === "ready" ? l.width * l.height * 4 : 0);
    }, 0);
    if (this.decodedBytes - base <= this.budgetBytes) return;
    const candidates: Level[] = [];
    for (const entry of this.entries.values()) {
      for (let k = 1; k < entry.levels.length; k++) {
        const l = entry.levels[k]!;
        if (l.state === "ready" && l.lastUsed < this.frame) candidates.push(l);
      }
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const l of candidates) {
      if (this.decodedBytes - base <= this.budgetBytes) break;
      l.bitmap?.close();
      l.bitmap = undefined;
      l.state = "none";
      this.decodedBytes -= l.width * l.height * 4;
      this.evictions++;
    }
  }
}
