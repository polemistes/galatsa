// SPDX-License-Identifier: GPL-3.0-or-later

// The place where the storage layer keeps its working copies: a small key-value
// store of byte arrays. See docs/adr/0006-storage.md, section 3.

/**
 * A key-value store of byte arrays. Keys are short ASCII strings made of
 * lowercase letters, digits, "-", "_", "." and "/" (so that a file system
 * backend can map them to paths).
 *
 * The storage layer relies on exactly these guarantees:
 *
 * - `write` is atomic per key: a reader sees the old bytes or the new bytes, never
 *   a mix, also when the program stops in the middle. (IndexedDB: one
 *   transaction. A desktop file system: write a temporary file, flush it, rename
 *   it over the old one.)
 * - `create` is atomic per key, and checks that the key is absent in the same
 *   step. (IndexedDB: `add` in one transaction. A file system: write a temporary
 *   file, then hard-link it to the final name, which fails if the name exists.)
 * - A write that has resolved is durable, as far as the platform allows.
 *
 * Nothing needs to be atomic across keys: the layer orders its writes so that a
 * stop between two of them leaves only redundant data (section 4 of the ADR).
 */
export interface StorageBackend {
  /** A name for diagnosis and for naming cross-tab channels and locks. */
  readonly name: string;
  /** The bytes under `key`, or undefined if there are none. */
  read(key: string): Promise<Uint8Array | undefined>;
  /** Every key that starts with `prefix`, sorted by UTF-16 code units. */
  list(prefix: string): Promise<string[]>;
  /** Stores `bytes` under `key`, replacing what was there, atomically. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * Stores `bytes` under `key` only if the key is absent, atomically with that
   * check. Returns false (and changes nothing) if the key was present.
   */
  create(key: string, bytes: Uint8Array): Promise<boolean>;
  /** Removes the keys. Keys that are not there are ignored. */
  remove(keys: readonly string[]): Promise<void>;
  /** Releases connections. The backend is not used afterwards. */
  close?(): void;
}

/** Why a backend operation failed. */
export type StorageErrorKind =
  /** The browser or the disk has no room left. */
  | "full"
  /** The store cannot be used at all (blocked, private mode, no permission). */
  | "unavailable"
  /** Anything else. */
  | "failed";

/** An error from a backend, with a kind the layer can tell the user about. */
export class StorageError extends Error {
  readonly kind: StorageErrorKind;

  constructor(kind: StorageErrorKind, detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = "StorageError";
    this.kind = kind;
  }
}

/** The kind of any error thrown by a backend. */
export function errorKind(error: unknown): StorageErrorKind {
  if (error instanceof StorageError) return error.kind;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return "full";
  if (name === "InvalidStateError" || name === "SecurityError") return "unavailable";
  return "failed";
}

const KEY_PATTERN = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/;

/** Throws unless `key` is a valid key (see StorageBackend). */
export function checkKey(key: string): void {
  if (key.length > 200 || !KEY_PATTERN.test(key) || key.split("/").includes("..")) {
    throw new StorageError("failed", `Invalid storage key: ${JSON.stringify(key)}`);
  }
}
