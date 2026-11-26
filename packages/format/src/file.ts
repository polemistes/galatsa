// SPDX-License-Identifier: GPL-3.0-or-later

// Reading and writing Galatsa files. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import {
  Resolver,
  lookupFromRecord,
  validateSnapshot,
  type AssetId,
  type DocumentSnapshot,
} from "@galatsa/core";
import { fromSnapshot, toSnapshot } from "@galatsa/core/ydoc";
import * as Y from "yjs";
import { FileFormatError, type FileWarning } from "./errors.ts";
import { assetIdOf, isAssetId } from "./hash.ts";
import { canonicalJson, fromUtf8, jsonEqual, utf8 } from "./json.ts";
import {
  MIGRATIONS,
  migrate,
  type MigrationRegistry,
  type RawFile,
} from "./migrations.ts";
import {
  DEFAULT_ZIP_LIMITS,
  readZip,
  writeZip,
  type ZipEntryInput,
  type ZipLimits,
} from "./zip.ts";

export const MIMETYPE = "application/vnd.galatsa.presentation+zip";
export const FILE_EXTENSION = ".galatsa";

const ENTRY = {
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

/** Media types that are already compressed and are stored, not deflated. */
function isCompressed(mediaType: string): boolean {
  return (
    /^(image\/(png|jpeg|webp|gif|avif)|video\/|audio\/)/.test(mediaType) ||
    /zip|compressed|font\/woff2?/.test(mediaType)
  );
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

export interface ReadResult {
  doc: Y.Doc;
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

/** Reads file bytes. Throws FileFormatError if the file cannot be opened. */
export async function readGalatsaFile(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const registry = options.migrations ?? MIGRATIONS;
  const entries = readZip(bytes, options.limits ?? DEFAULT_ZIP_LIMITS);
  const warnings: FileWarning[] = [];

  const mimetype = entries.get(ENTRY.mimetype);
  if (mimetype && fromUtf8(mimetype) !== MIMETYPE) {
    throw new FileFormatError(
      "not-galatsa",
      "The file is a zip archive, but not a Galatsa file.",
    );
  }
  const manifestBytes = entries.get(ENTRY.manifest);
  const documentBytes = entries.get(ENTRY.document);
  if (!manifestBytes) {
    throw new FileFormatError(
      mimetype ? "damaged" : "not-galatsa",
      mimetype
        ? "The file is damaged: manifest.json is missing."
        : "The file is a zip archive, but not a Galatsa file.",
    );
  }
  const manifest = parseJson(manifestBytes, ENTRY.manifest);
  if (!isObject(manifest) || manifest.format !== "galatsa") {
    throw new FileFormatError(
      "not-galatsa",
      "The file is a zip archive, but not a Galatsa file.",
    );
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
  if (!documentBytes)
    throw new FileFormatError(
      "damaged",
      "The file is damaged: document.json is missing.",
    );

  let raw: RawFile = { manifest, document: parseJson(documentBytes, ENTRY.document) };
  const migrated = formatVersion < registry.current;
  if (migrated) {
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

  // Merge identity: use ydoc.bin only if nothing was migrated and it matches.
  let doc: Y.Doc | null = null;
  const ydocBytes = entries.get(ENTRY.ydoc);
  if (ydocBytes && !migrated && !elementsMigrated) {
    try {
      const candidate = new Y.Doc();
      Y.applyUpdate(candidate, ydocBytes);
      if (jsonEqual(toSnapshot(candidate), snapshot)) doc = candidate;
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
  if (!doc) doc = fromSnapshot(snapshot);
  // Read the snapshot back so callers get exactly what the Y.Doc holds.
  snapshot = toSnapshot(doc);

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

  return { doc, snapshot, assets, thumbnail, formatVersion, mergeIdentityKept, warnings };
}
