// SPDX-License-Identifier: GPL-3.0-or-later

// Reduced versions of image assets in the store, beside the asset bytes, one
// key per version (docs/adr/0012-images-and-assets.md):
//
//   doc/<slot>/p/<asset id>/<width>x<height>.<webp|png|jpg>
//
// They are a cache: written once each (the first stored version of a size
// stays), never checked against the asset, and gone with the slot.

import type { AssetId } from "@galatsa/core";
import {
  normalizePreviews,
  parsePreviewEntry,
  previewEntryName,
  type AssetPreview,
  type PreviewFacts,
} from "@galatsa/format";
import type { StorageBackend } from "./backend.ts";
import { keys } from "./layout.ts";

/** The key of one preview of an asset in a slot. */
export function previewKey(slot: string, id: AssetId, facts: PreviewFacts): string {
  // The archive's entry name, under the slot's preview folder.
  return keys.previews(slot) + previewEntryName(id, facts).slice("previews/".length);
}

/** The previews of an asset the store holds, smallest first, without their bytes. */
export async function storedPreviewFacts(
  backend: StorageBackend,
  slot: string,
  id: AssetId,
): Promise<PreviewFacts[]> {
  const prefix = `${keys.previews(slot)}${id}/`;
  const facts: PreviewFacts[] = [];
  for (const key of await backend.list(prefix)) {
    const parsed = parsePreviewEntry(`previews/${key.slice(keys.previews(slot).length)}`);
    if (parsed !== null && parsed.asset === id) facts.push(parsed.facts);
  }
  facts.sort((a, b) => a.width - b.width || a.height - b.height);
  return facts;
}

/**
 * Stores previews. A size already stored keeps its bytes, unless `replace`
 * (versions that would not decode, made again). Throws if the store fails.
 */
export async function storePreviews(
  backend: StorageBackend,
  slot: string,
  id: AssetId,
  previews: readonly AssetPreview[],
  replace = false,
): Promise<void> {
  for (const preview of normalizePreviews(previews)) {
    const key = previewKey(slot, id, preview);
    if (replace) await backend.write(key, preview.bytes);
    else await backend.create(key, preview.bytes);
  }
}

/** Reads every stored preview of an asset, smallest first. */
export async function readPreviews(
  backend: StorageBackend,
  slot: string,
  id: AssetId,
): Promise<AssetPreview[]> {
  const out: AssetPreview[] = [];
  for (const facts of await storedPreviewFacts(backend, slot, id)) {
    const bytes = await backend.read(previewKey(slot, id, facts));
    if (bytes !== undefined && bytes.length > 0) out.push({ ...facts, bytes });
  }
  return normalizePreviews(out);
}
