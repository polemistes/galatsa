// SPDX-License-Identifier: GPL-3.0-or-later

// Names and layout of a Galatsa file. Section 9.1 of
// docs/adr/0001-document-model-and-file-format.md.

import {
  Resolver,
  lookupFromRecord,
  type AssetId,
  type DocumentSnapshot,
} from "@galatsa/core";

export const MIMETYPE = "application/vnd.galatsa.presentation+zip";
export const FILE_EXTENSION = ".galatsa";

export const ENTRY = {
  mimetype: "mimetype",
  manifest: "manifest.json",
  document: "document.json",
  ydoc: "ydoc.bin",
  thumbnail: "thumbnail.png",
  assetsPrefix: "assets/",
} as const;

export interface Manifest {
  format: "galatsa";
  formatVersion: number;
  generator: string;
  ydoc?: { encoding: "yjs-update-v1" };
  thumbnail?: { mediaType: "image/png" };
}

/**
 * Assets whose bytes belong in the file: those listed by elements that are not
 * deleted (section 8.3).
 */
export function assetsToWrite(snapshot: DocumentSnapshot): AssetId[] {
  const resolver = new Resolver(lookupFromRecord(snapshot.elements));
  const ids = new Set<AssetId>();
  for (const [id, element] of Object.entries(snapshot.elements)) {
    if (resolver.isDeleted(id)) continue;
    for (const asset of element.assets) ids.add(asset);
  }
  return [...ids].sort();
}
