// SPDX-License-Identifier: GPL-3.0-or-later

// Procedural pixels for the scene's images, so no image files are downloaded or
// shipped. Each image has a four-colour gradient, flat rectangles and discs, a thin
// grid every 128 pixels (it shows how well an engine downsamples) and a little noise
// (so the images compress more like photos). Only integer arithmetic and exact
// floating-point operations are used, so the pixels are identical in every
// JavaScript engine. Encoding to JPEG is left to the browser (image-store.ts), and
// the encoded bytes do differ between browsers.

import { createRng } from "./prng.ts";
import type { ImageAsset } from "./scene.ts";

export const GRID_SPACING = 128;

interface Span {
  readonly top: number;
  readonly bottom: number;
  /** Left and right edge (exclusive) for row y, or undefined if the row is outside. */
  readonly edges: (y: number) => readonly [number, number] | undefined;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/**
 * Writes the RGBA pixels of an image into `data` (length width * height * 4), row by
 * row from the top. `data` is usually the `data` of an ImageData.
 */
export function fillImagePixels(asset: ImageAsset, data: Uint8ClampedArray): void {
  const { width: w, height: h } = asset;
  if (data.length !== w * h * 4) {
    throw new RangeError(`Expected ${w * h * 4} bytes, got ${data.length}`);
  }
  const rng = createRng(asset.seed);
  const corner = () => [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)] as const;
  const c00 = corner();
  const c10 = corner();
  const c01 = corner();
  const c11 = corner();

  const shapes: Span[] = [];
  for (let i = 0; i < 10; i++) {
    const sw = rng.int(Math.floor(w / 20), Math.floor(w / 3));
    const sh = rng.int(Math.floor(h / 20), Math.floor(h / 3));
    const x0 = rng.int(0, w - sw);
    const y0 = rng.int(0, h - sh);
    const edges = [x0, x0 + sw] as const;
    shapes.push({
      top: y0,
      bottom: y0 + sh,
      edges: () => edges,
      r: rng.int(0, 255),
      g: rng.int(0, 255),
      b: rng.int(0, 255),
    });
  }
  for (let i = 0; i < 6; i++) {
    const radius = rng.int(
      Math.floor(Math.min(w, h) / 30),
      Math.floor(Math.min(w, h) / 5),
    );
    const cx = rng.int(radius, w - radius);
    const cy = rng.int(radius, h - radius);
    shapes.push({
      top: cy - radius,
      bottom: cy + radius,
      edges: (y) => {
        const dy = y - cy;
        const half = isqrt(radius * radius - dy * dy);
        return [cx - half, cx + half];
      },
      r: rng.int(0, 255),
      g: rng.int(0, 255),
      b: rng.int(0, 255),
    });
  }
  const noiseSeed = rng.nextUint32();

  const rowR = new Uint8Array(w);
  const rowG = new Uint8Array(w);
  const rowB = new Uint8Array(w);
  const invW = w > 1 ? 1 / (w - 1) : 0;
  const invH = h > 1 ? 1 / (h - 1) : 0;

  for (let y = 0; y < h; y++) {
    const fy = y * invH;
    const lr = c00[0] + (c01[0] - c00[0]) * fy;
    const lg = c00[1] + (c01[1] - c00[1]) * fy;
    const lb = c00[2] + (c01[2] - c00[2]) * fy;
    const rr = c10[0] + (c11[0] - c10[0]) * fy;
    const rg = c10[1] + (c11[1] - c10[1]) * fy;
    const rb = c10[2] + (c11[2] - c10[2]) * fy;
    for (let x = 0; x < w; x++) {
      const fx = x * invW;
      rowR[x] = lr + (rr - lr) * fx;
      rowG[x] = lg + (rg - lg) * fx;
      rowB[x] = lb + (rb - lb) * fx;
    }
    for (const s of shapes) {
      if (y < s.top || y >= s.bottom) continue;
      const e = s.edges(y);
      if (e === undefined) continue;
      rowR.fill(s.r, Math.max(0, e[0]), Math.min(w, e[1]));
      rowG.fill(s.g, Math.max(0, e[0]), Math.min(w, e[1]));
      rowB.fill(s.b, Math.max(0, e[0]), Math.min(w, e[1]));
    }
    const gridRow = y % GRID_SPACING === 0;
    let o = y * w * 4;
    for (let x = 0; x < w; x++) {
      const hash = Math.imul(x ^ Math.imul(y, 0x27d4eb2d) ^ noiseSeed, 0x165667b1);
      const noise = (hash >>> 28) - 8;
      if (gridRow || x % GRID_SPACING === 0) {
        data[o] = rowR[x]! >> 2;
        data[o + 1] = rowG[x]! >> 2;
        data[o + 2] = rowB[x]! >> 2;
      } else {
        data[o] = rowR[x]! + noise;
        data[o + 1] = rowG[x]! + noise;
        data[o + 2] = rowB[x]! + noise;
      }
      data[o + 3] = 255;
      o += 4;
    }
  }
}
