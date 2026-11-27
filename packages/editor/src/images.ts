// SPDX-License-Identifier: GPL-3.0-or-later

// Images for the renderer from where the document's asset bytes are kept (the
// storage session), until the asset store with reduced versions exists: each
// image has one stored version, the original, with the pixel size its asset
// description gives. Bytes are fetched when the renderer first asks, and the
// renderer is told when they arrive.

import type { AssetId, Size } from "@galatsa/core";
import { roots } from "@galatsa/core/ydoc";
import type { ImageSource, SceneAssets } from "@galatsa/renderer";
import type * as Y from "yjs";

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

/**
 * An image source over an asset reader. `onArrived` is called with assets
 * whose bytes arrived; pass them to the renderer's `imagesChanged`.
 */
export function assetImages(
  doc: Y.Doc,
  read: AssetReader,
  onArrived: (assets: string[]) => void,
): ImageSource {
  const bytes = new Map<string, Blob>();
  const asking = new Set<string>();
  const fetch = (asset: string): void => {
    if (asking.has(asset)) return;
    asking.add(asset);
    read(asset as AssetId)
      .then((data) => {
        if (data === undefined) return;
        const type = describe(doc, asset)?.mediaType;
        bytes.set(
          asset,
          new Blob([data as Uint8Array<ArrayBuffer>], {
            type: typeof type === "string" ? type : "",
          }),
        );
        onArrived([asset]);
      })
      .catch(() => {})
      .finally(() => asking.delete(asset));
  };
  return {
    levels(asset) {
      const size = sizeOf(describe(doc, asset));
      if (size === undefined) return undefined;
      if (!bytes.has(asset)) {
        fetch(asset);
        return undefined;
      }
      return [{ width: size.w, height: size.h }];
    },
    blob(asset) {
      const blob = bytes.get(asset);
      if (blob === undefined) throw new Error(`No bytes for ${asset}`);
      return blob;
    },
  };
}
