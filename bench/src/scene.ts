// SPDX-License-Identifier: GPL-3.0-or-later

// The fixed benchmark scene: 2,000 elements (1,200 shapes, 600 text boxes, 200
// images of 2 to 12 megapixels) in ten clusters. The generator uses only the seeded
// generator in prng.ts and basic arithmetic (no Math.sin, Math.exp and the like,
// which JavaScript engines may round differently), so the scene is bit-identical in
// every engine.
//
// Coordinates are world units. An element's x and y are its top-left corner before
// rotation; rotation is in degrees, clockwise, around the element's centre. Elements
// are listed in paint order: later elements are drawn on top.

import { createRng, deriveSeed, hashString, type Rng, shuffle } from "./prng.ts";

/** Bump when the generated scene changes, so stored results can be told apart. */
export const SCENE_VERSION = 1;
export const DEFAULT_SCENE_SEED = 20261126;

export const SHAPE_COUNT = 1200;
export const TEXT_COUNT = 600;
export const IMAGE_COUNT = 200;
export const MIN_IMAGE_PIXELS = 2_000_000;
export const MAX_IMAGE_PIXELS = 12_000_000;

/** Clusters form a grid; each one is a 16:9 region of the canvas. */
export const CLUSTER_COLUMNS = 5;
export const CLUSTER_ROWS = 2;
export const CLUSTER_WIDTH = 9600;
export const CLUSTER_HEIGHT = 5400;
export const CLUSTER_GAP = 2400;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ElementBase extends Rect {
  readonly id: string;
  /** Degrees, clockwise, around the centre. */
  readonly rotation: number;
  /** 0 to 1. */
  readonly opacity: number;
}

export type ShapeKind = "rect" | "ellipse" | "triangle" | "line";

export interface ShapeElement extends ElementBase {
  readonly kind: "shape";
  /** "triangle" points up inside the box; "line" runs from top-left to bottom-right. */
  readonly shape: ShapeKind;
  /** CSS colour "#rrggbb", or null for no fill. Always null for lines. */
  readonly fill: string | null;
  /** CSS colour "#rrggbb", or null for no outline. Never null for lines. */
  readonly stroke: string | null;
  /** World units. */
  readonly strokeWidth: number;
}

export type FontFamily = "sans-serif" | "serif" | "monospace";

export interface TextElement extends ElementBase {
  readonly kind: "text";
  /** Plain text. Wrap at word boundaries to `width`; "\n" starts a new paragraph. */
  readonly text: string;
  /** Generic CSS family, so no font files are needed. */
  readonly fontFamily: FontFamily;
  /** World units. */
  readonly fontSize: number;
  readonly fontWeight: 400 | 700;
  /** Multiple of fontSize. */
  readonly lineHeight: number;
  readonly color: string;
  readonly align: "left" | "center" | "right";
}

export interface ImageElement extends ElementBase {
  readonly kind: "image";
  /** Id of an entry in Scene.assets. The element keeps the asset's aspect ratio. */
  readonly assetId: string;
}

export type SceneElement = ShapeElement | TextElement | ImageElement;

/** An image file. Its pixels come from fillImagePixels (images.ts) with this seed. */
export interface ImageAsset {
  readonly id: string;
  /** Pixels. */
  readonly width: number;
  readonly height: number;
  readonly seed: number;
}

export interface Scene {
  readonly version: number;
  readonly seed: number;
  /** Bounding box of all clusters. */
  readonly bounds: Rect;
  /** The cluster regions, in order. */
  readonly clusters: readonly Rect[];
  /** Paint order. */
  readonly elements: readonly SceneElement[];
  readonly assets: readonly ImageAsset[];
}

const FONT_FAMILIES: readonly FontFamily[] = ["sans-serif", "serif", "monospace"];
const ASPECT_RATIOS: readonly (readonly [number, number])[] = [
  [4, 3],
  [3, 2],
  [16, 9],
  [1, 1],
  [3, 4],
  [2, 3],
];

// Syllables for made-up words. They include letters outside ASCII (æ, ø, å, é, ü)
// so that engines have to handle them.
const SYLLABLES: readonly string[] = [
  "ka",
  "lo",
  "mi",
  "ne",
  "sa",
  "tu",
  "ri",
  "ve",
  "bo",
  "da",
  "fje",
  "sk",
  "gar",
  "len",
  "str",
  "in",
  "on",
  "el",
  "an",
  "or",
  "ut",
  "ble",
  "kø",
  "sæ",
  "må",
  "vé",
  "dü",
  "ty",
  "pa",
  "hu",
  "jo",
  "rek",
];

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function color(rng: Rng): string {
  return `#${(rng.nextUint32() & 0xffffff).toString(16).padStart(6, "0")}`;
}

function word(rng: Rng): string {
  let w = "";
  const syllables = rng.int(1, 4);
  for (let i = 0; i < syllables; i++) w += rng.pick(SYLLABLES);
  return w;
}

function sentence(rng: Rng, words: number): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    let w = rng.chance(0.05) ? String(rng.int(1, 2026)) : word(rng);
    if (i === 0) w = w.charAt(0).toUpperCase() + w.slice(1);
    parts.push(w);
    if (i < words - 1 && rng.chance(0.08)) parts.push(rng.chance(0.5) ? "–" : "·");
  }
  return `${parts.join(" ")}${rng.pick([".", ".", ".", "?", "!", ":"])}`;
}

function paragraphText(rng: Rng, words: number): string {
  const sentences: string[] = [];
  let left = words;
  while (left > 0) {
    const n = Math.min(left, rng.int(3, 14));
    sentences.push(sentence(rng, n));
    left -= n;
  }
  let text = "";
  for (let i = 0; i < sentences.length; i++) {
    if (i > 0) text += i % 4 === 0 && rng.chance(0.5) ? "\n" : " ";
    text += sentences[i];
  }
  return text;
}

/** Integer square root: the largest r with r * r <= n, for 0 <= n < 2^52. */
function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function rotation(rng: Rng, probability: number): number {
  return rng.chance(probability) ? rng.int(-45, 45) : 0;
}

function opacity(rng: Rng): number {
  return rng.chance(0.8) ? 1 : rng.int(30, 95) / 100;
}

function placeIn(rng: Rng, cluster: Rect, width: number, height: number) {
  const margin = 100;
  const w = Math.min(width, cluster.width - 2 * margin);
  const h = Math.min(height, cluster.height - 2 * margin);
  return {
    x: cluster.x + rng.int(margin, cluster.width - margin - w),
    y: cluster.y + rng.int(margin, cluster.height - margin - h),
    width: w,
    height: h,
  };
}

function makeShape(rng: Rng, id: string, cluster: Rect): ShapeElement {
  const sizeClass = rng.next();
  const [lo, hi] =
    sizeClass < 0.6 ? [40, 300] : sizeClass < 0.9 ? [300, 900] : [900, 2400];
  const width = rng.int(lo, hi);
  const height = Math.max(20, Math.floor((width * rng.int(30, 300)) / 100));
  const shape = rng.pick<ShapeKind>(["rect", "rect", "ellipse", "triangle", "line"]);
  const isLine = shape === "line";
  const hasStroke = isLine || rng.chance(0.5);
  return {
    kind: "shape",
    id,
    shape,
    ...placeIn(rng, cluster, width, height),
    rotation: rotation(rng, 0.25),
    opacity: opacity(rng),
    fill: isLine ? null : color(rng),
    stroke: hasStroke ? color(rng) : null,
    strokeWidth: hasStroke ? rng.int(1, isLine ? 24 : 12) : 0,
  };
}

function makeText(rng: Rng, id: string, cluster: Rect): TextElement {
  const sizeClass = rng.next();
  let fontSize: number;
  let words: number;
  let fontWeight: 400 | 700 = 400;
  if (sizeClass < 0.7) {
    fontSize = rng.int(12, 40);
    words = rng.int(8, 80);
  } else if (sizeClass < 0.9) {
    fontSize = rng.int(48, 140);
    words = rng.int(2, 8);
    fontWeight = 700;
  } else {
    // Fine print that only becomes readable when zoomed in.
    fontSize = rng.int(2, 8);
    words = rng.int(20, 120);
  }
  const text = paragraphText(rng, words);
  const lineHeight = 1.25;
  const width = Math.min(3600, fontSize * rng.int(8, 36));
  // A rough box height so engines can cull without laying out text first: about
  // 0.55 em per character, plus one spare line.
  const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  const lines = Math.ceil(text.length / charsPerLine) + 1;
  const height = Math.ceil(lines * fontSize * lineHeight);
  return {
    kind: "text",
    id,
    text,
    ...placeIn(rng, cluster, width, height),
    rotation: rotation(rng, 0.1),
    opacity: rng.chance(0.9) ? 1 : rng.int(50, 95) / 100,
    fontFamily: rng.pick(FONT_FAMILIES),
    fontSize,
    fontWeight,
    lineHeight,
    color: color(rng),
    align: rng.pick(["left", "left", "center", "right"] as const),
  };
}

function makeAssets(rng: Rng): ImageAsset[] {
  // Pixel counts evenly spread from 2 to 12 megapixels, in shuffled order.
  const targets: number[] = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    targets.push(
      MIN_IMAGE_PIXELS +
        Math.round((i * (MAX_IMAGE_PIXELS - MIN_IMAGE_PIXELS)) / (IMAGE_COUNT - 1)),
    );
  }
  shuffle(targets, rng);
  return targets.map((target, i) => {
    const [a, b] = rng.pick(ASPECT_RATIOS);
    const width = Math.max(1, isqrt(Math.floor((target * a) / b)));
    let height = Math.max(1, Math.round(target / width));
    while (width * height < MIN_IMAGE_PIXELS) height++;
    while (width * height > MAX_IMAGE_PIXELS) height--;
    return { id: `a${pad(i + 1, 3)}`, width, height, seed: rng.nextUint32() };
  });
}

function makeImage(rng: Rng, id: string, cluster: Rect, asset: ImageAsset): ImageElement {
  const width = rng.int(400, 2400);
  const height = Math.max(1, Math.round((width * asset.height) / asset.width));
  // Keep the aspect ratio exact: place a box of the wanted size, never clipped.
  const margin = 100;
  const scale = Math.min(
    1,
    (cluster.width - 2 * margin) / width,
    (cluster.height - 2 * margin) / height,
  );
  const w = Math.floor(width * scale);
  const h = Math.floor(height * scale);
  return {
    kind: "image",
    id,
    assetId: asset.id,
    ...placeIn(rng, cluster, w, h),
    rotation: rotation(rng, 0.15),
    opacity: rng.chance(0.95) ? 1 : rng.int(50, 95) / 100,
  };
}

/** Generates the benchmark scene. The same seed always gives the same scene. */
export function generateScene(seed: number = DEFAULT_SCENE_SEED): Scene {
  const clusters: Rect[] = [];
  for (let row = 0; row < CLUSTER_ROWS; row++) {
    for (let col = 0; col < CLUSTER_COLUMNS; col++) {
      clusters.push({
        x: col * (CLUSTER_WIDTH + CLUSTER_GAP),
        y: row * (CLUSTER_HEIGHT + CLUSTER_GAP),
        width: CLUSTER_WIDTH,
        height: CLUSTER_HEIGHT,
      });
    }
  }
  const assets = makeAssets(createRng(deriveSeed(seed, 1)));
  const clusterCount = clusters.length;
  const shapesPer = SHAPE_COUNT / clusterCount;
  const textsPer = TEXT_COUNT / clusterCount;
  const imagesPer = IMAGE_COUNT / clusterCount;

  const elements: SceneElement[] = [];
  let shapeNo = 0;
  let textNo = 0;
  let imageNo = 0;
  clusters.forEach((cluster, c) => {
    const rng = createRng(deriveSeed(seed, 100 + c));
    // A large backdrop first, like a frame on a slide, then the rest in mixed order.
    elements.push({
      kind: "shape",
      id: `s${pad(++shapeNo, 4)}`,
      shape: "rect",
      ...cluster,
      rotation: 0,
      opacity: 1,
      fill: color(rng),
      stroke: color(rng),
      strokeWidth: 16,
    });
    const kinds: ("shape" | "text" | "image")[] = [];
    for (let i = 1; i < shapesPer; i++) kinds.push("shape");
    for (let i = 0; i < textsPer; i++) kinds.push("text");
    for (let i = 0; i < imagesPer; i++) kinds.push("image");
    shuffle(kinds, rng);
    for (const kind of kinds) {
      if (kind === "shape") {
        elements.push(makeShape(rng, `s${pad(++shapeNo, 4)}`, cluster));
      } else if (kind === "text") {
        elements.push(makeText(rng, `t${pad(++textNo, 4)}`, cluster));
      } else {
        const asset = assets[imageNo] as ImageAsset;
        elements.push(makeImage(rng, `i${pad(++imageNo, 4)}`, cluster, asset));
      }
    }
  });

  const last = clusters[clusters.length - 1] as Rect;
  return {
    version: SCENE_VERSION,
    seed,
    bounds: { x: 0, y: 0, width: last.x + last.width, height: last.y + last.height },
    clusters,
    elements,
    assets,
  };
}

export interface SceneSummary {
  readonly version: number;
  readonly seed: number;
  /** FNV-1a hash of the scene as JSON. Changes whenever any value changes. */
  readonly hash: string;
  readonly elements: number;
  readonly shapes: number;
  readonly texts: number;
  readonly images: number;
  readonly imagePixels: {
    readonly total: number;
    readonly min: number;
    readonly max: number;
  };
  /** Bytes needed to hold every image fully decoded as RGBA (4 bytes per pixel). */
  readonly decodedImageBytes: number;
}

export function summarizeScene(scene: Scene): SceneSummary {
  const count = (kind: SceneElement["kind"]) =>
    scene.elements.filter((e) => e.kind === kind).length;
  const pixels = scene.assets.map((a) => a.width * a.height);
  const total = pixels.reduce((sum, p) => sum + p, 0);
  return {
    version: scene.version,
    seed: scene.seed,
    hash: hashString(JSON.stringify(scene)),
    elements: scene.elements.length,
    shapes: count("shape"),
    texts: count("text"),
    images: count("image"),
    imagePixels: { total, min: Math.min(...pixels), max: Math.max(...pixels) },
    decodedImageBytes: total * 4,
  };
}
