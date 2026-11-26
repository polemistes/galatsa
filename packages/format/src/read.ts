// SPDX-License-Identifier: GPL-3.0-or-later

// Reading a Galatsa file into the JSON form, without Yjs (the player needs only
// this). Section 9 of docs/adr/0001-document-model-and-file-format.md.

import { validateSnapshot, type AssetId, type DocumentSnapshot } from "@galatsa/core";
import { FileFormatError, type FileWarning } from "./errors.ts";
import { assetIdOf, isAssetId } from "./hash.ts";
import { fromUtf8 } from "./json.ts";
import { ENTRY, MIMETYPE, assetsToWrite } from "./layout.ts";
import {
  MIGRATIONS,
  migrate,
  type MigrationRegistry,
  type RawFile,
} from "./migrations.ts";
import { DEFAULT_ZIP_LIMITS, readZip, type ZipLimits } from "./zip.ts";

/** Upgrades an element's data on load (provided by the extension registry). */
export type ElementMigrator = (
  element: DocumentSnapshot["elements"][string],
) => DocumentSnapshot["elements"][string] | undefined;

export interface ReadOptions {
  /** Format migrations (tests inject their own). */
  migrations?: MigrationRegistry;
  /** Element data migrations; return undefined to leave an element unchanged. */
  migrateElement?: ElementMigrator;
  limits?: ZipLimits;
}

export interface SnapshotReadResult {
  /** The document from document.json, migrated and validated. */
  snapshot: DocumentSnapshot;
  /** Verified asset bytes found in the file. */
  assets: Map<AssetId, Uint8Array>;
  thumbnail: Uint8Array | null;
  /** The format version the file was written with. */
  formatVersion: number;
  /** ydoc.bin, unless it is missing or a migration made it obsolete. */
  ydoc: Uint8Array | null;
  /** True if a format or element migration changed the document. */
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
 * be opened.
 */
export async function readGalatsaSnapshot(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<SnapshotReadResult> {
  const registry = options.migrations ?? MIGRATIONS;
  const entries = readZip(bytes, options.limits ?? DEFAULT_ZIP_LIMITS);
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
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new FileFormatError(
      "damaged",
      "The file is damaged: the format version is invalid.",
    );
  }
  const formatVersion = version as number;
  if (formatVersion > registry.current) {
    throw new FileFormatError(
      "newer-version",
      `The file was made with a newer version of Galatsa (format ${formatVersion}; this version reads up to ${registry.current}).`,
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
  const formatMigrated = formatVersion < registry.current;
  if (formatMigrated) {
    raw = migrate(raw, formatVersion, registry);
    warnings.push({
      code: "migrated",
      message: `The file was upgraded from format version ${formatVersion} to ${registry.current}.`,
    });
  }

  const problems = validateSnapshot(raw.document);
  if (
    problems.length === 0 &&
    (raw.document as DocumentSnapshot).schemaVersion !== registry.current
  ) {
    problems.push(`schemaVersion: expected ${registry.current}`);
  }
  if (problems.length > 0) {
    throw new FileFormatError(
      "invalid-document",
      `The document in the file is invalid:\n${problems.slice(0, 20).join("\n")}`,
    );
  }
  let snapshot = raw.document as DocumentSnapshot;

  let elementsMigrated = false;
  if (options.migrateElement) {
    const elements: DocumentSnapshot["elements"] = {};
    for (const [id, element] of Object.entries(snapshot.elements)) {
      const upgraded = options.migrateElement(element);
      if (upgraded !== undefined) elementsMigrated = true;
      elements[id] = upgraded ?? element;
    }
    if (elementsMigrated) {
      snapshot = { ...snapshot, elements };
      const again = validateSnapshot(snapshot);
      if (again.length > 0) {
        throw new FileFormatError(
          "invalid-document",
          `An element migration produced invalid data:\n${again.slice(0, 20).join("\n")}`,
        );
      }
    }
  }

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
  for (const id of assetsToWrite(snapshot)) {
    if (!assets.has(id)) {
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

  const migrated = formatMigrated || elementsMigrated;
  return {
    snapshot,
    assets,
    thumbnail,
    formatVersion,
    ydoc: migrated ? null : (entries.get(ENTRY.ydoc) ?? null),
    migrated,
    warnings,
  };
}
