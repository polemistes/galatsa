// SPDX-License-Identifier: GPL-3.0-or-later

// Upgrading files written with older format versions. Section 9.4 of
// docs/adr/0001-document-model-and-file-format.md.

import { SCHEMA_VERSION } from "@galatsa/core";

/** The format version this code writes. Equal to the document schema version. */
export const FORMAT_VERSION = SCHEMA_VERSION;

/** The parsed JSON of a file's manifest and document, before validation. */
export interface RawFile {
  manifest: Record<string, unknown>;
  document: unknown;
}

/**
 * One step: upgrades a file from version `from` to `from + 1`. It must be pure
 * and deterministic, must not assume anything about element data it does not
 * own (elements of unknown types pass through), and must set
 * `manifest.formatVersion` and `document.schemaVersion` to `from + 1`.
 */
export interface Migration {
  from: number;
  description: string;
  migrate(file: RawFile): RawFile;
}

/** The ordered steps known to this version. Steps are never removed. */
export interface MigrationRegistry {
  /** The version files are upgraded to (the version this code writes). */
  current: number;
  migrations: readonly Migration[];
}

/**
 * Version 1 is the first version, so there is nothing to migrate yet. The first
 * change to the format adds a step `{ from: 1, ... }` here and raises
 * SCHEMA_VERSION in @galatsa/core.
 */
export const MIGRATIONS: MigrationRegistry = {
  current: FORMAT_VERSION,
  migrations: [],
};

/** Applies every step from `version` up to the registry's current version. */
export function migrate(
  file: RawFile,
  version: number,
  registry: MigrationRegistry,
): RawFile {
  let result = file;
  for (let v = version; v < registry.current; v++) {
    const step = registry.migrations.find((m) => m.from === v);
    if (!step) throw new Error(`No migration from format version ${v}`);
    result = step.migrate(structuredCopy(result));
    if (result.manifest.formatVersion !== v + 1) {
      throw new Error(
        `Migration from version ${v} did not set formatVersion to ${v + 1}`,
      );
    }
  }
  return result;
}

/** A deep copy of JSON data, so a migration cannot change its caller's input. */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
