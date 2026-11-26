// SPDX-License-Identifier: GPL-3.0-or-later

// Decoded images at several resolutions (levels). Level k of an image is its natural
// size divided by 2^k; the coarsest level (the thumbnail) fits in 256 x 256 pixels.
// Thumbnails of every image are decoded at load and kept. Finer levels are decoded on
// demand, off the main thread (WebCodecs ImageDecoder at reduced size where the
// browser has it, else createImageBitmap with resize options), and evicted least-recently-used beyond a byte budget. While a level is missing,
// the nearest decoded level is drawn instead.

import type { ImageAsset, ImageSource } from "@galatsa/bench";

export const THUMBNAIL_SIZE = 256;

interface AssetEntry {
  readonly asset: ImageAsset;
  readonly thumbLevel: number;
  readonly levels: (ImageBitmap | undefined)[];
  readonly lastUsed: number[];
  readonly pending: Set<number>;
  readonly failed: Set<number>;
}

interface Want {
  readonly entry: AssetEntry;
  readonly level: number;
  frame: number;
  priority: number;
}

export interface ImageCacheStats {
  /** Bytes of decoded pixels held now (4 bytes per pixel), thumbnails included. */
  decodedBytes: number;
  peakDecodedBytes: number;
  thumbnailBytes: number;
  decodesStarted: number;
  decodesFinished: number;
  decodesFailed: number;
  evictions: number;
  /** Sum of the time from request to finished decode, for finished decodes. */
  decodeLatencyTotalMs: number;
  decodeLatencyMaxMs: number;
  /** Frames in which at least one drawn image was not at the wanted level. */
  framesWithFallback: number;
}

export interface ImageCacheOptions {
  /** Budget for decoded levels other than thumbnails, in bytes. */
  readonly budgetBytes: number;
  /** Decodes in flight at once. */
  readonly maxInFlight: number;
  readonly decoder: DecoderChoice;
  /** Called when a decode has finished (so a page that renders on demand can redraw). */
  readonly onDecoded?: () => void;
}

function levelSize(asset: ImageAsset, level: number): { width: number; height: number } {
  const f = 2 ** level;
  return {
    width: Math.max(1, Math.round(asset.width / f)),
    height: Math.max(1, Math.round(asset.height / f)),
  };
}

let resizeSupported: boolean | undefined;

export type DecoderChoice = "imagedecoder" | "createimagebitmap";

/** "imagedecoder" where WebCodecs ImageDecoder exists, else "createimagebitmap". */
export function defaultDecoder(): DecoderChoice {
  return typeof ImageDecoder === "function" ? "imagedecoder" : "createimagebitmap";
}

/**
 * WebCodecs ImageDecoder with desiredWidth/desiredHeight decodes a JPEG at reduced
 * size (Chromium 158 picks the nearest larger 1/2, 1/4 or 1/8 scale, Firefox 159 the
 * exact size), which is several times faster and needs no full-size buffer.
 * createImageBitmap with resize options decodes at full size and then scales.
 */
async function decodeWithImageDecoder(
  blob: Blob,
  width: number,
  height: number,
  full: boolean,
): Promise<ImageBitmap> {
  const decoder = new ImageDecoder({
    data: blob.stream(),
    type: blob.type,
    ...(full ? {} : { desiredWidth: width, desiredHeight: height }),
  });
  try {
    const { image } = await decoder.decode();
    try {
      if (image.displayWidth === width && image.displayHeight === height) {
        return await createImageBitmap(image);
      }
      return await createImageBitmap(image, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "medium",
      });
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

async function decode(
  blob: Blob,
  width: number,
  height: number,
  full: boolean,
  decoder: DecoderChoice,
): Promise<ImageBitmap> {
  if (decoder === "imagedecoder")
    return decodeWithImageDecoder(blob, width, height, full);
  if (full) return createImageBitmap(blob);
  if (resizeSupported !== false) {
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "medium",
      });
      resizeSupported = true;
      return bitmap;
    } catch (error) {
      if (resizeSupported === true) throw error;
      resizeSupported = false;
    }
  }
  // Fallback for browsers without resize options: full decode, then a downscale on
  // the main thread. Slow and memory hungry; only here so the prototype runs.
  const fullBitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("No 2D canvas context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(fullBitmap, 0, 0, width, height);
  fullBitmap.close();
  const small = await createImageBitmap(canvas);
  canvas.width = 0;
  return small;
}

export class ImageCache {
  private readonly source: ImageSource;
  private readonly entries = new Map<string, AssetEntry>();
  private readonly wants = new Map<string, Want>();
  private readonly options: ImageCacheOptions;
  private inFlight = 0;
  private frame = 0;
  private fallbackThisFrame = false;
  private disposed = false;
  private nonThumbBytes = 0;
  readonly stats: ImageCacheStats = {
    decodedBytes: 0,
    peakDecodedBytes: 0,
    thumbnailBytes: 0,
    decodesStarted: 0,
    decodesFinished: 0,
    decodesFailed: 0,
    evictions: 0,
    decodeLatencyTotalMs: 0,
    decodeLatencyMaxMs: 0,
    framesWithFallback: 0,
  };

  constructor(
    source: ImageSource,
    assets: readonly ImageAsset[],
    options: ImageCacheOptions,
  ) {
    this.source = source;
    this.options = options;
    for (const asset of assets) {
      const longest = Math.max(asset.width, asset.height);
      const thumbLevel = Math.max(0, Math.ceil(Math.log2(longest / THUMBNAIL_SIZE)));
      this.entries.set(asset.id, {
        asset,
        thumbLevel,
        levels: new Array<ImageBitmap | undefined>(thumbLevel + 1).fill(undefined),
        lastUsed: new Array<number>(thumbLevel + 1).fill(-1),
        pending: new Set(),
        failed: new Set(),
      });
    }
  }

  /** Decodes the thumbnail of every image. */
  async loadThumbnails(concurrency: number): Promise<void> {
    const queue = [...this.entries.values()];
    const worker = async () => {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
        await this.decodeLevel(entry, entry.thumbLevel, performance.now());
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /** Call at the start of each frame. */
  beginFrame(): void {
    this.frame++;
    this.fallbackThisFrame = false;
  }

  /** True while a wanted level for an image drawn in this frame is missing. */
  get incomplete(): boolean {
    return this.fallbackThisFrame;
  }

  /**
   * The best decoded bitmap for an image drawn `devicePixelWidth` device pixels wide,
   * and a request for the right level if it is missing. Null if nothing is decoded.
   */
  pick(assetId: string, devicePixelWidth: number): ImageBitmap | null {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return null;
    const ratio = entry.asset.width / Math.max(1, devicePixelWidth);
    const wanted = Math.max(0, Math.min(entry.thumbLevel, Math.floor(Math.log2(ratio))));
    const exact = entry.levels[wanted];
    if (exact !== undefined) {
      entry.lastUsed[wanted] = this.frame;
      return exact;
    }
    if (!entry.failed.has(wanted)) {
      this.fallbackThisFrame = true;
      this.want(entry, wanted, devicePixelWidth);
    }
    // Nearest decoded level, preferring the finer one at equal distance.
    for (let d = 1; d <= entry.thumbLevel; d++) {
      for (const level of [wanted - d, wanted + d]) {
        const bitmap = level >= 0 ? entry.levels[level] : undefined;
        if (bitmap !== undefined) {
          entry.lastUsed[level] = this.frame;
          return bitmap;
        }
      }
    }
    return null;
  }

  private want(entry: AssetEntry, level: number, priority: number): void {
    if (entry.pending.has(level)) return;
    const key = `${entry.asset.id}/${level}`;
    const existing = this.wants.get(key);
    if (existing !== undefined) {
      existing.frame = this.frame;
      existing.priority = priority;
    } else {
      this.wants.set(key, { entry, level, frame: this.frame, priority });
    }
  }

  /** Call at the end of each frame: starts decodes for the images wanted now. */
  endFrame(): void {
    if (this.fallbackThisFrame) this.stats.framesWithFallback++;
    for (const [key, want] of this.wants) {
      // Forget images that went out of view.
      if (want.frame < this.frame - 1) this.wants.delete(key);
    }
    while (this.inFlight < this.options.maxInFlight && this.wants.size > 0) {
      let best: [string, Want] | undefined;
      for (const item of this.wants) {
        const w = item[1];
        if (
          best === undefined ||
          w.frame > best[1].frame ||
          (w.frame === best[1].frame && w.priority > best[1].priority)
        ) {
          best = item;
        }
      }
      if (best === undefined) break;
      this.wants.delete(best[0]);
      void this.decodeLevel(best[1].entry, best[1].level, performance.now());
    }
  }

  private async decodeLevel(
    entry: AssetEntry,
    level: number,
    requested: number,
  ): Promise<void> {
    if (entry.levels[level] !== undefined || entry.pending.has(level)) return;
    entry.pending.add(level);
    this.inFlight++;
    this.stats.decodesStarted++;
    const { width, height } = levelSize(entry.asset, level);
    try {
      const bitmap = await decode(
        this.source.getBlob(entry.asset.id),
        width,
        height,
        level === 0,
        this.options.decoder,
      );
      if (this.disposed) {
        bitmap.close();
        return;
      }
      entry.levels[level] = bitmap;
      entry.lastUsed[level] = this.frame;
      const bytes = width * height * 4;
      this.stats.decodedBytes += bytes;
      if (level === entry.thumbLevel) this.stats.thumbnailBytes += bytes;
      else this.nonThumbBytes += bytes;
      this.stats.peakDecodedBytes = Math.max(
        this.stats.peakDecodedBytes,
        this.stats.decodedBytes,
      );
      this.stats.decodesFinished++;
      const latency = performance.now() - requested;
      this.stats.decodeLatencyTotalMs += latency;
      this.stats.decodeLatencyMaxMs = Math.max(this.stats.decodeLatencyMaxMs, latency);
      this.evict();
      this.options.onDecoded?.();
    } catch {
      entry.failed.add(level);
      this.stats.decodesFailed++;
    } finally {
      entry.pending.delete(level);
      this.inFlight--;
    }
  }

  /** Frees the least recently drawn levels (never thumbnails, never this frame's) until within budget. */
  private evict(): void {
    while (this.nonThumbBytes > this.options.budgetBytes) {
      let victim: { entry: AssetEntry; level: number; used: number } | undefined;
      for (const entry of this.entries.values()) {
        for (let level = 0; level < entry.thumbLevel; level++) {
          if (entry.levels[level] === undefined) continue;
          const used = entry.lastUsed[level]!;
          if (used >= this.frame) continue;
          if (victim === undefined || used < victim.used) victim = { entry, level, used };
        }
      }
      if (victim === undefined) return;
      const bitmap = victim.entry.levels[victim.level]!;
      const { width, height } = levelSize(victim.entry.asset, victim.level);
      bitmap.close();
      victim.entry.levels[victim.level] = undefined;
      this.nonThumbBytes -= width * height * 4;
      this.stats.decodedBytes -= width * height * 4;
      this.stats.evictions++;
    }
  }

  /** Decodes in flight or waiting. */
  get busy(): boolean {
    return this.inFlight > 0 || this.wants.size > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      for (const bitmap of entry.levels) bitmap?.close();
      entry.levels.fill(undefined);
    }
    this.entries.clear();
    this.wants.clear();
  }
}
