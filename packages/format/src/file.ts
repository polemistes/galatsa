// SPDX-License-Identifier: GPL-3.0-or-later

// Writing Galatsa files, and reading them into a Y.Doc. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import {
  InvalidDocumentError,
  SCHEMA_VERSION,
  purgeSnapshot,
  readSnapshot,
  type AssetId,
  type DocumentSnapshot,
} from "@galatsa/core";
import {
  ORIGIN,
  fromSnapshot,
  inspectDocument,
  lineageOf,
  neededVersion,
  raiseVersions,
  savedState,
  toSnapshot,
  trackWork,
} from "@galatsa/core/ydoc";
import * as Y from "yjs";
import { FileFormatError, type FileWarning } from "./errors.ts";
import { canonicalJson, jsonEqual, utf8 } from "./json.ts";
import {
  ENTRY,
  MAX_DOCUMENT_SIZE,
  MAX_YDOC_SIZE,
  MIMETYPE,
  YDOC_ENCODING,
  assetsToWrite,
  type Manifest,
} from "./layout.ts";
import { newerVersion, readAssets, readParts, type ReadOptions } from "./parts.ts";
import { writeZip, type ZipEntryInput } from "./zip.ts";

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
  /**
   * Size limits, for tests. The defaults are what the default reader opens
   * (section 9.7): 256 MiB each for document.json and ydoc.bin, 4 GiB in all.
   */
  limits?: { maxDocumentSize?: number; maxYdocSize?: number; maxFileSize?: number };
}

export interface WriteResult {
  bytes: Uint8Array;
  /** "ydoc-not-written" if the Yjs state could not be stored, or is too large to be. */
  warnings: FileWarning[];
}

/** Where the writer gets asset bytes from. Missing bytes are simply left out. */
export type AssetSource = (id: AssetId) => Uint8Array | undefined;

/**
 * Writes a document (a Y.Doc, or a snapshot without merge identity) to file
 * bytes. What it writes can always be read back: the document goes through the
 * same grammar the reader uses, and the sizes are within what the default
 * reader accepts. Writing a Y.Doc never fails because of what is in it.
 *
 * Throws InvalidDocumentError for a snapshot that is not valid, and
 * FileFormatError for a document that needs a newer version of the format than
 * this code knows ("newer-version": saving it here would lose content), or that
 * does not fit in a file ("too-large": the document itself over 256 MiB, or the
 * file over 4 GiB, which needs zip64 and so a later version of the format).
 */
export function writeGalatsaFile(
  source: Y.Doc | DocumentSnapshot,
  assets: AssetSource,
  options: WriteOptions = {},
): WriteResult {
  const doc = source instanceof Y.Doc ? source : null;
  let snapshot: DocumentSnapshot;
  if (doc) snapshot = toSnapshot(doc);
  else {
    const read = readSnapshot(source);
    if (!read.snapshot || read.problems.length > 0) {
      throw new InvalidDocumentError("document", read.problems);
    }
    snapshot = read.snapshot;
  }
  if (snapshot.minReaderVersion > SCHEMA_VERSION) {
    throw newerVersion(snapshot.minReaderVersion, SCHEMA_VERSION);
  }
  if (options.forSharing) snapshot = purgeSnapshot(snapshot);
  const warnings: FileWarning[] = [];
  const lineage = doc ? lineageOf(doc) : "";
  let ydoc: Uint8Array | null = null;
  if (doc !== null && !options.forSharing && options.includeYdoc !== false) {
    const notWritten = (why: string) =>
      warnings.push({
        code: "ydoc-not-written",
        message: `The state for merging could not be stored (${why}); the file will not merge with other copies.`,
      });
    try {
      if (lineage === "") throw new Error("the document has no lineage");
      // Without the content of what was deleted (text typed and removed, for
      // example), which the running program keeps for undo.
      ydoc = savedState(doc);
      if (ydoc.length > (options.limits?.maxYdocSize ?? MAX_YDOC_SIZE)) {
        ydoc = null;
        notWritten("it is larger than a reader accepts");
      }
    } catch (error) {
      notWritten(String(error));
    }
  }

  const manifest: Manifest = {
    format: "galatsa",
    formatVersion: snapshot.schemaVersion,
    minReaderVersion: snapshot.minReaderVersion,
    generator: options.generator ?? "Galatsa",
  };
  if (ydoc) manifest.ydoc = { encoding: YDOC_ENCODING, lineage };
  if (options.thumbnail) manifest.thumbnail = { mediaType: "image/png" };

  const document = utf8(canonicalJson(snapshot));
  if (document.length > (options.limits?.maxDocumentSize ?? MAX_DOCUMENT_SIZE)) {
    throw new FileFormatError(
      "too-large",
      "The file cannot be written: the document itself is larger than a reader accepts.",
    );
  }
  // Only the document and the Yjs state are compressed. Assets are stored as
  // they are: most are compressed already, and a reader then needs no memory
  // for them beyond the file, whatever their type and size.
  const entries: ZipEntryInput[] = [
    { name: ENTRY.mimetype, data: utf8(MIMETYPE), compress: false },
    { name: ENTRY.manifest, data: utf8(canonicalJson(manifest)), compress: false },
    { name: ENTRY.document, data: document, compress: true },
  ];
  if (ydoc) entries.push({ name: ENTRY.ydoc, data: ydoc, compress: true });
  for (const id of assetsToWrite(snapshot)) {
    if (Object.hasOwn(snapshot.assets, id) && snapshot.assets[id]?.external) continue;
    const bytes = assets(id);
    if (bytes) entries.push({ name: ENTRY.assetsPrefix + id, data: bytes, compress: false });
  }
  if (options.thumbnail) {
    entries.push({ name: ENTRY.thumbnail, data: options.thumbnail, compress: false });
  }
  return { bytes: writeZip(entries, options.limits?.maxFileSize), warnings };
}

export interface ReadResult {
  /** The document, with work tracking attached (ready to edit). */
  doc: Y.Doc;
  /** The JSON form of `doc`. */
  snapshot: DocumentSnapshot;
  /** Verified asset bytes found in the file (views of the file bytes). */
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

/** Decodes ydoc.bin; null unless it is complete and has the lineage the manifest names. */
function decodeYdoc(bytes: Uint8Array, lineage: string): Y.Doc | null {
  try {
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, bytes, ORIGIN.load);
    if (lineageOf(candidate) !== lineage) return null;
    // Updates that wait for others that are not there: the state is incomplete.
    if (candidate.store.pendingStructs !== null || candidate.store.pendingDs !== null)
      return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Reads file bytes into a Y.Doc.
 *
 * - If ydoc.bin is present, described by the manifest, complete, and reads as
 *   the same document as document.json, it is used, so the document still
 *   merges with other copies (section 9.3).
 * - If document.json cannot be used at all but ydoc.bin can, the document is
 *   recovered from ydoc.bin.
 * - Otherwise the document is built from document.json with a new lineage.
 *
 * Throws FileFormatError if the file cannot be opened.
 */
export async function readGalatsaFile(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const parts = readParts(bytes, options);
  const warnings = [...parts.warnings];
  let doc: Y.Doc | null = null;
  let mergeIdentityKept = false;
  let snapshot = parts.snapshot;
  try {
    if (parts.ydoc) {
      const candidate = decodeYdoc(parts.ydoc.bytes, parts.ydoc.lineage);
      // What the Yjs state itself says it needs counts, whatever the manifest says.
      if (candidate && neededVersion(candidate) > parts.readerVersion) {
        throw newerVersion(neededVersion(candidate), parts.readerVersion);
      }
      const inspection = candidate ? inspectDocument(candidate) : null;
      if (candidate && inspection && snapshot) {
        if (jsonEqual(withoutVersions(inspection.snapshot), withoutVersions(snapshot))) {
          doc = candidate;
          mergeIdentityKept = true;
          // A compatible upgrade may have raised the versions; they never go down.
          raiseVersions(candidate, snapshot, ORIGIN.load);
        }
      } else if (candidate && inspection) {
        // document.json is unusable: the Yjs state is all there is.
        doc = candidate;
        mergeIdentityKept = true;
        snapshot = inspection.snapshot;
        warnings.push({
          code: "document-recovered",
          message: `The document was recovered from the editing history, because ${parts.documentProblem ?? "document.json is unusable"}.`,
        });
      }
      if (doc && inspection && inspection.problems.length > 0) {
        warnings.push({
          code: "content-quarantined",
          message: `The editing history holds ${inspection.problems.length} thing(s) this version does not show. They are kept; tidy up removes them.`,
          details: inspection.problems,
        });
      }
      if (!doc) {
        warnings.push({
          code: "ydoc-discarded",
          message:
            "ydoc.bin is incomplete or does not match document.json; the document will not merge with other copies.",
        });
      }
    }
    if (!doc) {
      if (!snapshot) {
        throw new FileFormatError(
          "damaged",
          `The file is damaged: ${parts.documentProblem ?? "document.json is unusable"}.`,
        );
      }
      doc = fromSnapshot(snapshot);
    }
  } catch (error) {
    if (error instanceof FileFormatError) throw error;
    throw new FileFormatError("damaged", `The file could not be read: ${String(error)}`);
  }
  trackWork(doc);
  const result = toSnapshot(doc);
  return {
    doc,
    snapshot: result,
    assets: await readAssets(parts, result, warnings),
    thumbnail: parts.thumbnail,
    formatVersion: parts.formatVersion,
    mergeIdentityKept,
    warnings,
  };
}
