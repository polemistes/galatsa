// SPDX-License-Identifier: GPL-3.0-or-later

// The sample scene of the development page: the benchmark scene of @galatsa/bench
// (2,000 elements: shapes, text boxes and images in ten clusters) as a Galatsa
// document of the shape extension's and the example extensions' element types,
// opened through the
// storage layer like any file. The benchmark's images are 2 to 12 megapixels
// and take half a minute to generate; here each gets a small generated picture
// of the same proportions instead, so the page opens in a moment.
//
// The page remembers the stored copy and opens it again on the next visit, so
// work on it is kept; `?fresh` makes a new one.

import { generateScene, type Scene } from "@galatsa/bench";
import {
  keysBetween,
  MIN_READER_VERSION,
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DocumentSnapshot,
  type Element,
  type ElementData,
  type ElementId,
} from "@galatsa/core";
import { fromSnapshot } from "@galatsa/core/ydoc";
import { TEXT_TYPE, textView } from "@galatsa/extension-examples";
import { IMAGE_TYPE, imageView } from "@galatsa/extension-image/view";
import {
  SHAPE_TYPE,
  newShapeData,
  shapeKinds,
  shapeView,
} from "@galatsa/extension-shape";
import { assetIdOf, FILE_EXTENSION, writeGalatsaFile } from "@galatsa/format";
import type { DocumentStorage, OpenResult } from "@galatsa/storage";

// A new key since the shapes became the shape extension's, so that a copy
// stored before (of the shape sketch's type) is not opened again.
const SLOT_KEY = "galatsa-dev:sample-slot-2";
/** Long side of the generated pictures, in pixels. */
const PICTURE_SIZE = 160;

function remembered(): string | null {
  try {
    return localStorage.getItem(SLOT_KEY);
  } catch {
    return null;
  }
}

function remember(slot: string): void {
  try {
    localStorage.setItem(SLOT_KEY, slot);
  } catch {
    // Without local storage the next visit makes a new copy.
  }
}

function hue(seed: number, shift: number): string {
  return `hsl(${(seed + shift * 97) % 360} 60% ${45 + (shift % 3) * 10}%)`;
}

async function encodePng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}

/** A small picture with the proportions of a benchmark image. */
async function picture(width: number, height: number, seed: number): Promise<Uint8Array> {
  const scale = PICTURE_SIZE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(w, h);
  else {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d") as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (ctx === null) throw new Error("No 2D canvas context");
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, hue(seed % 360, 0));
  gradient.addColorStop(1, hue(seed % 360, 1));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = hue(seed % 360, 2);
  ctx.beginPath();
  ctx.arc(w * 0.3, h * 0.6, Math.min(w, h) * 0.25, 0, 2 * Math.PI);
  ctx.fill();
  const blob = await encodePng(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

function turn(degrees: number): number {
  const full = 2 * Math.PI;
  const rad = (degrees * Math.PI) / 180;
  return ((rad % full) + full) % full;
}

/** The benchmark scene as a document snapshot, with the pictures' bytes. */
export async function sampleSnapshot(
  title: string,
  scene: Scene = generateScene(),
): Promise<{ snapshot: DocumentSnapshot; bytes: Map<AssetId, Uint8Array> }> {
  const bytes = new Map<AssetId, Uint8Array>();
  const assets: { [id: AssetId]: AssetInfo } = {};
  const assetIds = new Map<string, AssetId>();
  for (const asset of scene.assets) {
    const data = await picture(asset.width, asset.height, asset.seed);
    const id = await assetIdOf(data);
    const scale = PICTURE_SIZE / Math.max(asset.width, asset.height);
    bytes.set(id, data);
    assetIds.set(asset.id, id);
    assets[id] = {
      mediaType: "image/png",
      byteLength: data.length,
      width: Math.max(1, Math.round(asset.width * scale)),
      height: Math.max(1, Math.round(asset.height * scale)),
    };
  }
  const orders = keysBetween(null, null, scene.elements.length);
  const elements: { [id: ElementId]: Element } = {};
  scene.elements.forEach((e, index) => {
    let type: string;
    let typeVersion: number;
    let data: ElementData;
    let box = { x: e.x, y: e.y, w: e.width, h: e.height, rot: turn(e.rotation) };
    if (e.kind === "shape") {
      type = SHAPE_TYPE;
      typeVersion = shapeView.typeVersion;
      // Kinds the shape extension does not have yet are drawn as rectangles.
      const kind = shapeKinds.kinds.has(e.shape) ? e.shape : "rect";
      data = newShapeData(shapeKinds, kind, {
        fill: e.fill,
        stroke: e.stroke,
        strokeWidth: e.strokeWidth,
        opacity: e.opacity,
      });
      if (kind === "line") {
        // The benchmark's line runs from corner to corner of its box; a line
        // shape runs along the middle of a box 0 high, turned its way.
        const length = Math.hypot(e.width, e.height);
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        box = {
          x: cx - length / 2,
          y: cy,
          w: length,
          h: 0,
          rot: turn(e.rotation + (Math.atan2(e.height, e.width) * 180) / Math.PI),
        };
      }
    } else if (e.kind === "text") {
      type = TEXT_TYPE;
      typeVersion = textView.typeVersion;
      data = {
        text: { $y: "text", delta: [{ insert: e.text }] },
        fontSize: e.fontSize,
        color: e.color,
        fontFamily: e.fontFamily === "serif" ? "serif" : "sans",
        align: e.align,
      };
    } else {
      type = IMAGE_TYPE;
      typeVersion = imageView.typeVersion;
      data = { asset: assetIds.get(e.assetId) ?? "", crop: null, opacity: e.opacity };
    }
    elements[e.id] = {
      type,
      typeVersion,
      parent: null,
      order: orders[index]!,
      pos: { x: box.x, y: box.y, space: null },
      rebase: null,
      name: "",
      locked: false,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [],
      ext: {},
      data,
      size: { w: box.w, h: box.h },
      rot: box.rot,
    } as Element;
  });
  return {
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      id: "sample-scene",
      title,
      settings: {},
      elements,
      stops: {},
      routes: {},
      assets,
    },
    bytes,
  };
}

/**
 * Opens the sample scene: the stored copy from an earlier visit, or a new one
 * made from the benchmark scene.
 */
export async function openSampleScene(
  storage: DocumentStorage,
  options: { readonly title: string; readonly fresh: boolean },
): Promise<OpenResult> {
  const slot = remembered();
  if (!options.fresh && slot !== null) {
    const stored = await storage.list().catch(() => []);
    if (stored.some((d) => d.slot === slot && !d.open)) {
      const result = await storage.open(slot);
      if (result.ok) return result;
    }
  }
  const { snapshot, bytes } = await sampleSnapshot(options.title);
  const doc = fromSnapshot(snapshot);
  const file = writeGalatsaFile(doc, (id) => bytes.get(id)).bytes;
  doc.destroy();
  const result = await storage.importFile(file, {
    name: `${options.title}${FILE_EXTENSION}`,
  });
  if (result.ok) remember(result.session.slot);
  return result;
}
