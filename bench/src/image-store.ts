// SPDX-License-Identifier: GPL-3.0-or-later

// Generates the scene's images in the browser and keeps them as encoded JPEG files
// (Blobs), like files a user has imported. Generating all 200 takes a while (each is
// drawn at full size and encoded), so it happens once, before any run, and is not
// timed. Browser only.

import type { ImageSource, ReducedImage } from "./engine.ts";
import { fillImagePixels } from "./images.ts";
import type { ImageAsset, Scene } from "./scene.ts";

export const IMAGE_TYPE = "image/jpeg";
export const IMAGE_QUALITY = 0.9;

/** The smallest reduced version has a long side of at least this many pixels. */
export const REDUCED_MIN_SIDE = 256;

/** Sizes of the reduced versions of an image: halves down to REDUCED_MIN_SIDE, largest first. */
export function reducedSizes(
  width: number,
  height: number,
): { width: number; height: number }[] {
  const out: { width: number; height: number }[] = [];
  for (let f = 2; Math.max(width, height) / f >= REDUCED_MIN_SIDE; f *= 2) {
    out.push({
      width: Math.max(1, Math.round(width / f)),
      height: Math.max(1, Math.round(height / f)),
    });
  }
  return out;
}

export interface ImageStore extends ImageSource {
  /** Total size of the encoded original files, in bytes. */
  readonly encodedBytes: number;
  /** Total size of the encoded reduced versions, in bytes. */
  readonly reducedBytes: number;
  /** Milliseconds it took to generate and encode all images. */
  readonly generationMs: number;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** An OffscreenCanvas where it has a 2D context, else a canvas element. */
function createCanvas(width: number, height: number): [AnyCanvas, AnyContext] {
  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(width, height);
    const context = offscreen.getContext("2d");
    if (context !== null) return [offscreen, context];
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("No 2D canvas context");
  return [canvas, context];
}

function encode(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: IMAGE_TYPE, quality: IMAGE_QUALITY });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image encoding failed"))),
      IMAGE_TYPE,
      IMAGE_QUALITY,
    );
  });
}

/** Generates one image as an encoded file. */
export async function generateImage(asset: ImageAsset): Promise<Blob> {
  return (await generateImageWithReduced(asset, false)).blob;
}

/**
 * Generates one image as an encoded file and, if asked, its reduced versions
 * (smallest first), each scaled down from the next larger one.
 */
export async function generateImageWithReduced(
  asset: ImageAsset,
  withReduced = true,
): Promise<{ blob: Blob; reduced: ReducedImage[] }> {
  const [canvas, context] = createCanvas(asset.width, asset.height);
  const image = context.createImageData(asset.width, asset.height);
  fillImagePixels(asset, image.data);
  context.putImageData(image, 0, 0);
  const reduced: ReducedImage[] = [];
  if (withReduced) {
    let previous: AnyCanvas = canvas;
    for (const size of reducedSizes(asset.width, asset.height)) {
      const [small, smallContext] = createCanvas(size.width, size.height);
      smallContext.imageSmoothingEnabled = true;
      smallContext.imageSmoothingQuality = "high";
      smallContext.drawImage(previous, 0, 0, size.width, size.height);
      const blob = await encode(small);
      checkType(blob);
      reduced.unshift({ width: size.width, height: size.height, blob });
      if (previous !== canvas) {
        previous.width = 0;
        previous.height = 0;
      }
      previous = small;
    }
    if (previous !== canvas) {
      previous.width = 0;
      previous.height = 0;
    }
  }
  const blob = await encode(canvas);
  checkType(blob);
  // Release the canvas memory right away instead of waiting for garbage collection.
  canvas.width = 0;
  canvas.height = 0;
  return { blob, reduced };
}

function checkType(blob: Blob): void {
  // Browsers that cannot encode the requested type silently return PNG instead,
  // which would change the scene's files. Refuse rather than measure something else.
  if (blob.type !== IMAGE_TYPE) {
    throw new Error(
      `This browser encoded ${blob.type || "an unknown type"} instead of ${IMAGE_TYPE}`,
    );
  }
}

/**
 * Generates every image of the scene. `onProgress` is called after each image with
 * the number done so far.
 */
export async function prepareImages(
  scene: Scene,
  onProgress?: (done: number, total: number) => void,
  options: { readonly reduced?: boolean } = {},
): Promise<ImageStore> {
  const start = performance.now();
  const blobs = new Map<string, Blob>();
  const reducedVersions = new Map<string, readonly ReducedImage[]>();
  let encodedBytes = 0;
  let reducedBytes = 0;
  for (const asset of scene.assets) {
    const { blob, reduced } = await generateImageWithReduced(
      asset,
      options.reduced ?? true,
    );
    blobs.set(asset.id, blob);
    reducedVersions.set(asset.id, reduced);
    encodedBytes += blob.size;
    for (const r of reduced) reducedBytes += r.blob.size;
    onProgress?.(blobs.size, scene.assets.length);
  }
  const generationMs = performance.now() - start;
  return {
    encodedBytes,
    reducedBytes,
    generationMs,
    getReduced(assetId: string): readonly ReducedImage[] {
      return reducedVersions.get(assetId) ?? [];
    },
    getBlob(assetId: string): Blob {
      const blob = blobs.get(assetId);
      if (blob === undefined) throw new Error(`Unknown image asset ${assetId}`);
      return blob;
    },
  };
}
