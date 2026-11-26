// SPDX-License-Identifier: GPL-3.0-or-later

// Where the user's language choice is remembered. Browsers use localStorage; the
// desktop app and tests pass their own implementation.

/** Remembers one value: the language the user chose. */
export interface LocaleStorage {
  /** The stored value, or null if nothing is stored or it cannot be read. */
  get(): string | null;
  /** Stores the value. Must not throw; a failed write is silently ignored. */
  set(value: string): void;
}

/** Key under which the language choice is stored in localStorage. */
export const LOCALE_STORAGE_KEY = "galatsa.locale";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Storage backed by the browser's localStorage. Reading and writing are wrapped,
 * because localStorage may be missing (Node, some webviews) or throw (private
 * browsing, blocked site data, full quota). In those cases the choice is kept for
 * the session only.
 */
export function browserLocaleStorage(key: string = LOCALE_STORAGE_KEY): LocaleStorage {
  const fallback = memoryLocaleStorage();
  const storage = (): StorageLike | undefined => {
    try {
      return (globalThis as { localStorage?: StorageLike }).localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    get() {
      try {
        const value = storage()?.getItem(key);
        if (typeof value === "string") return value;
      } catch {
        // fall through to the in-memory copy
      }
      return fallback.get();
    },
    set(value) {
      fallback.set(value);
      try {
        storage()?.setItem(key, value);
      } catch {
        // keep the in-memory copy only
      }
    },
  };
}

/** Storage that lives only as long as the object. For tests and as a fallback. */
export function memoryLocaleStorage(initial: string | null = null): LocaleStorage {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}
