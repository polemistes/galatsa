// SPDX-License-Identifier: GPL-3.0-or-later

// Names and layout of a Galatsa file. Section 9.1 of
// docs/adr/0001-document-model-and-file-format.md.

import {
  Resolver,
  isRemoved,
  lookupFromRecord,
  referencedAssets,
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

/**
 * Size limits that the writer keeps and the reader's defaults allow, so that a
 * file the writer writes is always one the default reader opens (section 9.7).
 * Only document.json and ydoc.bin are compressed; everything else is stored and
 * costs a reader no memory beyond the file.
 */
export const MAX_DOCUMENT_SIZE = 256 * 1024 ** 2;
export const MAX_YDOC_SIZE = 256 * 1024 ** 2;

/** The only Yjs encoding version 1 files use. */
export const YDOC_ENCODING = "yjs-update-v1";

export interface Manifest {
  format: "galatsa";
  formatVersion: number;
  minReaderVersion: number;
  generator: string;
  ydoc?: { encoding: typeof YDOC_ENCODING; lineage: string };
  thumbnail?: { mediaType: "image/png" };
}

/**
 * True for entry names a reader of this version uses. Others are skipped unread
 * and are not written back: an entry that must survive being saved by an older
 * version cannot be added without raising the minimum reader version
 * (section 9.4).
 */
export function isKnownEntry(name: string): boolean {
  return (
    name === ENTRY.mimetype ||
    name === ENTRY.manifest ||
    name === ENTRY.document ||
    name === ENTRY.ydoc ||
    name === ENTRY.thumbnail ||
    (name.startsWith(ENTRY.assetsPrefix) && /^assets\/sha256-[0-9a-f]{64}$/.test(name))
  );
}

/**
 * Assets whose bytes belong in the file: every asset any record refers to,
 * removed records included, so that restoring after reopening finds them. Purging
 * (tidy up, export for sharing) is what drops assets of removed content
 * (section 8.3).
 */
export function assetsToWrite(snapshot: DocumentSnapshot): AssetId[] {
  return [...referencedAssets(snapshot)].sort();
}

/** Assets that content the user sees refers to (for "missing asset" warnings). */
export function assetsInUse(snapshot: DocumentSnapshot): AssetId[] {
  const r = new Resolver(lookupFromRecord(snapshot.elements));
  return [
    ...referencedAssets(snapshot, {
      skip: (kind, id) =>
        kind === "element"
          ? r.isGone(id)
          : kind === "stop"
            ? isRemoved(id, snapshot.stops[id]!)
            : isRemoved(id, snapshot.routes[id]!),
    }),
  ].sort();
}
