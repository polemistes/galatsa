// SPDX-License-Identifier: GPL-3.0-or-later

// Images for the renderer from where the document's asset bytes are kept (the
// storage session): each image's stored reduced versions, smallest first, and
// the original last, with the pixel size its asset description gives
// (docs/adr/0012-images-and-assets.md). Only the list of versions is fetched
// when the renderer first asks; the bytes of a version are read when the
// renderer decodes it, so opening a document reads and decodes no original.
//
// An image without reduced versions (from a file of an older version, a
// shared export that carries only the smallest, or pasted from another
// document) gets them made in the background, one image at a time, when the
// renderer first asks for it; until then it is drawn from its original.

import type { AssetId, Size } from "@galatsa/core";
import { roots } from "@galatsa/core/ydoc";
import type { PreviewFacts } from "@galatsa/format";
import {
  SVG_TYPE,
  type ImageLevel,
  type ImageSource,
  type SceneAssets,
} from "@galatsa/renderer";
import type * as Y from "yjs";
import { ensurePreviews, type AssetAccess, type PreviewMaker } from "./assets.ts";

interface Description {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly mediaType?: unknown;
}

function describe(doc: Y.Doc, asset: string): Description | undefined {
  const value = roots(doc).assets.get(asset) as unknown;
  if (value === null || typeof value !== "object") return undefined;
  // A description written as a shared map (a peer may do that) or a plain object.
  const get = (key: string): unknown =>
    typeof (value as { get?: unknown }).get === "function"
      ? (value as { get(key: string): unknown }).get(key)
      : (value as Record<string, unknown>)[key];
  return { width: get("width"), height: get("height"), mediaType: get("mediaType") };
}

function sizeOf(d: Description | undefined): Size | undefined {
  if (d === undefined) return undefined;
  const { width, height } = d;
  return typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0
    ? { w: width, h: height }
    : undefined;
}

/** Natural pixel sizes from the document's asset descriptions. */
export function documentAssets(doc: Y.Doc): SceneAssets {
  return { imageSize: (asset) => sizeOf(describe(doc, asset)) };
}

/** Where asset bytes are read from (the storage session's `getAsset`). */
export type AssetReader = (id: AssetId) => Promise<Uint8Array | undefined>;

/** What is known of an asset's stored versions. */
interface Known {
  readonly previews: readonly PreviewFacts[];
  /** The original's bytes, read already (only for images without previews). */
  original: Blob | null;
}

export interface AssetImagesOptions {
  /** Makes reduced versions that are missing (default the renderer's; null: never). */
  readonly makePreviews?: PreviewMaker | null;
  /** Counts reads of originals, for tests and diagnosis. */
  readonly stats?: { originalReads: number };
}

/**
 * An image source over the session's assets and reduced versions.
 * `onArrived` is called with assets whose versions or bytes arrived or
 * changed; pass them to the renderer's `imagesChanged`. Takes a plain asset
 * reader too (no reduced versions then).
 */
export function assetImages(
  doc: Y.Doc,
  access: AssetAccess | AssetReader,
  onArrived: (assets: string[]) => void,
  options: AssetImagesOptions = {},
): ImageSource {
  const full: Partial<AssetAccess> =
    typeof access === "function" ? { getAsset: access } : access;
  // Called as a method: the session's methods use their own object.
  const getAsset = (id: AssetId): Promise<Uint8Array | undefined> => full.getAsset!(id);
  const known = new Map<string, Known>();
  const asking = new Set<string>();
  const making = new Set<string>();
  const queue: string[] = [];
  let busy = false;
  const typeOf = (asset: string): string => {
    const type = describe(doc, asset)?.mediaType;
    return typeof type === "string" ? type : "";
  };
  const readOriginal = async (asset: string): Promise<Blob | undefined> => {
    if (options.stats) options.stats.originalReads++;
    const data = await getAsset(asset as AssetId);
    return data === undefined
      ? undefined
      : new Blob([data as Uint8Array<ArrayBuffer>], { type: typeOf(asset) });
  };
  // Reduced versions are made one image at a time, in the background.
  const make = options.makePreviews === undefined ? undefined : options.makePreviews;
  const pump = (): void => {
    if (busy || full.putPreviews === undefined || make === null) return;
    const asset = queue.shift();
    if (asset === undefined) return;
    busy = true;
    void (async () => {
      try {
        const entry = known.get(asset);
        const blob = entry?.original ?? (await readOriginal(asset));
        const size = sizeOf(describe(doc, asset));
        if (blob === undefined || size === undefined) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const made = await ensurePreviews(
          full as AssetAccess,
          asset as AssetId,
          bytes,
          { mediaType: blob.type, width: size.w, height: size.h },
          ...(make ? [make] : []),
        );
        if (made) {
          known.delete(asset);
          onArrived([asset]);
        }
      } catch {
        // Drawn from the original, as before.
      } finally {
        busy = false;
        pump();
      }
    })();
  };
  const learn = (asset: string): void => {
    if (asking.has(asset)) return;
    asking.add(asset);
    void (async () => {
      try {
        const previews = full.previewFacts
          ? await full.previewFacts(asset as AssetId).catch(() => [])
          : [];
        // Without reduced versions, the original must be there to draw at all.
        const original = previews.length === 0 ? await readOriginal(asset) : null;
        if (previews.length === 0 && original === undefined) return;
        known.set(asset, { previews, original: original ?? null });
        onArrived([asset]);
        if (previews.length === 0 && !making.has(asset)) {
          making.add(asset);
          queue.push(asset);
          pump();
        }
      } catch {
        // Asked again when the renderer retries.
      } finally {
        asking.delete(asset);
      }
    })();
  };
  return {
    levels(asset) {
      const size = sizeOf(describe(doc, asset));
      if (size === undefined) return undefined;
      const entry = known.get(asset);
      if (entry === undefined) {
        learn(asset);
        return undefined;
      }
      const original: ImageLevel =
        typeOf(asset) === SVG_TYPE
          ? { width: size.w, height: size.h, scalable: true }
          : { width: size.w, height: size.h };
      return [
        ...entry.previews.map((p) => ({ width: p.width, height: p.height })),
        original,
      ];
    },
    async blob(asset, level) {
      const entry = known.get(asset);
      if (entry === undefined) throw new Error(`Nothing known of ${asset}`);
      const preview = entry.previews[level];
      if (preview !== undefined) {
        const bytes = await full.getPreview?.(asset as AssetId, preview);
        if (bytes === undefined) throw new Error(`No preview ${level} of ${asset}`);
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: preview.mediaType });
      }
      if (entry.original !== null) return entry.original;
      const blob = await readOriginal(asset);
      if (blob === undefined) throw new Error(`No bytes for ${asset}`);
      // Kept: the renderer decodes it again at other sizes as the zoom changes.
      if (known.get(asset) === entry) entry.original = blob;
      return blob;
    },
  };
}
