// SPDX-License-Identifier: GPL-3.0-or-later

// Upgrading files written with older format versions. Section 9.4 of
// docs/adr/0001-document-model-and-file-format.md.

import { SCHEMA_VERSION } from "@galatsa/core";

/** The format version this code writes and reads. Equal to the schema version. */
export const FORMAT_VERSION = SCHEMA_VERSION;

/** The parsed JSON of a file's manifest and document, before validation. */
export interface RawFile {
  manifest: Record<string, unknown>;
  document: unknown;
}

/**
 * One step: upgrades a file from version `from` to `from + 1`. Only steps that
 * change something have a migration; a version that only added optional content
 * (in ext slots, settings or new optional entries) needs none. A migration must
 * be pure and deterministic and must not assume anything about element data it
 * does not own (elements of unknown types pass through). It need not update the
 * version numbers; the caller does.
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
 * incompatible change adds a step `{ from: 1, ... }` here and raises
 * SCHEMA_VERSION (and, if old readers must refuse, MIN_READER_VERSION) in core.
 */
export const MIGRATIONS: MigrationRegistry = {
  current: FORMAT_VERSION,
  migrations: [],
};

/**
 * Upgrades from `version` to the registry's current version. Returns whether any
 * migration ran (only then does the document's content change, and merge identity
 * is reset, section 9.4).
 */
export function migrate(
  file: RawFile,
  version: number,
  registry: MigrationRegistry,
): { file: RawFile; changed: boolean } {
  let result = file;
  let changed = false;
  for (let v = version; v < registry.current; v++) {
    const step = registry.migrations.find((m) => m.from === v);
    if (step) {
      result = step.migrate(structuredCopy(result));
      changed = true;
    }
    result = {
      manifest: { ...result.manifest, formatVersion: v + 1 },
      document:
        typeof result.document === "object" && result.document !== null
          ? { ...(result.document as object), schemaVersion: v + 1 }
          : result.document,
    };
  }
  return { file: result, changed };
}

/** A deep copy of JSON data, so a migration cannot change its caller's input. */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
