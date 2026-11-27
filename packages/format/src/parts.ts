// SPDX-License-Identifier: GPL-3.0-or-later

// The parts of a Galatsa file, read without Yjs: the archive, the manifest and
// its versions, document.json through the grammar, the assets. Shared by the
// reader for the player (read.ts) and the reader into a Y.Doc (file.ts). Not
// part of the package's public entries. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import { readSnapshot, type AssetId, type DocumentSnapshot } from "@galatsa/core";
import { FileFormatError, type FileWarning } from "./errors.ts";
import { assetIdOf, isAssetId } from "./hash.ts";
import { fromUtf8 } from "./json.ts";
import {
  ENTRY,
  MAX_YDOC_SIZE,
  MIMETYPE,
  YDOC_ENCODING,
  assetsInUse,
  isKnownEntry,
} from "./layout.ts";
import {
  MIGRATIONS,
  migrate,
  type MigrationRegistry,
  type RawFile,
} from "./migrations.ts";
import { previewsFromEntries, type AssetPreview } from "./previews.ts";
import { DEFAULT_ZIP_LIMITS, openZip, type ZipLimits } from "./zip.ts";

export interface ReadOptions {
  /** Format migrations (tests inject their own). */
  migrations?: MigrationRegistry;
  limits?: ZipLimits;
  /** Largest ydoc.bin accepted; a larger one is ignored (default 256 MiB). */
  maxYdocSize?: number;
}

export interface SnapshotReadResult {
  /** The document from document.json, migrated and read by the grammar. Valid. */
  snapshot: DocumentSnapshot;
  /**
   * Verified asset bytes found in the file. Stored assets are views of the file
   * bytes passed in: they stay valid as long as those are not changed.
   */
  assets: Map<AssetId, Uint8Array>;
  /**
   * Reduced versions of image assets, smallest first, as views of the file
   * bytes (docs/adr/0012). A cache: empty for files that have none.
   */
  previews: Map<AssetId, AssetPreview[]>;
  thumbnail: Uint8Array | null;
  /** The format version the file was written with. */
  formatVersion: number;
  /**
   * ydoc.bin and the lineage the manifest gives for it, unless it is missing,
   * damaged, of an unknown encoding, too large, or made obsolete by a migration.
   */
  ydoc: { bytes: Uint8Array; lineage: string } | null;
  /** True if a format migration changed the document. */
  migrated: boolean;
  warnings: FileWarning[];
}

/** What a file holds, before deciding where the document comes from. */
export interface FileParts {
  /** The document from document.json, or null if that entry cannot be used. */
  snapshot: DocumentSnapshot | null;
  /** Why document.json cannot be used, if it cannot. */
  documentProblem: string | null;
  entries: Map<string, Uint8Array>;
  damaged: Set<string>;
  thumbnail: Uint8Array | null;
  formatVersion: number;
  minReaderVersion: number;
  /** The version this reader reads up to. */
  readerVersion: number;
  ydoc: { bytes: Uint8Array; lineage: string } | null;
  migrated: boolean;
  warnings: FileWarning[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_GALATSA = "The file is a zip archive, but not a Galatsa file.";

function damaged(detail: string): FileFormatError {
  return new FileFormatError("damaged", `The file is damaged: ${detail}.`);
}

/** Raised for a file that needs a newer reader than this one. */
export function newerVersion(needed: number, reader: number): FileFormatError {
  return new FileFormatError(
    "newer-version",
    `The file needs a newer version of Galatsa (format version ${needed}; this version reads up to ${reader}).`,
  );
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FileFormatError) throw error;
    throw new FileFormatError("damaged", `The file could not be read: ${String(error)}`);
  }
}

/**
 * Opens the archive and reads everything except ydoc.bin's content. Throws
 * FileFormatError only if the file cannot be a readable Galatsa file at all: not
 * an archive, a broken archive structure, no usable manifest, or a newer format.
 * A document.json that cannot be used is reported, not thrown, so that the
 * caller can fall back on ydoc.bin.
 */
export function readParts(bytes: Uint8Array, options: ReadOptions = {}): FileParts {
  return wrap(() => {
    const registry = options.migrations ?? MIGRATIONS;
    const { entries, damaged: broken } = openZip(
      bytes,
      options.limits ?? DEFAULT_ZIP_LIMITS,
      isKnownEntry,
    );
    const warnings: FileWarning[] = [];

    const mimetype = entries.get(ENTRY.mimetype);
    if (mimetype && fromUtf8(mimetype) !== MIMETYPE) {
      throw new FileFormatError("not-galatsa", NOT_GALATSA);
    }
    const manifestBytes = entries.get(ENTRY.manifest);
    if (!manifestBytes) {
      if (mimetype || broken.has(ENTRY.manifest))
        throw damaged("manifest.json is missing or unreadable");
      throw new FileFormatError("not-galatsa", NOT_GALATSA);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(fromUtf8(manifestBytes));
    } catch {
      throw damaged("manifest.json is not valid JSON");
    }
    if (!isObject(manifest) || manifest.format !== "galatsa") {
      throw new FileFormatError("not-galatsa", NOT_GALATSA);
    }
    const version = manifest.formatVersion;
    const minReader = manifest.minReaderVersion;
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      !Number.isSafeInteger(minReader) ||
      (minReader as number) < 1 ||
      (minReader as number) > (version as number)
    ) {
      throw damaged("the format version is invalid");
    }
    const formatVersion = version as number;
    let minReaderVersion = minReader as number;
    if (minReaderVersion > registry.current) {
      throw newerVersion(minReaderVersion, registry.current);
    }

    let snapshot: DocumentSnapshot | null = null;
    let documentProblem: string | null = null;
    let migrated = false;
    const documentBytes = entries.get(ENTRY.document);
    let parsed: unknown;
    if (!documentBytes) {
      documentProblem = broken.has(ENTRY.document)
        ? "document.json fails its checksum"
        : "document.json is missing";
    } else {
      try {
        parsed = JSON.parse(fromUtf8(documentBytes));
        if (!isObject(parsed)) documentProblem = "document.json is not a document";
      } catch {
        documentProblem = "document.json is not valid JSON";
      }
    }
    if (documentProblem === null) {
      let raw: RawFile = { manifest, document: parsed };
      if (formatVersion < registry.current) {
        const result = migrate(raw, formatVersion, registry);
        raw = result.file;
        migrated = result.changed;
        if (migrated) {
          warnings.push({
            code: "migrated",
            message: `The file was upgraded from format version ${formatVersion} to ${registry.current}.`,
          });
        }
      }
      const read = readSnapshot(raw.document);
      // Without its tables the entry is not a document at all; single records
      // and values that do not fit are a different matter (they are quarantined).
      const tables = ["settings", "elements", "stops", "routes", "assets"];
      const document = raw.document;
      if (
        !read.snapshot ||
        !isObject(document) ||
        !tables.every((t) => isObject(document[t]))
      ) {
        documentProblem = "document.json is not a document";
      } else {
        snapshot = read.snapshot;
        const details = [...read.problems];
        // The manifest's versions are the ones the file was accepted on; a
        // file older than this reader is now at this reader's version.
        const target = Math.max(formatVersion, registry.current);
        if (snapshot.schemaVersion !== target) {
          details.push("schemaVersion: does not match the manifest, which is used");
        }
        minReaderVersion = Math.max(minReaderVersion, snapshot.minReaderVersion);
        if (minReaderVersion > registry.current) {
          throw newerVersion(minReaderVersion, registry.current);
        }
        snapshot.schemaVersion = target;
        snapshot.minReaderVersion = minReaderVersion;
        if (details.length > 0) {
          warnings.push({
            code: "content-quarantined",
            message: `${read.problemCount} part(s) of the document did not fit the format and were read as defaults, left out or kept as unsupported values.`,
            details,
          });
        }
      }
    }

    const thumbnail = entries.get(ENTRY.thumbnail) ?? null;
    if (isObject(manifest.thumbnail) && !thumbnail) {
      warnings.push({ code: "thumbnail-missing", message: "The thumbnail is missing." });
    }

    // ydoc.bin is used only as the manifest describes it (section 9.3).
    let ydoc: FileParts["ydoc"] = null;
    const ydocBytes = entries.get(ENTRY.ydoc);
    const described = isObject(manifest.ydoc) ? manifest.ydoc : null;
    if ((ydocBytes || broken.has(ENTRY.ydoc)) && !migrated) {
      const maxYdoc = options.maxYdocSize ?? MAX_YDOC_SIZE;
      if (
        ydocBytes &&
        described?.encoding === YDOC_ENCODING &&
        typeof described.lineage === "string" &&
        described.lineage.length > 0 &&
        ydocBytes.length <= maxYdoc
      ) {
        ydoc = { bytes: ydocBytes, lineage: described.lineage };
      } else {
        warnings.push({
          code: "ydoc-discarded",
          message:
            "ydoc.bin is damaged, not described by the manifest, uses an unknown encoding, or is too large; the document will not merge with other copies.",
        });
      }
    }

    return {
      snapshot,
      documentProblem,
      entries,
      damaged: broken,
      thumbnail,
      formatVersion,
      minReaderVersion,
      readerVersion: registry.current,
      ydoc,
      migrated,
      warnings,
    };
  });
}

/** Verifies the assets in the file against their ids and reports what is missing. */
export async function readAssets(
  parts: FileParts,
  snapshot: DocumentSnapshot,
  warnings: FileWarning[],
): Promise<Map<AssetId, Uint8Array>> {
  const assets = new Map<AssetId, Uint8Array>();
  const report = (id: string) =>
    warnings.push({
      code: "asset-damaged",
      message: `The asset ${id} is damaged and was ignored.`,
    });
  for (const name of parts.damaged) {
    if (name.startsWith(ENTRY.assetsPrefix))
      report(name.slice(ENTRY.assetsPrefix.length));
  }
  for (const [name, data] of parts.entries) {
    if (!name.startsWith(ENTRY.assetsPrefix)) continue;
    const id = name.slice(ENTRY.assetsPrefix.length);
    if (!isAssetId(id)) continue;
    if ((await assetIdOf(data)) !== id) {
      report(id);
      continue;
    }
    assets.set(id, data);
  }
  for (const id of assetsInUse(snapshot)) {
    const described = Object.hasOwn(snapshot.assets, id);
    if (!described) {
      warnings.push({
        code: "asset-undescribed",
        message: `The document refers to the asset ${id} but does not describe it.`,
      });
    }
    if (!assets.has(id) && !(described && snapshot.assets[id]?.external)) {
      warnings.push({
        code: "asset-missing",
        message: `The asset ${id} is not in the file.`,
      });
    }
  }
  return assets;
}

/**
 * Reads file bytes into the JSON form. Throws FileFormatError if the file cannot
 * be opened; never any other error for bad input. Content of document.json that
 * does not fit the format never makes the file unreadable: it is read as
 * defaults, left out or kept as unsupported values, and reported as a warning.
 */
export async function readGalatsaSnapshot(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<SnapshotReadResult> {
  const parts = readParts(bytes, options);
  if (!parts.snapshot)
    throw damaged(parts.documentProblem ?? "document.json is unusable");
  const warnings = [...parts.warnings];
  const assets = await readAssets(parts, parts.snapshot, warnings);
  return {
    snapshot: parts.snapshot,
    assets,
    previews: previewsFromEntries(parts.entries),
    thumbnail: parts.thumbnail,
    formatVersion: parts.formatVersion,
    ydoc: parts.ydoc,
    migrated: parts.migrated,
    warnings,
  };
}
