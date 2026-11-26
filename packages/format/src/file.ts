// SPDX-License-Identifier: GPL-3.0-or-later

// Writing Galatsa files, and reading them into a Y.Doc. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import type { AssetId, DocumentSnapshot } from "@galatsa/core";
import { fromSnapshot, toSnapshot } from "@galatsa/core/ydoc";
import * as Y from "yjs";
import type { FileWarning } from "./errors.ts";
import { canonicalJson, jsonEqual, utf8 } from "./json.ts";
import { ENTRY, MIMETYPE, assetsToWrite, type Manifest } from "./layout.ts";
import { readGalatsaSnapshot, type ReadOptions } from "./read.ts";
import { writeZip, type ZipEntryInput } from "./zip.ts";

/** Media types that are already compressed and are stored, not deflated. */
function isCompressed(mediaType: string): boolean {
  return (
    /^(image\/(png|jpeg|webp|gif|avif)|video\/|audio\/)/.test(mediaType) ||
    /zip|compressed|font\/woff2?/.test(mediaType)
  );
}

export interface WriteOptions {
  /** Name and version of the writing program, for diagnosis. */
  generator?: string;
  /** PNG preview, longest side at most 512 pixels. */
  thumbnail?: Uint8Array;
  /** Store ydoc.bin to keep merge identity (default true when given a Y.Doc). */
  includeYdoc?: boolean;
}

/** Where the writer gets asset bytes from. Missing bytes are simply left out. */
export type AssetSource = (id: AssetId) => Uint8Array | undefined;

/** Writes a document (a Y.Doc, or a snapshot without merge identity) to file bytes. */
export function writeGalatsaFile(
  source: Y.Doc | DocumentSnapshot,
  assets: AssetSource,
  options: WriteOptions = {},
): Uint8Array {
  const doc = source instanceof Y.Doc ? source : null;
  const snapshot = doc ? toSnapshot(doc) : (source as DocumentSnapshot);
  const includeYdoc = doc !== null && options.includeYdoc !== false;

  const manifest: Manifest = {
    format: "galatsa",
    formatVersion: snapshot.schemaVersion,
    generator: options.generator ?? "Galatsa",
  };
  if (includeYdoc) manifest.ydoc = { encoding: "yjs-update-v1" };
  if (options.thumbnail) manifest.thumbnail = { mediaType: "image/png" };

  const entries: ZipEntryInput[] = [
    { name: ENTRY.mimetype, data: utf8(MIMETYPE), compress: false },
    { name: ENTRY.manifest, data: utf8(canonicalJson(manifest)), compress: true },
    { name: ENTRY.document, data: utf8(canonicalJson(snapshot)), compress: true },
  ];
  if (doc && includeYdoc) {
    entries.push({ name: ENTRY.ydoc, data: Y.encodeStateAsUpdate(doc), compress: true });
  }
  for (const id of assetsToWrite(snapshot)) {
    const bytes = assets(id);
    if (!bytes) continue;
    const mediaType = snapshot.assets[id]?.mediaType ?? "application/octet-stream";
    entries.push({
      name: ENTRY.assetsPrefix + id,
      data: bytes,
      compress: !isCompressed(mediaType),
    });
  }
  if (options.thumbnail) {
    entries.push({ name: ENTRY.thumbnail, data: options.thumbnail, compress: false });
  }
  return writeZip(entries);
}

export interface ReadResult {
  doc: Y.Doc;
  /** The JSON form of `doc`. */
  snapshot: DocumentSnapshot;
  /** Verified asset bytes found in the file. */
  assets: Map<AssetId, Uint8Array>;
  thumbnail: Uint8Array | null;
  /** The format version the file was written with. */
  formatVersion: number;
  /** True if the Y.Doc came from ydoc.bin, so it still merges with other copies. */
  mergeIdentityKept: boolean;
  warnings: FileWarning[];
}

/**
 * Reads file bytes into a Y.Doc. Uses ydoc.bin when it is present, nothing was
 * migrated, and it holds exactly what document.json holds (section 9.3).
 * Throws FileFormatError if the file cannot be opened.
 */
export async function readGalatsaFile(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const read = await readGalatsaSnapshot(bytes, options);
  const warnings = [...read.warnings];
  let doc: Y.Doc | null = null;
  if (read.ydoc) {
    try {
      const candidate = new Y.Doc();
      Y.applyUpdate(candidate, read.ydoc);
      if (jsonEqual(toSnapshot(candidate), read.snapshot)) doc = candidate;
    } catch {
      doc = null;
    }
    if (!doc) {
      warnings.push({
        code: "ydoc-discarded",
        message:
          "ydoc.bin did not match document.json; the document will not merge with older copies.",
      });
    }
  }
  const mergeIdentityKept = doc !== null;
  if (!doc) doc = fromSnapshot(read.snapshot);
  return {
    doc,
    snapshot: toSnapshot(doc),
    assets: read.assets,
    thumbnail: read.thumbnail,
    formatVersion: read.formatVersion,
    mergeIdentityKept,
    warnings,
  };
}
