// SPDX-License-Identifier: GPL-3.0-or-later

// Reduced versions of image assets ("previews"): smaller encoded copies made
// when an image is added, so that a document opens and draws without decoding
// any original. They are stored in the file beside the assets, outside the
// document and outside the Yjs state, as a cache: they can always be made again
// from the asset, a reader may ignore them, and an older version that does not
// know them drops them when it saves. See docs/adr/0012-images-and-assets.md
// and section 9.1 of docs/adr/0001-document-model-and-file-format.md.
//
//   previews/<asset id>/<width>x<height>.<webp|png|jpg>

import type { AssetId } from "@galatsa/core";
import { isAssetId } from "./hash.ts";

/** The encodings a preview may have. */
export type PreviewMediaType = "image/webp" | "image/png" | "image/jpeg";

/** One reduced version of an image asset. */
export interface AssetPreview {
  /** Pixel size of the encoded image. */
  readonly width: number;
  readonly height: number;
  readonly mediaType: PreviewMediaType;
  readonly bytes: Uint8Array;
}

/** Where the writer gets an asset's previews from; undefined or empty for none. */
export type PreviewSource = (id: AssetId) => readonly AssetPreview[] | undefined;

/**
 * Which previews a file carries: all of them, the smallest of each asset (enough
 * to open and draw the whole document without decoding an original, at about a
 * hundredth of the size of the full set), or none.
 */
export type PreviewsKept = "all" | "smallest" | "none";

export const PREVIEWS_PREFIX = "previews/";
/** The most previews kept per asset; the smallest are kept. */
export const MAX_PREVIEWS_PER_ASSET = 8;
/**
 * The longest side a preview may have, in pixels: the largest version the
 * program makes. A larger one would cost a reader up to 64 MB of pixels per
 * image for what a version is meant to save.
 */
export const MAX_PREVIEW_SIDE = 4096;

const EXTENSION: { readonly [type in PreviewMediaType]: string } = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};
const MEDIA_TYPE: { readonly [extension: string]: PreviewMediaType } = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
};

const NAME =
  /^previews\/(sha256-[0-9a-f]{64})\/([1-9][0-9]{0,4})x([1-9][0-9]{0,4})\.(webp|png|jpg)$/;

/** True for a preview entry's name. */
export function isPreviewEntry(name: string): boolean {
  return parsePreviewEntry(name) !== null;
}

/** The archive entry name of a preview. */
export function previewEntryName(id: AssetId, preview: PreviewFacts): string {
  return `${PREVIEWS_PREFIX}${id}/${preview.width}x${preview.height}.${EXTENSION[preview.mediaType]}`;
}

/** What a preview's name says about it. */
export interface PreviewFacts {
  readonly width: number;
  readonly height: number;
  readonly mediaType: PreviewMediaType;
}

/** The asset and the facts a preview entry's name gives, or null if it is not one. */
export function parsePreviewEntry(
  name: string,
): { readonly asset: AssetId; readonly facts: PreviewFacts } | null {
  const match = NAME.exec(name);
  if (match === null) return null;
  const width = Number(match[2]);
  const height = Number(match[3]);
  if (width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE) return null;
  return {
    asset: match[1]! as AssetId,
    facts: { width, height, mediaType: MEDIA_TYPE[match[4]!]! },
  };
}

function isPreviewMediaType(value: unknown): value is PreviewMediaType {
  return value === "image/webp" || value === "image/png" || value === "image/jpeg";
}

/** True for a preview this format can store. */
export function isValidPreview(preview: AssetPreview): boolean {
  const side = (n: unknown): boolean =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_PREVIEW_SIDE;
  return (
    side(preview.width) &&
    side(preview.height) &&
    isPreviewMediaType(preview.mediaType) &&
    preview.bytes instanceof Uint8Array &&
    preview.bytes.length > 0
  );
}

/** An image's natural pixel size (its asset description's width and height). */
export interface NaturalSize {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/**
 * True if a version fits the image it stands for: its long side shorter than
 * the original's, and its proportions the original's (to the pixel that
 * rounding may cost). A version that does not fit is not one the program made,
 * and is left out: a crafted file could otherwise name a few bytes as a
 * 4096-pixel version of every image, and so make a reader hold gigabytes.
 */
export function fitsOriginal(
  preview: PreviewFacts,
  natural: NaturalSize | undefined,
): boolean {
  const W = natural?.width;
  const H = natural?.height;
  if (typeof W !== "number" || typeof H !== "number" || !(W > 0) || !(H > 0))
    return false;
  const { width: w, height: h } = preview;
  if (Math.max(w, h) >= Math.max(W, H)) return false;
  // h * W equals w * H up to a pixel of rounding on either side.
  return Math.abs(h * W - w * H) <= Math.max(W, H);
}

/**
 * An asset's previews as a file holds them: valid ones only, one per pixel
 * size (the first given wins), smallest first (by width, then height), at most
 * MAX_PREVIEWS_PER_ASSET, and only the first if `kept` is "smallest". With the
 * image's natural size, only versions that fit it (`fitsOriginal`).
 */
export function normalizePreviews(
  previews: readonly AssetPreview[] | undefined,
  kept: PreviewsKept = "all",
  natural?: NaturalSize,
): AssetPreview[] {
  if (previews === undefined || kept === "none") return [];
  const seen = new Set<string>();
  const out: AssetPreview[] = [];
  for (const preview of previews) {
    if (!isValidPreview(preview)) continue;
    if (natural !== undefined && !fitsOriginal(preview, natural)) continue;
    const size = `${preview.width}x${preview.height}`;
    if (seen.has(size)) continue;
    seen.add(size);
    out.push(preview);
  }
  out.sort((a, b) => a.width - b.width || a.height - b.height);
  return out.slice(0, kept === "smallest" ? 1 : MAX_PREVIEWS_PER_ASSET);
}

/**
 * The previews among a file's entries, by asset, smallest first: only those
 * of an asset the document describes with a pixel size, and that fit it
 * (`fitsOriginal`). Their bytes are not checked against the asset: they are a
 * cache, and a damaged one is left out by the archive's checksum.
 */
export function previewsFromEntries(
  entries: ReadonlyMap<string, Uint8Array>,
  described: { readonly [id: AssetId]: NaturalSize | undefined },
): Map<AssetId, AssetPreview[]> {
  const found = new Map<AssetId, AssetPreview[]>();
  for (const [name, bytes] of entries) {
    if (!name.startsWith(PREVIEWS_PREFIX)) continue;
    const parsed = parsePreviewEntry(name);
    if (parsed === null || !isAssetId(parsed.asset)) continue;
    const list = found.get(parsed.asset) ?? [];
    list.push({ ...parsed.facts, bytes });
    found.set(parsed.asset, list);
  }
  const out = new Map<AssetId, AssetPreview[]>();
  for (const [asset, list] of found) {
    const natural = Object.hasOwn(described, asset) ? described[asset] : undefined;
    if (natural === undefined) continue;
    const previews = normalizePreviews(list, "all", natural);
    if (previews.length > 0) out.set(asset, previews);
  }
  return out;
}
