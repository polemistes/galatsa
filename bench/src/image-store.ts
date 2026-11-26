// SPDX-License-Identifier: GPL-3.0-or-later

// Generates the scene's images in the browser and keeps them as encoded JPEG files
// (Blobs), like files a user has imported. Generating all 200 takes a while (each is
// drawn at full size and encoded), so it happens once, before any run, and is not
// timed. Browser only.

import type { ImageSource } from "./engine.ts";
import { fillImagePixels } from "./images.ts";
import type { ImageAsset, Scene } from "./scene.ts";

export const IMAGE_TYPE = "image/jpeg";
export const IMAGE_QUALITY = 0.9;

export interface ImageStore extends ImageSource {
  /** Total size of the encoded files, in bytes. */
  readonly encodedBytes: number;
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
  const [canvas, context] = createCanvas(asset.width, asset.height);
  const image = context.createImageData(asset.width, asset.height);
  fillImagePixels(asset, image.data);
  context.putImageData(image, 0, 0);
  const blob = await encode(canvas);
  // Release the canvas memory right away instead of waiting for garbage collection.
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

/**
 * Generates every image of the scene. `onProgress` is called after each image with
 * the number done so far.
 */
export async function prepareImages(
  scene: Scene,
  onProgress?: (done: number, total: number) => void,
): Promise<ImageStore> {
  const start = performance.now();
  const blobs = new Map<string, Blob>();
  let encodedBytes = 0;
  for (const asset of scene.assets) {
    const blob = await generateImage(asset);
    blobs.set(asset.id, blob);
    encodedBytes += blob.size;
    onProgress?.(blobs.size, scene.assets.length);
  }
  const generationMs = performance.now() - start;
  return {
    encodedBytes,
    generationMs,
    getBlob(assetId: string): Blob {
      const blob = blobs.get(assetId);
      if (blob === undefined) throw new Error(`Unknown image asset ${assetId}`);
      return blob;
    },
  };
}
