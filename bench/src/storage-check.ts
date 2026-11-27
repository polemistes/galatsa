// SPDX-License-Identifier: GPL-3.0-or-later

// Checks of the storage layer in a real browser: the IndexedDB backend against
// the backend contract, sessions that are stopped and recovered, several tabs,
// files through the File System Access API (the origin private file system,
// which needs no picker) and the checkpoint worker. Driven by
// tests/e2e/storage.spec.ts through `window.galatsaStorageCheck`, or run on its
// own with `?auto=phase1` and then `?auto=phase2` (the result goes to the title),
// for browsers Playwright cannot drive.

import { addElement, toSnapshot } from "@galatsa/core/ydoc";
import { canonicalJson, writeGalatsaFile } from "@galatsa/format";
import {
  DocumentStorage,
  encodeCheckpointFile,
  fileHandleTarget,
  indexedDbBackend,
  workerEncoder,
  type StorageBackend,
  type StorageSession,
} from "@galatsa/storage";
import { checkBackendContract } from "@galatsa/storage/testing";
import * as Y from "yjs";

const DB = "galatsa-storage-check";
let backend: StorageBackend | null = null;
let storage: DocumentStorage | null = null;
const sessions = new Map<string, StorageSession>();

async function store(): Promise<DocumentStorage> {
  backend ??= await indexedDbBackend({ name: DB });
  storage ??= new DocumentStorage({
    backend,
    timing: { journalDelay: 50, journalMaxDelay: 200 },
  });
  return storage;
}

function session(slot: string): StorageSession {
  const found = sessions.get(slot);
  if (!found) throw new Error(`No session for ${slot}`);
  return found;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

const api = {
  async features() {
    const nav = navigator as Navigator & { locks?: unknown };
    let opfs = false;
    let writable = false;
    try {
      const root = await navigator.storage.getDirectory();
      opfs = true;
      const handle = await root.getFileHandle("probe.bin", { create: true });
      writable = typeof handle.createWritable === "function";
      await root.removeEntry("probe.bin");
    } catch {
      // Not available here.
    }
    return {
      userAgent: navigator.userAgent,
      indexedDB: typeof indexedDB !== "undefined",
      locks: typeof nav.locks !== "undefined",
      broadcastChannel: typeof BroadcastChannel !== "undefined",
      opfs,
      createWritable: writable,
    };
  },

  async reset() {
    for (const s of sessions.values()) await s.close().catch(() => {});
    sessions.clear();
    backend?.close?.();
    backend = null;
    storage = null;
    await deleteDatabase(DB);
    return true;
  },

  /** The browser closes the connection (a newer version elsewhere): the backend opens a new one. */
  async reconnect() {
    const name = "galatsa-storage-reconnect";
    const b = await indexedDbBackend({ name });
    try {
      await b.write("k", new Uint8Array([1, 2, 3]));
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
      const back = await b.read("k");
      if (!back || !same(back, new Uint8Array([1, 2, 3]))) {
        throw new Error("No reconnection after the connection was closed");
      }
      await b.write("k2", new Uint8Array([4]));
    } finally {
      b.close?.();
      await deleteDatabase(name);
    }
    return true;
  },

  async contract() {
    const name = "galatsa-storage-contract";
    const b = await indexedDbBackend({ name });
    try {
      await checkBackendContract(b);
    } finally {
      b.close?.();
      await deleteDatabase(name);
    }
    return true;
  },

  async create(title: string) {
    const s = await (await store()).create({ title });
    sessions.set(s.slot, s);
    return s.slot;
  },

  async open(slot: string) {
    const result = await (await store()).open(slot);
    if (!result.ok) return { ok: false, problem: result.problem.code };
    sessions.set(slot, result.session);
    return { ok: true, notices: result.notices.map((n) => n.code) };
  },

  edit(slot: string, count: number, tag: number) {
    const doc = session(slot).doc;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        addElement(doc, {
          type: "test.shapes/box",
          x: tag * 1000 + i * 20,
          y: tag,
          size: { w: 10, h: 10 },
          name: `${tag}-${i}`,
        }),
      );
    }
    return ids;
  },

  async flush(slot: string) {
    return session(slot).flush();
  },

  async checkpoint(slot: string) {
    await session(slot).checkpoint();
    return true;
  },

  async close(slot: string) {
    await session(slot).close();
    sessions.delete(slot);
    return true;
  },

  snapshot(slot: string) {
    return canonicalJson(toSnapshot(session(slot).doc));
  },

  elementIds(slot: string) {
    return Object.keys(toSnapshot(session(slot).doc).elements).sort();
  },

  async recoverable() {
    return (await (await store()).recoverable()).map((offer) => offer.slot);
  },

  /**
   * The newest checkpoint is cut short in the store: the document must still open
   * whole, from the checkpoint before it and the journal.
   */
  async tornCheckpoint() {
    const s = await (await store()).create({ title: "Torn" });
    api.editSession(s, 30, 1);
    await s.checkpoint();
    api.editSession(s, 30, 2);
    await s.checkpoint();
    api.editSession(s, 3, 3);
    await s.flush();
    const expected = canonicalJson(toSnapshot(s.doc));
    const keys = (await backend!.list(`doc/${s.slot}/cp/`)).sort();
    const newest = keys[keys.length - 1]!;
    const bytes = (await backend!.read(newest))!;
    await backend!.write(newest, bytes.slice(0, Math.floor(bytes.length / 2)));
    const other = new DocumentStorage({ backend: backend!, channels: null });
    const result = await other.open(s.slot);
    if (!result.ok) throw new Error(`Torn checkpoint: ${result.problem.code}`);
    const got = canonicalJson(toSnapshot(result.session.doc));
    const notices = result.notices.map((n) => n.code);
    await result.session.close();
    await s.close();
    if (got !== expected) throw new Error("Torn checkpoint: the document differs");
    if (!notices.includes("restored-previous-copy")) {
      throw new Error(`Torn checkpoint: notices ${notices.join(",")}`);
    }
    return true;
  },

  editSession(s: StorageSession, count: number, tag: number) {
    for (let i = 0; i < count; i++) {
      addElement(s.doc, {
        type: "test.shapes/box",
        x: i,
        y: tag,
        size: { w: 5, h: 5 },
      });
    }
  },

  /** Saving through a FileSystemFileHandle, and a write that is given up halfway. */
  async fileHandle() {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("check.galatsa", { create: true });
    const target = fileHandleTarget(handle);
    const s = await (await store()).create({ title: "File" });
    api.editSession(s, 5, 1);
    const saved = await s.saveToFile(target);
    if (!saved.ok) throw new Error(`Save failed: ${saved.problem.code}`);
    const first = await target.read();
    // A save that stops before it is closed leaves the file as it was.
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(new Uint8Array([1, 2, 3]));
    const during = await target.read();
    await writable.abort();
    const after = await target.read();
    // Reopening the saved file gives the document.
    const reopened = await (await store()).openFile(target);
    if (!reopened.ok) throw new Error(`Open failed: ${reopened.problem.code}`);
    const equal =
      canonicalJson(toSnapshot(reopened.session.doc)) ===
      canonicalJson(toSnapshot(s.doc));
    await reopened.session.close();
    await s.close();
    await root.removeEntry("check.galatsa");
    if (!same(during, first))
      throw new Error("The file changed before the write was closed");
    if (!same(after, first)) throw new Error("An aborted write changed the file");
    if (!equal) throw new Error("The saved file did not reopen as the same document");
    return true;
  },

  /** The checkpoint worker builds the same file as this thread. */
  async worker() {
    const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const encoder = workerEncoder(worker);
      const doc = new Y.Doc();
      const s = await (await store()).create({ title: "Worker" });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(s.doc));
      await s.close();
      const state = Y.encodeStateAsUpdate(doc);
      const remote = await encoder(state);
      const local = encodeCheckpointFile(state);
      if (!same(remote.file, local.file))
        throw new Error("The worker built another file");
      // The file it built opens.
      writeGalatsaFile(doc, () => undefined);
      return true;
    } finally {
      worker.terminate();
    }
  },
};

declare global {
  interface Window {
    galatsaStorageCheck: typeof api;
  }
}
window.galatsaStorageCheck = api;

// Self-running mode, for browsers without Playwright.
async function auto(mode: string): Promise<string> {
  if (mode === "phase1") {
    await api.reset();
    await api.contract();
    await api.reconnect();
    await api.tornCheckpoint();
    await api.worker();
    const features = await api.features();
    if (features.createWritable) await api.fileHandle();
    const slot = await api.create("Crash");
    api.edit(slot, 20, 1);
    await api.flush(slot);
    localStorage.setItem(
      "galatsa-storage-check",
      JSON.stringify({ slot, snapshot: api.snapshot(slot) }),
    );
    return `phase1 ok ${JSON.stringify(features)}`;
  }
  if (mode === "phase2") {
    const saved = JSON.parse(localStorage.getItem("galatsa-storage-check") ?? "null") as {
      slot: string;
      snapshot: string;
    } | null;
    if (!saved) throw new Error("phase1 did not run");
    const offers = await api.recoverable();
    if (!offers.includes(saved.slot)) throw new Error(`Not offered: ${offers.join(",")}`);
    const opened = await api.open(saved.slot);
    if (!opened.ok) throw new Error(`Open failed: ${opened.problem}`);
    if (api.snapshot(saved.slot) !== saved.snapshot)
      throw new Error("The document differs");
    await api.close(saved.slot);
    await api.reset();
    return "phase2 ok";
  }
  throw new Error(`Unknown mode ${mode}`);
}

const mode = new URLSearchParams(location.search).get("auto");
if (mode) {
  auto(mode).then(
    (result) => {
      document.title = `done: ${result}`;
    },
    (error: unknown) => {
      document.title = `failed: ${String(error)}`;
    },
  );
}
