// SPDX-License-Identifier: GPL-3.0-or-later

// Making the reduced versions of an image (docs/adr/0012-images-and-assets.md):
// halves of each other, from a long side of 256 pixels up to the largest that
// is still clearly smaller than the original, encoded once when the image is
// added. The renderer then decodes these instead of the original until the
// image is larger on screen than the largest of them (docs/adr/0004, "Image
// levels of detail").
//
// The original is decoded once, at the size of the largest version where the
// browser can (ImageDecoder decodes JPEG at reduced size), and each smaller
// version is scaled from the next larger one.

import { SVG_TYPE, decodeSvg, makeCanvas, type Decoded } from "./images.ts";

/** One encoded reduced version. */
export interface MadePreview {
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/webp" | "image/png" | "image/jpeg";
  readonly bytes: Uint8Array;
}

export interface PreviewOptions {
  /** Long side of the smallest version (default 256). */
  readonly smallest?: number;
  /** Long side of the largest version (default 4096). */
  readonly largest?: number;
  /** Encoder quality for WebP and JPEG, 0 to 1 (default 0.85). */
  readonly quality?: number;
}

export const PREVIEW_SMALLEST = 256;
export const PREVIEW_LARGEST = 4096;
/**
 * A version is made only if the original is at least this many times as large:
 * a version nearly as large as the original would cost nearly as much to
 * decode and store, and save little.
 */
export const PREVIEW_MARGIN = 1.5;

/**
 * The sizes of the reduced versions of an image of the given natural size,
 * smallest first: long sides 256, 512, 1024 ... while the original is at least
 * PREVIEW_MARGIN times as large and up to `largest`. None for small images.
 */
export function previewSizes(
  width: number,
  height: number,
  options: PreviewOptions = {},
): { width: number; height: number }[] {
  const smallest = options.smallest ?? PREVIEW_SMALLEST;
  const largest = options.largest ?? PREVIEW_LARGEST;
  const long = Math.max(width, height);
  const out: { width: number; height: number }[] = [];
  if (!(long > 0) || !Number.isFinite(long)) return out;
  for (let side = smallest; side <= largest && side * PREVIEW_MARGIN <= long; side *= 2) {
    const f = side / long;
    out.push({
      width: Math.max(1, Math.round(width * f)),
      height: Math.max(1, Math.round(height * f)),
    });
  }
  return out;
}

/** Decodes an image file at (width, height), as cheaply as the browser allows. */
async function decodeAt(blob: Blob, width: number, height: number): Promise<Decoded> {
  if (blob.type === SVG_TYPE) return decodeSvg(blob, width, height);
  if (typeof ImageDecoder === "function" && blob.type !== "") {
    try {
      if (await ImageDecoder.isTypeSupported(blob.type)) {
        const decoder = new ImageDecoder({
          data: blob.stream(),
          type: blob.type,
          desiredWidth: width,
          desiredHeight: height,
        });
        try {
          const { image } = await decoder.decode();
          try {
            const bitmap = await createImageBitmap(image, {
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: "high",
            });
            return bitmapDecoded(bitmap);
          } finally {
            image.close();
          }
        } finally {
          decoder.close();
        }
      }
    } catch {
      // Fall through to createImageBitmap.
    }
  }
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
  return bitmapDecoded(bitmap);
}

function bitmapDecoded(bitmap: ImageBitmap): Decoded {
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function draw(source: CanvasImageSource, width: number, height: number): Canvas {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d") as Context | null;
  if (!ctx) throw new Error("no 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function encode(canvas: Canvas, type: string, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("encoding failed"))),
      type,
      quality,
    ),
  );
}

/** True if any pixel of the canvas is not fully opaque. */
function hasAlpha(canvas: Canvas): boolean {
  const ctx = canvas.getContext("2d") as Context | null;
  if (!ctx) return true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/**
 * Makes the reduced versions of an image file (raster or SVG) of the given
 * natural size, smallest first. WebP where the browser can encode it; where it
 * cannot (WebKit), JPEG for opaque images and PNG for images with transparency.
 * Empty for images too small to need any. Rejects if the image cannot be
 * decoded.
 */
export async function makeImagePreviews(
  blob: Blob,
  natural: { readonly width: number; readonly height: number },
  options: PreviewOptions = {},
): Promise<MadePreview[]> {
  const sizes = previewSizes(natural.width, natural.height, options);
  if (sizes.length === 0) return [];
  const quality = options.quality ?? 0.85;
  const largest = sizes[sizes.length - 1]!;
  const decoded = await decodeAt(blob, largest.width, largest.height);
  const canvases: Canvas[] = [];
  try {
    // Largest first, each from the next larger one, so every step halves.
    let source: CanvasImageSource = decoded.image;
    for (let i = sizes.length - 1; i >= 0; i--) {
      const size = sizes[i]!;
      const canvas = draw(source, size.width, size.height);
      canvases[i] = canvas;
      source = canvas;
    }
  } finally {
    decoded.close();
  }
  let type: MadePreview["mediaType"] = "image/webp";
  const probe = await encode(canvases[0]!, type, quality);
  if (probe.type !== type) type = hasAlpha(canvases[0]!) ? "image/png" : "image/jpeg";
  const out: MadePreview[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const blobOut =
      i === 0 && probe.type === type ? probe : await encode(canvases[i]!, type, quality);
    out.push({
      width: sizes[i]!.width,
      height: sizes[i]!.height,
      mediaType: type,
      bytes: new Uint8Array(await blobOut.arrayBuffer()),
    });
  }
  return out;
}
