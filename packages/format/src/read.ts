// SPDX-License-Identifier: GPL-3.0-or-later

// Reading a Galatsa file into the JSON form, without Yjs (the player needs only
// this). Section 9 of docs/adr/0001-document-model-and-file-format.md.

import { validateSnapshot, type AssetId, type DocumentSnapshot } from "@galatsa/core";
import { FileFormatError, type FileWarning } from "./errors.ts";
import { assetIdOf, isAssetId } from "./hash.ts";
import { fromUtf8 } from "./json.ts";
import { ENTRY, MIMETYPE, YDOC_ENCODING, assetsInUse, isKnownEntry } from "./layout.ts";
import {
  MIGRATIONS,
  migrate,
  type MigrationRegistry,
  type RawFile,
} from "./migrations.ts";
import { DEFAULT_ZIP_LIMITS, readZip, type ZipLimits } from "./zip.ts";

export interface ReadOptions {
  /** Format migrations (tests inject their own). */
  migrations?: MigrationRegistry;
  limits?: ZipLimits;
  /** Largest ydoc.bin accepted; a larger one is ignored (default 256 MiB). */
  maxYdocSize?: number;
}

export interface SnapshotReadResult {
  /** The document from document.json, migrated and validated. */
  snapshot: DocumentSnapshot;
  /** Verified asset bytes found in the file. */
  assets: Map<AssetId, Uint8Array>;
  thumbnail: Uint8Array | null;
  /** The format version the file was written with. */
  formatVersion: number;
  /**
   * ydoc.bin and the lineage the manifest gives for it, unless it is missing, of
   * an unknown encoding, too large, or made obsolete by a migration.
   */
  ydoc: { bytes: Uint8Array; lineage: string } | null;
  /** True if a format migration changed the document. */
  migrated: boolean;
  warnings: FileWarning[];
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new FileFormatError(
      "damaged",
      `The file is damaged: ${name} is not valid JSON.`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_GALATSA = "The file is a zip archive, but not a Galatsa file.";

/**
 * Reads file bytes into the JSON form. Throws FileFormatError if the file cannot
 * be opened; never any other error for bad input.
 */
export async function readGalatsaSnapshot(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<SnapshotReadResult> {
  try {
    return await readUnchecked(bytes, options);
  } catch (error) {
    if (error instanceof FileFormatError) throw error;
    throw new FileFormatError("damaged", `The file could not be read: ${String(error)}`);
  }
}

async function readUnchecked(
  bytes: Uint8Array,
  options: ReadOptions,
): Promise<SnapshotReadResult> {
  const registry = options.migrations ?? MIGRATIONS;
  const entries = readZip(bytes, options.limits ?? DEFAULT_ZIP_LIMITS, isKnownEntry);
  const warnings: FileWarning[] = [];

  const mimetype = entries.get(ENTRY.mimetype);
  if (mimetype && fromUtf8(mimetype) !== MIMETYPE) {
    throw new FileFormatError("not-galatsa", NOT_GALATSA);
  }
  const manifestBytes = entries.get(ENTRY.manifest);
  if (!manifestBytes) {
    if (mimetype) {
      throw new FileFormatError(
        "damaged",
        "The file is damaged: manifest.json is missing.",
      );
    }
    throw new FileFormatError("not-galatsa", NOT_GALATSA);
  }
  const manifest = parseJson(manifestBytes, ENTRY.manifest);
  if (!isObject(manifest) || manifest.format !== "galatsa") {
    throw new FileFormatError("not-galatsa", NOT_GALATSA);
  }
  const version = manifest.formatVersion;
  const minReader = manifest.minReaderVersion;
  if (
    !Number.isInteger(version) ||
    (version as number) < 1 ||
    !Number.isInteger(minReader) ||
    (minReader as number) < 1 ||
    (minReader as number) > (version as number)
  ) {
    throw new FileFormatError(
      "damaged",
      "The file is damaged: the format version is invalid.",
    );
  }
  const formatVersion = version as number;
  if ((minReader as number) > registry.current) {
    throw new FileFormatError(
      "newer-version",
      `The file was made with a newer version of Galatsa (format ${formatVersion}, readable from version ${String(minReader)}; this version is ${registry.current}).`,
    );
  }
  const documentBytes = entries.get(ENTRY.document);
  if (!documentBytes) {
    throw new FileFormatError(
      "damaged",
      "The file is damaged: document.json is missing.",
    );
  }

  let raw: RawFile = { manifest, document: parseJson(documentBytes, ENTRY.document) };
  let migrated = false;
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

  const problems = validateSnapshot(raw.document);
  if (problems.length === 0) {
    const doc = raw.document as DocumentSnapshot;
    if (doc.schemaVersion !== raw.manifest.formatVersion) {
      problems.push("schemaVersion: does not match the manifest");
    }
    if (doc.minReaderVersion !== raw.manifest.minReaderVersion && !migrated) {
      problems.push("minReaderVersion: does not match the manifest");
    }
  }
  if (problems.length > 0) {
    throw new FileFormatError(
      "invalid-document",
      `The document in the file is invalid:\n${problems.slice(0, 20).join("\n")}`,
    );
  }
  const snapshot = raw.document as DocumentSnapshot;

  const assets = new Map<AssetId, Uint8Array>();
  for (const [name, data] of entries) {
    if (!name.startsWith(ENTRY.assetsPrefix)) continue;
    const id = name.slice(ENTRY.assetsPrefix.length);
    if (!isAssetId(id)) continue;
    if ((await assetIdOf(data)) !== id) {
      warnings.push({
        code: "asset-damaged",
        message: `The asset ${id} is damaged and was ignored.`,
      });
      continue;
    }
    assets.set(id, data);
  }
  for (const id of assetsInUse(snapshot)) {
    if (!assets.has(id) && !snapshot.assets[id]?.external) {
      warnings.push({
        code: "asset-missing",
        message: `The asset ${id} is not in the file.`,
      });
    }
  }

  const thumbnail = entries.get(ENTRY.thumbnail) ?? null;
  if (isObject(manifest.thumbnail) && !thumbnail) {
    warnings.push({ code: "thumbnail-missing", message: "The thumbnail is missing." });
  }

  // ydoc.bin is used only as the manifest describes it (section 9.3).
  let ydoc: SnapshotReadResult["ydoc"] = null;
  const ydocBytes = entries.get(ENTRY.ydoc);
  const described = isObject(manifest.ydoc) ? manifest.ydoc : null;
  if (ydocBytes && !migrated) {
    const maxYdoc = options.maxYdocSize ?? 256 * 1024 ** 2;
    if (
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
          "ydoc.bin is not described by the manifest, uses an unknown encoding, or is too large; the document will not merge with other copies.",
      });
    }
  }

  return { snapshot, assets, thumbnail, formatVersion, ydoc, migrated, warnings };
}
