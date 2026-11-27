// SPDX-License-Identifier: GPL-3.0-or-later

// The asset store importers put bytes into (docs/adr/0005 section 6.1), over
// the storage session: each file is stored once, by the SHA-256 of its bytes,
// and an image's reduced versions are made right away, when it is added
// (docs/adr/0012-images-and-assets.md), so that drawing it never needs the
// original until it is that large on screen.

import type { AssetId, AssetInfo } from "@galatsa/core";
import type { AssetStore } from "@galatsa/extension-api/editing";
import type { AssetPreview, PreviewFacts } from "@galatsa/format";
import { makeImagePreviews, previewSizes } from "@galatsa/renderer";

/** What the editor needs of the storage session for assets. */
export interface AssetAccess {
  putAsset(bytes: Uint8Array): Promise<AssetId>;
  getAsset(id: AssetId): Promise<Uint8Array | undefined>;
  putPreviews(id: AssetId, previews: readonly AssetPreview[]): Promise<void>;
  previewFacts(id: AssetId): Promise<PreviewFacts[]>;
  getPreview(id: AssetId, facts: PreviewFacts): Promise<Uint8Array | undefined>;
}

/** Makes the reduced versions of an image file (the renderer's, by default). */
export type PreviewMaker = (
  blob: Blob,
  natural: { readonly width: number; readonly height: number },
) => Promise<readonly AssetPreview[]>;

/** True for media types the renderer draws as images. */
export function isImageType(mediaType: string): boolean {
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/webp" ||
    mediaType === "image/svg+xml" ||
    mediaType === "image/gif" ||
    mediaType === "image/avif"
  );
}

/**
 * Makes and stores an image's reduced versions unless the store has them.
 * Never throws: an image whose versions cannot be made is drawn from its
 * original. Returns whether versions were stored.
 */
export async function ensurePreviews(
  access: AssetAccess,
  id: AssetId,
  bytes: Uint8Array,
  facts: {
    readonly mediaType: string;
    readonly width?: number;
    readonly height?: number;
  },
  make: PreviewMaker = makeImagePreviews,
): Promise<boolean> {
  const { width, height, mediaType } = facts;
  if (!isImageType(mediaType) || width === undefined || height === undefined)
    return false;
  if (previewSizes(width, height).length === 0) return false;
  try {
    if ((await access.previewFacts(id)).length > 0) return false;
    const previews = await make(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType }),
      { width, height },
    );
    if (previews.length === 0) return false;
    await access.putPreviews(id, previews);
    return true;
  } catch {
    return false;
  }
}

/** The asset store for importers: stores bytes once and makes an image's reduced versions. */
export function sessionAssetStore(access: AssetAccess, make?: PreviewMaker): AssetStore {
  return {
    async put(bytes, facts) {
      const id = await access.putAsset(bytes);
      await ensurePreviews(access, id, bytes, facts, make);
      const info: AssetInfo = { ...facts, byteLength: bytes.length };
      return { id, info };
    },
    get: (id) => access.getAsset(id),
  };
}
