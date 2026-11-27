// SPDX-License-Identifier: GPL-3.0-or-later

// A storage backend in memory, for tests and for programs that must not keep
// anything. It can simulate faults: failing writes, a write torn in the middle by
// a store that is not atomic, and a program that stops.

import {
  StorageError,
  checkKey,
  type StorageBackend,
  type StorageErrorKind,
} from "./backend.ts";

export type MemoryOperation = "read" | "list" | "write" | "create" | "remove";

/** A memory backend that can be stopped, as if its program had died. */
export interface MemoryBackend extends StorageBackend {
  /**
   * Stops this backend at once: every operation that has not finished, and every
   * later one, rejects without changing anything. Other backends over the same
   * store go on working. This is how tests simulate a crash.
   */
  kill(): void;
  readonly killed: boolean;
}

/** Bytes shared by any number of backends: one "disk" that outlives programs. */
export interface MemoryStore {
  /** The stored bytes, for tests to inspect or damage. */
  readonly data: Map<string, Uint8Array>;
  /** A new backend over this store. */
  backend(name?: string): MemoryBackend;
  /** The next `count` writes, creates or removes fail with the given kind. */
  failWrites(count?: number, kind?: StorageErrorKind): void;
  /**
   * The next write or create stores only the first `atByte` bytes, and the
   * backend that made it is killed: a store without atomic writes that stopped in
   * the middle of one.
   */
  tearNextWrite(atByte: number): void;
  /**
   * Called before each operation of every backend, and awaited. Tests use it to
   * interleave two programs at chosen points.
   */
  beforeOperation: ((operation: MemoryOperation, key: string) => Promise<void>) | null;
}

export function createMemoryStore(): MemoryStore {
  const data = new Map<string, Uint8Array>();
  let failing = 0;
  let failKind: StorageErrorKind = "failed";
  let tearAt: number | null = null;

  const store: MemoryStore = {
    data,
    beforeOperation: null,
    failWrites(count = 1, kind = "failed") {
      failing = count;
      failKind = kind;
    },
    tearNextWrite(atByte) {
      tearAt = atByte;
    },
    backend(name = "memory") {
      let killed = false;
      const enter = async (operation: MemoryOperation, key: string) => {
        if (killed) throw new StorageError("unavailable", "The backend was stopped");
        await Promise.resolve();
        if (store.beforeOperation) await store.beforeOperation(operation, key);
        if (killed) throw new StorageError("unavailable", "The backend was stopped");
        if (operation === "write" || operation === "create" || operation === "remove") {
          if (failing > 0) {
            failing--;
            throw new StorageError(failKind, `Simulated ${failKind} failure`);
          }
        }
      };
      const store1 = (key: string, bytes: Uint8Array) => {
        if (tearAt !== null) {
          const at = Math.max(0, Math.min(tearAt, bytes.length));
          tearAt = null;
          data.set(key, bytes.slice(0, at));
          killed = true;
          throw new StorageError(
            "unavailable",
            "The backend stopped in the middle of a write",
          );
        }
        data.set(key, bytes.slice());
      };
      const backend: MemoryBackend = {
        name,
        get killed() {
          return killed;
        },
        kill() {
          killed = true;
        },
        async read(key) {
          checkKey(key);
          await enter("read", key);
          const bytes = data.get(key);
          return bytes ? bytes.slice() : undefined;
        },
        async list(prefix) {
          await enter("list", prefix);
          return [...data.keys()].filter((key) => key.startsWith(prefix)).sort(compare);
        },
        async write(key, bytes) {
          checkKey(key);
          await enter("write", key);
          store1(key, bytes);
        },
        async create(key, bytes) {
          checkKey(key);
          await enter("create", key);
          if (data.has(key)) return false;
          store1(key, bytes);
          return true;
        },
        async remove(keys) {
          for (const key of keys) checkKey(key);
          await enter("remove", keys[0] ?? "");
          for (const key of keys) data.delete(key);
        },
      };
      return backend;
    },
  };
  return store;
}

/** A backend over a store of its own. */
export function memoryBackend(name?: string): MemoryBackend {
  return createMemoryStore().backend(name);
}

/** Orders strings by UTF-16 code units, as IndexedDB orders string keys. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
