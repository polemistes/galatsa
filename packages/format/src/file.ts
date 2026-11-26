// SPDX-License-Identifier: GPL-3.0-or-later

// Writing Galatsa files, and reading them into a Y.Doc. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import { purgeSnapshot, type AssetId, type DocumentSnapshot } from "@galatsa/core";
import {
  ORIGIN,
  fromSnapshot,
  hiddenContent,
  lineageOf,
  roots,
  toSnapshot,
} from "@galatsa/core/ydoc";
import * as Y from "yjs";
import type { FileWarning } from "./errors.ts";
import { canonicalJson, jsonEqual, utf8 } from "./json.ts";
import {
  ENTRY,
  MIMETYPE,
  YDOC_ENCODING,
  assetsToWrite,
  type Manifest,
} from "./layout.ts";
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
  /**
   * An export for sharing (section 5.8): removed content is purged first, and no
   * ydoc.bin is written, so nothing deleted travels with the file.
   */
  forSharing?: boolean;
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
  let snapshot = doc ? toSnapshot(doc) : (source as DocumentSnapshot);
  if (options.forSharing) snapshot = purgeSnapshot(snapshot);
  const lineage = doc ? lineageOf(doc) : "";
  const includeYdoc =
    doc !== null &&
    !options.forSharing &&
    options.includeYdoc !== false &&
    lineage !== "";

  const manifest: Manifest = {
    format: "galatsa",
    formatVersion: snapshot.schemaVersion,
    minReaderVersion: snapshot.minReaderVersion,
    generator: options.generator ?? "Galatsa",
  };
  if (includeYdoc) manifest.ydoc = { encoding: YDOC_ENCODING, lineage };
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

function withoutVersions(snapshot: DocumentSnapshot): object {
  const { schemaVersion: _s, minReaderVersion: _m, ...rest } = snapshot;
  return rest;
}

/**
 * Decodes ydoc.bin and accepts it only if it holds exactly what document.json
 * holds (apart from version numbers that a compatible upgrade raised), nothing
 * the JSON form cannot carry, and the lineage the manifest names (section 9.3).
 */
function decodeYdoc(
  bytes: Uint8Array,
  lineage: string,
  snapshot: DocumentSnapshot,
): Y.Doc | null {
  try {
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, bytes);
    if (lineageOf(candidate) !== lineage) return null;
    if (hiddenContent(candidate).length > 0) return null;
    if (!jsonEqual(withoutVersions(toSnapshot(candidate)), withoutVersions(snapshot)))
      return null;
    const meta = roots(candidate).meta;
    if (
      meta.get("schemaVersion") !== snapshot.schemaVersion ||
      meta.get("minReaderVersion") !== snapshot.minReaderVersion
    ) {
      candidate.transact(() => {
        meta.set("schemaVersion", snapshot.schemaVersion);
        meta.set("minReaderVersion", snapshot.minReaderVersion);
      }, ORIGIN.load);
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Reads file bytes into a Y.Doc. Uses ydoc.bin when it is present, described by
 * the manifest, nothing was migrated, and it matches document.json exactly
 * (section 9.3); otherwise builds a document with a new lineage. Throws
 * FileFormatError if the file cannot be opened.
 */
export async function readGalatsaFile(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const read = await readGalatsaSnapshot(bytes, options);
  const warnings = [...read.warnings];
  let doc: Y.Doc | null = null;
  if (read.ydoc) {
    doc = decodeYdoc(read.ydoc.bytes, read.ydoc.lineage, read.snapshot);
    if (!doc) {
      warnings.push({
        code: "ydoc-discarded",
        message:
          "ydoc.bin did not match document.json; the document will not merge with other copies.",
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
