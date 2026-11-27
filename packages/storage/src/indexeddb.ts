// SPDX-License-Identifier: GPL-3.0-or-later

// A storage backend in the browser's IndexedDB. Section 3 of
// docs/adr/0006-storage.md.

import { StorageError, checkKey, errorKind, type StorageBackend } from "./backend.ts";

const STORE = "blobs";

export interface IndexedDbOptions {
  /** The database name (default "galatsa-storage"). */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  factory?: IDBFactory;
  /**
   * Durability of writes. "strict" (the default) asks the browser to flush to
   * disk before a write resolves, where the browser supports the hint.
   */
  durability?: "strict" | "relaxed" | "default";
}

function wrap(error: unknown, what: string): StorageError {
  if (error instanceof StorageError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  return new StorageError(
    errorKind(error),
    `IndexedDB ${what} failed${typeof name === "string" ? ` (${name})` : ""}`,
    { cause: error },
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new StorageError("failed", "Transaction aborted"));
  });
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new StorageError("failed", "IndexedDB returned a value that is not bytes");
}

/**
 * Opens (and creates if needed) the IndexedDB database. Rejects with a
 * StorageError of kind "unavailable" where IndexedDB cannot be used (some private
 * modes, blocked storage).
 */
export async function indexedDbBackend(
  options: IndexedDbOptions = {},
): Promise<StorageBackend> {
  const name = options.name ?? "galatsa-storage";
  const factory =
    options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;
  if (!factory) throw new StorageError("unavailable", "IndexedDB is not available");
  const durability = options.durability ?? "strict";

  const connect = async (): Promise<IDBDatabase> => {
    let opened: IDBDatabase;
    try {
      // No version: a database that another program upgraded still opens.
      const open = factory.open(name);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE))
          open.result.createObjectStore(STORE);
      };
      opened = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () =>
          reject(new StorageError("unavailable", "IndexedDB is blocked by another tab"));
      });
    } catch (error) {
      throw new StorageError("unavailable", "IndexedDB could not be opened", {
        cause: error,
      });
    }
    // A newer version of the database elsewhere: let it upgrade. The browser
    // may also close the connection itself (site data cleared). Either way the
    // next operation opens a new connection.
    opened.onversionchange = () => {
      opened.close();
      if (db === opened) db = null;
    };
    opened.onclose = () => {
      if (db === opened) db = null;
    };
    return opened;
  };
  let db: IDBDatabase | null = await connect();
  let closed = false;

  /**
   * Runs one transaction, on a new connection if the old one was closed. A
   * transaction that could not start or was aborted wrote nothing, so it is
   * tried once more on a fresh connection.
   */
  const run = async <T>(
    what: string,
    mode: IDBTransactionMode,
    body: (t: IDBTransaction) => Promise<T>,
  ): Promise<T> => {
    if (closed) throw new StorageError("unavailable", "The backend was closed");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        db ??= await connect();
        const t =
          mode === "readwrite"
            ? db.transaction(STORE, mode, { durability })
            : db.transaction(STORE, mode);
        return await body(t);
      } catch (error) {
        lastError = error;
        const errorName = (error as { name?: unknown } | null)?.name;
        if (errorName !== "InvalidStateError" && errorName !== "AbortError") break;
        db = null;
      }
    }
    throw wrap(lastError, what);
  };

  return {
    name: `indexeddb:${name}`,
    async read(key) {
      checkKey(key);
      return run("read", "readonly", async (t) =>
        toBytes(await request(t.objectStore(STORE).get(key))),
      );
    },
    async list(prefix) {
      return run("list", "readonly", async (t) => {
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, true);
        const keys = await request(t.objectStore(STORE).getAllKeys(range));
        return keys.filter((key): key is string => typeof key === "string");
      });
    },
    async write(key, bytes) {
      checkKey(key);
      await run("write", "readwrite", async (t) => {
        t.objectStore(STORE).put(bytes.slice(), key);
        await done(t);
      });
    },
    async create(key, bytes) {
      checkKey(key);
      return run("create", "readwrite", async (t) => {
        const store = t.objectStore(STORE);
        let created = false;
        // Checking and adding in one transaction is atomic.
        const count = store.count(key);
        count.onsuccess = () => {
          if (count.result === 0) {
            store.add(bytes.slice(), key);
            created = true;
          }
        };
        await done(t);
        return created;
      });
    },
    async remove(keys) {
      for (const key of keys) checkKey(key);
      if (keys.length === 0) return;
      await run("remove", "readwrite", async (t) => {
        const store = t.objectStore(STORE);
        for (const key of keys) store.delete(key);
        await done(t);
      });
    },
    close() {
      closed = true;
      db?.close();
      db = null;
    },
  };
}

/**
 * Asks the browser to keep this site's storage under storage pressure, instead of
 * evicting it. Some browsers decide by themselves, some ask the user. Returns
 * whether storage is persistent now (false where the API is missing).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator
    ?.storage;
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
