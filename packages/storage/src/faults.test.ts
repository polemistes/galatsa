// SPDX-License-Identifier: GPL-3.0-or-later

// Faults that could lose work: workers that hang, damaged journal entries, tabs
// that open while another one stores, downloads, a store that is gone or full,
// failed lock queries, and the guarantees each step of a checkpoint gives.

import {
  addAsset,
  addElement,
  initDocument,
  lineageOf,
  setTitle,
  syncDocs,
  syncInto,
  toSnapshot,
} from "@galatsa/core/ydoc";
import { runScenario } from "@galatsa/core/testing";
import { readGalatsaFile, writeGalatsaFile } from "@galatsa/format";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { StorageBackend } from "./backend.ts";
import { encodeCheckpoint, loadCheckpoint } from "./checkpoint.ts";
import { memoryChannels } from "./environment.ts";
import { memoryFile, type FileTarget } from "./files.ts";
import { keys } from "./layout.ts";
import type { StorageSession } from "./session.ts";
import { DocumentStorage, type OpenResult } from "./storage.ts";
import { ManualScheduler, addBox, machine, program, settle } from "./test-helpers.ts";
import { workerEncoder, type WorkerLike } from "./worker.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.["GALATSA_FUZZ_SEEDS"] ?? 10);
const FIRST = Number(env?.["GALATSA_FUZZ_FIRST"] ?? 1);

function opened(result: OpenResult): StorageSession {
  if (!result.ok) throw new Error(`open failed: ${result.problem.code}`);
  return result.session;
}

function codes(result: OpenResult): string[] {
  return result.ok ? result.notices.map((n) => n.code) : [result.problem.code];
}

function keysUnder(m: ReturnType<typeof machine>, prefix: string): string[] {
  return [...m.store.data.keys()].filter((k) => k.startsWith(prefix)).sort();
}

function storage(
  m: ReturnType<typeof machine>,
  scheduler: ManualScheduler,
  extra: Partial<ConstructorParameters<typeof DocumentStorage>[0]> = {},
): DocumentStorage {
  return new DocumentStorage({
    backend: m.store.backend(),
    liveness: m.liveness,
    channels: null,
    scheduler,
    lifecycle: false,
    ...extra,
  });
}

describe("checkpoint workers that fail", () => {
  it("a worker that never answers keeps neither the document nor checkpoints from working", async () => {
    const silent: WorkerLike = { postMessage() {}, addEventListener() {} };
    const m = machine();
    const scheduler = new ManualScheduler();
    const s = storage(m, scheduler, {
      encodeCheckpoint: workerEncoder(silent, { timeoutMs: 20 }),
    });
    let created: StorageSession | null = null;
    void s.create().then((session) => (created = session));
    await settle();
    expect(created).not.toBeNull();
    const session = created! as StorageSession;
    addBox(session.doc);
    await session.checkpoint();
    expect(keysUnder(m, keys.checkpoints(session.slot)).at(-1)).toBe(
      keys.checkpoint(session.slot, 3),
    );
  });

  it("a worker whose answer cannot be read is given up", async () => {
    const listeners = new Map<string, (event: Event) => void>();
    const garbled: WorkerLike = {
      postMessage() {
        queueMicrotask(() => listeners.get("messageerror")?.(new Event("messageerror")));
      },
      addEventListener(type: string, listener: (event: never) => void) {
        listeners.set(type, listener as (event: Event) => void);
      },
    };
    const encoder = workerEncoder(garbled);
    const doc = new Y.Doc();
    initDocument(doc);
    addBox(doc);
    const state = Y.encodeStateAsUpdate(doc);
    const result = await encoder(state);
    expect(result.file.length).toBeGreaterThan(0);
  });

  it("a hung encoder holds up neither the journal nor, after its time limit, checkpoints", async () => {
    let hang = false;
    const m = machine();
    const scheduler = new ManualScheduler();
    const s = storage(m, scheduler, {
      encodeCheckpoint: (state) =>
        hang ? new Promise(() => {}) : encodeCheckpoint(state),
    });
    const session = await s.create();
    hang = true;
    addBox(session.doc);
    await scheduler.advance(40_000); // journal, then a checkpoint that hangs
    const journalBefore = keysUnder(m, keys.journal(session.slot)).length;
    expect(journalBefore).toBe(1);
    for (let i = 0; i < 5; i++) {
      addBox(session.doc, i, i);
      await scheduler.advance(2000);
    }
    expect(keysUnder(m, keys.journal(session.slot)).length).toBeGreaterThan(
      journalBefore,
    );
    // After the time limit the checkpoint is built on this thread.
    await scheduler.advance(70_000);
    const newest = keysUnder(m, keys.checkpoints(session.slot)).at(-1)!;
    expect(newest > keys.checkpoint(session.slot, 2)).toBe(true);
    const expected = toSnapshot(session.doc);
    m.liveness.kill(session.id);
    expect(toSnapshot(opened(await program(m).storage.open(session.slot)).doc)).toEqual(
      expected,
    );
  });
});

describe("damaged journal entries", () => {
  it("do not make later checkpoints unusable", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc, 1, 1);
    await session.checkpoint();
    for (const n of [2, 3, 4]) {
      addBox(session.doc, n, n);
      await session.flush();
    }
    p1.crash(session);
    const entries = keysUnder(m, keys.journal(session.slot));
    expect(entries).toHaveLength(4); // the first is in the checkpoint
    const middle = m.store.data.get(entries[2]!)!.slice();
    middle[middle.length - 1]! ^= 0xff;
    m.store.data.set(entries[2]!, middle);

    const p2 = program(m);
    const r2 = await p2.storage.open(session.slot);
    const s2 = opened(r2);
    expect(r2.ok && r2.notices.find((n) => n.code === "changes-lost")?.values).toEqual({
      count: 1,
    });
    expect(codes(r2)).toContain("changes-incomplete");
    // The damaged entry went with the checkpoint written at once.
    expect(m.store.data.has(entries[2]!)).toBe(false);
    addBox(s2.doc, 5, 5);
    await s2.flush();
    const newest = keysUnder(m, keys.checkpoints(session.slot)).at(-1)!;
    expect((await loadCheckpoint(m.store.data.get(newest)!))?.mergeIdentityKept).toBe(
      true,
    );
    p2.crash(s2);

    const s3 = opened(await program(m).storage.open(session.slot));
    addBox(s3.doc, 6, 6);
    await s3.checkpoint();
    addBox(s3.doc, 7, 7);
    await s3.checkpoint();
    addBox(s3.doc, 8, 8);
    await s3.flush();
    const expected = toSnapshot(s3.doc);
    m.liveness.kill(s3.id);
    const r4 = await program(m).storage.open(session.slot);
    expect(codes(r4)).toEqual([]);
    expect(toSnapshot(opened(r4).doc)).toEqual(expected);
  });

  it("are reported once, then cleared", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc, 1, 1);
    await session.flush();
    addBox(session.doc, 2, 2);
    await session.flush();
    p1.crash(session);
    const entries = keysUnder(m, keys.journal(session.slot));
    const last = m.store.data.get(entries.at(-1)!)!.slice();
    last[last.length - 1]! ^= 0xff;
    m.store.data.set(entries.at(-1)!, last);
    const perOpen: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const r = await program(m).storage.open(session.slot);
      perOpen.push(codes(r));
      if (r.ok) {
        addBox(r.session.doc, 10 + i, 0);
        await r.session.close();
      }
    }
    expect(perOpen[0]).toContain("changes-lost");
    expect(perOpen.slice(1)).toEqual([[], []]);
    expect(keysUnder(m, keys.journal(session.slot))).not.toContain(entries.at(-1));
  });
});

describe("changes while the store is busy", () => {
  it("changes made while a journal entry or a checkpoint is being written are stored", async () => {
    for (const withCheckpoint of [false, true]) {
      const m = machine();
      const p1 = program(m);
      const session = await p1.storage.create();
      let during = 0;
      m.store.beforeOperation = async (operation, key) => {
        if (
          (operation === "write" || operation === "create") &&
          !key.includes("/s/") &&
          during < 6
        ) {
          during++;
          addBox(session.doc, 100 + during, 0);
        }
      };
      addBox(session.doc, 1, 1);
      await p1.scheduler.advance(1000);
      addBox(session.doc, 2, 2);
      if (withCheckpoint) await session.checkpoint();
      await p1.scheduler.advance(1500);
      m.store.beforeOperation = null;
      await session.flush();
      const expected = toSnapshot(session.doc);
      p1.crash(session);
      const again = opened(await program(m).storage.open(session.slot));
      expect(during).toBeGreaterThan(1);
      expect(toSnapshot(again.doc), `with checkpoint: ${withCheckpoint}`).toEqual(
        expected,
      );
    }
  });
});

describe("several tabs", () => {
  it("a running tab that meets another tab's damaged entry keeps its checkpoints whole, and removes the entry", async () => {
    const m = machine();
    const a = await program(m).storage.create();
    const pb = program(m);
    const b = opened(await pb.storage.open(a.slot));
    for (const n of [1, 2, 3]) {
      addBox(b.doc, n, n);
      await b.flush();
    }
    pb.crash(b);
    const fromB = keysUnder(m, keys.journal(a.slot));
    expect(fromB).toHaveLength(3);
    const middle = m.store.data.get(fromB[1]!)!.slice();
    middle[middle.length - 1]! ^= 0xff;
    m.store.data.set(fromB[1]!, middle);
    addBox(a.doc, 9, 9);
    await a.checkpoint();
    // The entry after the damaged one waits for it in Yjs; it must not travel
    // into the checkpoint, or the checkpoint loses its merge identity.
    const newest = keysUnder(m, keys.checkpoints(a.slot)).at(-1)!;
    expect((await loadCheckpoint(m.store.data.get(newest)!))?.mergeIdentityKept).toBe(
      true,
    );
    expect(m.store.data.has(fromB[1]!)).toBe(false);
  });

  it("a tab that opens while another stores an entry still gets everything, and saves it", async () => {
    const m = machine(memoryChannels());
    const pa = program(m);
    const a = await pa.storage.create();
    addBox(a.doc, 1, 1);
    await a.checkpoint();
    let once = false;
    m.store.beforeOperation = async (operation, key) => {
      if (!once && operation === "read" && key.includes("/cp/")) {
        once = true;
        addBox(a.doc, 2, 2);
        await a.flush();
      }
    };
    const b = opened(await program(m).storage.open(a.slot));
    m.store.beforeOperation = null;
    const late = addBox(a.doc, 3, 3);
    await a.flush();
    await settle();
    expect(Object.keys(toSnapshot(b.doc).elements)).toContain(late);
    expect(b.doc.store.pendingStructs).toBeNull();
    const file = memoryFile("talk.galatsa");
    expect((await b.saveToFile(file)).ok).toBe(true);
    const read = await readGalatsaFile(file.bytes!);
    expect(late in read.snapshot.elements).toBe(true);
    expect(read.mergeIdentityKept).toBe(true);
  });

  it("a save to a file brings in what other tabs stored, even without a channel", async () => {
    const m = machine();
    const a = await program(m).storage.create();
    const b = opened(await program(m).storage.open(a.slot));
    const fromA = addBox(a.doc, 1, 1);
    await a.flush();
    const file = memoryFile("talk.galatsa");
    expect((await b.saveToFile(file)).ok).toBe(true);
    expect(fromA in (await readGalatsaFile(file.bytes!)).snapshot.elements).toBe(true);
  });

  it("a running tab that meets a damaged newest checkpoint keeps the last good copy", async () => {
    const m = machine();
    const pa = program(m);
    const a = await pa.storage.create();
    for (let i = 0; i < 5; i++) addBox(a.doc, i, 0);
    await a.checkpoint();
    const pb = program(m);
    const b = opened(await pb.storage.open(a.slot));
    addBox(b.doc, 0, 9);
    await b.checkpoint();
    const newest = keysUnder(m, keys.checkpoints(a.slot)).at(-1)!;
    m.store.data.set(newest, m.store.data.get(newest)!.slice(0, 40));
    pb.crash(b);
    addBox(a.doc, 9, 9);
    await a.checkpoint();
    const merged = new Y.Doc();
    syncDocs(merged, a.doc);
    syncDocs(merged, b.doc);
    pa.crash(a);
    const top = keysUnder(m, keys.checkpoints(a.slot)).at(-1)!;
    m.store.data.set(top, m.store.data.get(top)!.slice(0, 40));
    const r = await program(m).storage.open(a.slot);
    expect(toSnapshot(opened(r).doc)).toEqual(toSnapshot(merged));
  });

  it("a failed lock query does not make a running session count as stopped", async () => {
    const m = machine();
    const scheduler = new ManualScheduler();
    const flaky = { hold: async () => () => {}, alive: async () => null };
    const running = await storage(m, scheduler, { liveness: flaky }).create();
    addBox(running.doc);
    await scheduler.advance(5 * 60_000);
    const other = storage(m, scheduler, { liveness: flaky });
    expect(await other.deleteDocument(running.slot)).toBe(false);
    expect(await other.recoverable()).toEqual([]);
  });
});

describe("saving to a file", () => {
  it("a download does not count as saved, and says that it cannot be checked", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    const target: FileTarget = {
      name: "talk.galatsa",
      canRead: false,
      read: () => Promise.reject(new Error("no")),
      async write() {},
    };
    const saved = await session.saveToFile(target);
    expect(saved.ok && saved.notices.map((n) => n.code)).toEqual(["save-downloaded"]);
    expect(session.status.unsavedToFile).toBe(true);
    expect(session.status.downloadedAt).not.toBeNull();
    p1.crash(session);
    expect((await program(m).storage.recoverable()).map((o) => o.slot)).toEqual([
      session.slot,
    ]);
  });

  it("a failed download gives its own notice", async () => {
    const session = await program(machine()).storage.create();
    const result = await session.saveToFile({
      name: "talk.galatsa",
      canRead: false,
      read: () => Promise.reject(new Error("no")),
      write: () => Promise.reject(new Error("blocked")),
    });
    expect(!result.ok && result.problem.code).toBe("save-download-failed");
  });

  it("a file that reads back differently is not counted as saved", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    const file = memoryFile("talk.galatsa");
    const bad: FileTarget = {
      name: file.name,
      canRead: true,
      write: (bytes) => file.write(bytes),
      read: async () => {
        const bytes = await file.read();
        bytes[bytes.length >> 1]! ^= 1;
        return bytes;
      },
    };
    const saved = await session.saveToFile(bad);
    expect(saved.ok ? "ok" : saved.problem.code).toBe("save-verify-failed");
    expect(session.status.unsavedToFile).toBe(true);
    p1.crash(session);
    expect((await program(m).storage.recoverable()).map((o) => o.slot)).toEqual([
      session.slot,
    ]);
  });

  it("works when the store cannot be read, with the assets in memory", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    const id = await session.putAsset(new Uint8Array([1, 2, 3]));
    addAsset(session.doc, id, { mediaType: "image/png", byteLength: 3 });
    addElement(session.doc, {
      type: "test.media/image",
      x: 0,
      y: 0,
      size: { w: 5, h: 5 },
      data: { asset: id },
    });
    await session.flush();
    p1.backend.kill();
    const late = addBox(session.doc, 9, 9);
    const file = memoryFile("talk.galatsa");
    const saved = await session.saveToFile(file);
    expect(saved.ok ? "ok" : saved.problem.code).toBe("ok");
    const read = await readGalatsaFile(file.bytes!);
    expect([...read.assets.get(id)!]).toEqual([1, 2, 3]);
    expect(late in read.snapshot.elements).toBe(true);
  });
});

describe("a full store", () => {
  it("does not stop the user from opening recovered work, and says why nothing is saved", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    const expected = toSnapshot(session.doc);
    p1.crash(session);
    const p2 = program(m);
    expect((await p2.storage.recoverable()).map((o) => o.slot)).toEqual([session.slot]);
    m.store.failWrites(1000, "full");
    const result = await p2.storage.open(session.slot);
    expect(toSnapshot(opened(result).doc)).toEqual(expected);
    expect(codes(result)).toContain("storage-full");
    expect(await p2.storage.exportFile(session.slot)).not.toBeNull();
  });

  it("does not stop the user from creating or importing, and stores everything once there is room", async () => {
    const m = machine();
    const p = program(m);
    m.store.failWrites(1000, "full");
    const session = await p.storage.create({ title: "No room" });
    expect(session.status.problem?.code).toBe("storage-full");
    addBox(session.doc, 1, 1);
    const imported = await p.storage.importFile(
      writeGalatsaFile(session.doc, () => undefined).bytes,
    );
    expect(codes(imported)).toContain("storage-full");
    await p.scheduler.advance(3000);
    m.store.failWrites(0);
    addBox(session.doc, 2, 2);
    await p.scheduler.advance(130_000);
    expect(session.status.problem).toBeNull();
    const expected = toSnapshot(session.doc);
    p.crash(session);
    const again = opened(await program(m).storage.open(session.slot));
    expect(toSnapshot(again.doc)).toEqual(expected);
  });
});

describe("the steps of a checkpoint", () => {
  it("flush the journal first: the copy before it then holds every change", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc, 1, 1);
    await session.checkpoint();
    // A change not yet journaled when the checkpoint is asked for.
    addBox(session.doc, 2, 2);
    await session.checkpoint();
    const expected = toSnapshot(session.doc);
    p1.crash(session);
    const newest = keysUnder(m, keys.checkpoints(session.slot)).at(-1)!;
    m.store.data.set(newest, m.store.data.get(newest)!.slice(0, 30));
    expect(toSnapshot(opened(await program(m).storage.open(session.slot)).doc)).toEqual(
      expected,
    );
  });

  it("a checkpoint from the timer also flushes the journal first", async () => {
    const m = machine();
    const p1 = program(m, { journalDelay: 60_000, journalMaxDelay: 60_000 });
    const session = await p1.storage.create();
    addBox(session.doc, 1, 1);
    await p1.scheduler.advance(61_000);
    addBox(session.doc, 2, 2);
    // The journal timer is far off; the checkpoint timer comes first.
    await p1.scheduler.advance(35_000);
    expect(keysUnder(m, keys.checkpoints(session.slot)).at(-1)).toBe(
      keys.checkpoint(session.slot, 4),
    );
    const expected = toSnapshot(session.doc);
    p1.crash(session);
    const newest = keysUnder(m, keys.checkpoints(session.slot)).at(-1)!;
    m.store.data.set(newest, m.store.data.get(newest)!.slice(0, 30));
    expect(toSnapshot(opened(await program(m).storage.open(session.slot)).doc)).toEqual(
      expected,
    );
  });

  it("a checkpoint that reads back differently is reported, and nothing is removed for it", async () => {
    const m = machine();
    const inner = m.store.backend();
    let corrupt = false;
    const backend: StorageBackend = {
      ...inner,
      name: inner.name,
      read: (key) => inner.read(key),
      list: (prefix) => inner.list(prefix),
      write: (key, bytes) => inner.write(key, bytes),
      remove: (keys) => inner.remove(keys),
      async create(key, bytes) {
        if (corrupt && key.includes("/cp/")) {
          const bad = bytes.slice();
          bad[bad.length - 1]! ^= 0xff;
          return inner.create(key, bad);
        }
        return inner.create(key, bytes);
      },
    };
    const scheduler = new ManualScheduler();
    const s = new DocumentStorage({
      backend,
      liveness: m.liveness,
      channels: null,
      scheduler,
      lifecycle: false,
    });
    const session = await s.create();
    addBox(session.doc, 1, 1);
    await session.flush();
    const before = keysUnder(m, keys.slot(session.slot)).filter(
      (k) => !k.includes("/s/"),
    );
    corrupt = true;
    await expect(session.checkpoint()).rejects.toThrow();
    expect(session.status.problem?.code).toBe("autosave-failed");
    const after = keysUnder(m, keys.slot(session.slot)).filter((k) => !k.includes("/s/"));
    for (const key of before)
      if (key.includes("/cp/") || key.includes("/j/")) {
        expect(after).toContain(key);
      }
  });
});

describe("discarding", () => {
  it("a recovery offer for a document never saved to a file cannot be discarded by accident", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create({ title: "Hours of work" });
    for (let i = 0; i < 10; i++) addBox(session.doc, i, i);
    await session.close();
    const p2 = program(m);
    const s2 = opened(await p2.storage.open(session.slot));
    addBox(s2.doc, 99, 99);
    await s2.flush();
    p2.crash(s2);
    const p3 = program(m);
    const [offer] = await p3.storage.recoverable();
    expect(offer?.fileName).toBeNull();
    expect(await p3.storage.discardChanges(offer!.slot)).toBe("no-file");
    expect((await p3.storage.list()).map((d) => d.slot)).toContain(session.slot);
  });
});

describe("merge identity", () => {
  it("survives checkpoints and reopenings in random scenarios", async () => {
    const lost: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const states: Y.Doc[] = [];
      runScenario(seed, { checkpoint: (doc) => states.push(doc) });
      const m = machine();
      let p = program(m);
      let session = opened(
        await p.storage.importFile(writeGalatsaFile(states[0]!, () => undefined).bytes),
      );
      const lineage = lineageOf(session.doc);
      for (const [i, replica] of states.entries()) {
        syncInto(session.doc, replica);
        await session.checkpoint();
        if (i % 2 === 1) {
          p.crash(session);
          p = program(m);
          const r = await p.storage.open(session.slot);
          session = opened(r);
          if (lineageOf(session.doc) !== lineage || codes(r).length > 0) {
            lost.push(`seed ${seed} step ${i}: ${codes(r).join(",")}`);
            break;
          }
        }
      }
    }
    expect(lost).toEqual([]);
  }, 120_000);
});

/** Three sessions racing, some stopped in the middle of a write. */
async function race(seed: number, tear: boolean) {
  const m = machine();
  let x = seed * (tear ? 104729 : 7919);
  const random = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  m.store.beforeOperation = async () => {
    const turns = Math.floor(random() * 4);
    for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const programs = [program(m), program(m), program(m)];
  const first = await programs[0]!.storage.create();
  const sessions = [first];
  for (const p of programs.slice(1))
    sessions.push(opened(await p.storage.open(first.slot)));
  for (let round = 0; round < 6; round++) {
    if (tear && random() < 0.3) {
      m.store.tearNextWrite(
        random() < 0.5 ? Number.MAX_SAFE_INTEGER - 1 : Math.floor(random() * 400),
      );
    }
    for (const s of sessions) {
      addBox(s.doc, round, seed);
      if (random() < 0.5) setTitle(s.doc, `title ${round}`);
    }
    await Promise.all(
      sessions.map((s) => (random() < 0.6 ? s.checkpoint() : s.flush()).catch(() => {})),
    );
  }
  await Promise.all(sessions.map((s) => s.flush().catch(() => false)));
  sessions.forEach((s, i) => programs[i]!.crash(s));
  m.store.beforeOperation = null;
  return { m, first, sessions };
}

describe(`the last good copy after racing sessions: ${SEEDS} seeds from ${FIRST}`, () => {
  it("the copy before the newest one and the journal give everything", async () => {
    const failures: string[] = [];
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
      const { m, first, sessions } = await race(seed, false);
      const merged = new Y.Doc();
      for (const s of sessions) syncDocs(merged, s.doc);
      const newest = keysUnder(m, keys.checkpoints(first.slot)).at(-1)!;
      m.store.data.set(newest, m.store.data.get(newest)!.slice(0, 50));
      const result = await program(m).storage.open(first.slot);
      if (!result.ok) failures.push(`seed ${seed}: ${result.problem.code}`);
      else if (
        JSON.stringify(toSnapshot(result.session.doc)) !==
        JSON.stringify(toSnapshot(merged))
      ) {
        failures.push(`seed ${seed}: differs`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("with programs stopped in the middle of writes, opening the copy before the newest gives what opening the newest gives", async () => {
    const failures: string[] = [];
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
      const { m, first } = await race(seed, true);
      const copy = machine();
      for (const [k, v] of m.store.data) copy.store.data.set(k, v.slice());
      const intact = await program(m).storage.open(first.slot);
      const cps = keysUnder(copy, keys.checkpoints(first.slot));
      const newest = cps.at(-1)!;
      copy.store.data.set(newest, copy.store.data.get(newest)!.slice(0, 50));
      const damaged = await program(copy).storage.open(first.slot);
      if (!intact.ok || !damaged.ok) {
        failures.push(`seed ${seed}: ${codes(intact).join()} / ${codes(damaged).join()}`);
        continue;
      }
      if (
        JSON.stringify(toSnapshot(intact.session.doc)) !==
        JSON.stringify(toSnapshot(damaged.session.doc))
      ) {
        failures.push(`seed ${seed}: differs (${cps.length} checkpoints)`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
