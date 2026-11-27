// SPDX-License-Identifier: GPL-3.0-or-later

// The flows the editor builds on: closing a document, discarding changes,
// downloads, a store that hangs, and telling running sessions from stopped ones.

import { toSnapshot } from "@galatsa/core/ydoc";
import { readGalatsaFile, writeGalatsaFile } from "@galatsa/format";
import { createI18n } from "@galatsa/i18n";
import { describe, expect, it, vi } from "vitest";
import { webLocksLiveness } from "./environment.ts";
import { memoryFile, type FileTarget } from "./files.ts";
import { keys } from "./layout.ts";
import { storageMessages } from "./messages/index.ts";
import type { StorageSession } from "./session.ts";
import type { OpenResult } from "./storage.ts";
import { addBox, machine, program } from "./test-helpers.ts";

function opened(result: OpenResult): StorageSession {
  if (!result.ok) throw new Error(`open failed: ${result.problem.code}`);
  return result.session;
}

const download = (name: string): FileTarget => ({
  name,
  canRead: false,
  read: () => Promise.reject(new Error("no")),
  async write() {},
});

describe("closing", () => {
  it("says when changes could not be stored, and keeps the session open for saving as a file", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create({ title: "Work" });
    addBox(session.doc);
    await session.flush();
    m.store.failWrites(1_000_000, "full");
    const late = addBox(session.doc, 5, 5);
    const result = await session.close();
    expect(result).toMatchObject({ ok: false, closed: false });
    expect(!result.ok && result.problem.code).toBe("storage-full");
    expect(session.closed).toBe(false);
    // The way out: save as a file, then close anyway.
    const file = memoryFile("work.galatsa");
    expect((await session.saveToFile(file)).ok).toBe(true);
    expect(late in (await readGalatsaFile(file.bytes!)).snapshot.elements).toBe(true);
    const forced = await session.close({ evenIfUnstored: true });
    expect(forced).toMatchObject({ ok: false, closed: true });
    expect(session.closed).toBe(true);
  });

  it("closes cleanly when everything is stored", async () => {
    const m = machine();
    const session = await program(m).storage.create();
    addBox(session.doc);
    expect(await session.close()).toEqual({ ok: true, closed: true });
    expect(await program(m).storage.recoverable()).toEqual([]);
  });

  it("does not wait for ever on a store that does not answer", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    addBox(session.doc);
    await session.flush();
    m.store.beforeOperation = async (operation) => {
      if (operation === "write" || operation === "create") await new Promise(() => {});
    };
    addBox(session.doc, 3, 3);
    let result: Awaited<ReturnType<StorageSession["close"]>> | null = null;
    void session.close().then((r) => (result = r));
    await p.scheduler.advance(100_000);
    expect(result).toMatchObject({ ok: false, closed: false });
  });
});

describe("saving to a file with a store that does not answer", () => {
  it("finishes from memory", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    addBox(session.doc);
    await session.flush();
    m.store.beforeOperation = async (operation) => {
      if (operation === "write" || operation === "create") await new Promise(() => {});
    };
    const late = addBox(session.doc, 3, 3);
    const file = memoryFile("talk.galatsa");
    let finished: boolean | null = null;
    void session.saveToFile(file).then((r) => (finished = r.ok));
    await p.scheduler.advance(60_000);
    expect(finished).toBe(true);
    expect(late in (await readGalatsaFile(file.bytes!)).snapshot.elements).toBe(true);
  });
});

describe("downloads and discarding", () => {
  it("the recovery offer says when the file was last saved and when it was downloaded", async () => {
    const m = machine();
    const p1 = program(m);
    const source = await p1.storage.create({ title: "Talk" });
    addBox(source.doc);
    const bytes = writeGalatsaFile(source.doc, () => undefined).bytes;
    await source.close();
    const session = opened(await p1.storage.importFile(bytes, { name: "talk.galatsa" }));
    const openedAt = p1.scheduler.now();
    let downloadedAt = 0;
    for (let i = 0; i < 3; i++) {
      p1.scheduler.time += 3_600_000;
      addBox(session.doc, i, i);
      downloadedAt = p1.scheduler.now();
      expect((await session.saveToFile(download("talk.galatsa"))).ok).toBe(true);
    }
    addBox(session.doc, 9, 9);
    await session.flush();
    p1.crash(session);
    const [offer] = await program(m).storage.recoverable();
    expect(offer?.savedToFileAt).toBe(openedAt);
    expect(offer?.downloadedAt).toBe(downloadedAt);
    // What the editor shows before discarding names the time of the last save.
    const i18n = createI18n({ dev: true, locale: "en" });
    const text = i18n.translator(storageMessages)("recovery.discardChanges.detail", {
      name: offer!.fileName!,
      when: offer!.savedToFileAt!,
    });
    expect(text).toContain(i18n.formatDate(openedAt, { timeStyle: "short" }));
  });

  it("a new document that was only downloaded cannot be discarded (a download is not a save)", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create({ title: "Hours of work" });
    addBox(session.doc);
    expect((await session.saveToFile(download("talk.galatsa"))).ok).toBe(true);
    addBox(session.doc, 2, 2);
    await session.flush();
    p1.crash(session);
    const p2 = program(m);
    const [offer] = await p2.storage.recoverable();
    expect(offer?.fileName).toBe("talk.galatsa");
    expect(offer?.savedToFileAt).toBeNull();
    const result = await p2.storage.discardChanges(
      offer!.slot,
      memoryFile("talk.galatsa"),
    );
    expect(result).toEqual({ ok: false, reason: "no-file" });
    expect((await p2.storage.list()).map((d) => d.slot)).toContain(session.slot);
  });

  it("after 'keep, but don't ask again', a document with changes not in its file opens as unsaved", async () => {
    const m = machine();
    const p1 = program(m);
    const source = await p1.storage.create({ title: "Talk" });
    addBox(source.doc);
    const bytes = writeGalatsaFile(source.doc, () => undefined).bytes;
    await source.close();
    const session = opened(await p1.storage.importFile(bytes, { name: "talk.galatsa" }));
    p1.scheduler.time += 5000;
    const work = addBox(session.doc, 7, 7);
    await session.flush();
    p1.crash(session);
    const p2 = program(m);
    p2.scheduler.time = p1.scheduler.time;
    const [offer] = await p2.storage.recoverable();
    expect(offer?.slot).toBe(session.slot);
    await p2.storage.dismiss(offer!.slot);
    expect(await p2.storage.recoverable()).toEqual([]);
    const again = opened(await p2.storage.open(session.slot));
    expect(work in toSnapshot(again.doc).elements).toBe(true);
    expect(again.status.unsavedToFile).toBe(true);
  });
});

describe("running or stopped", () => {
  it("webLocksLiveness cannot tell (null) when the lock query fails", async () => {
    const locks = {
      request: (_name: string, callback: () => Promise<void>) => callback(),
      query: () => Promise.reject(new Error("broken")),
    };
    vi.stubGlobal("navigator", { locks });
    try {
      const liveness = webLocksLiveness();
      expect(liveness).not.toBeNull();
      expect(await liveness!.alive(["a"])).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a session record that cannot be read counts as running", async () => {
    const m = machine();
    const p1 = program(m, {}, { heartbeats: true });
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    p1.crash(session);
    m.store.data.set(
      keys.session(session.slot, session.id),
      new Uint8Array([0x7b, 0x7b]),
    );
    const p2 = program(m, {}, { heartbeats: true });
    p2.scheduler.time = p1.scheduler.time + 10 * 60_000;
    expect(await p2.storage.recoverable()).toEqual([]);
    expect(await p2.storage.deleteDocument(session.slot)).toBe(false);
    expect((await p2.storage.list())[0]?.open).toBe(true);
  });

  it("a document deleted while it is opened is written again whole, before its next checkpoint is due", async () => {
    const m = machine();
    const p1 = program(m);
    const first = await p1.storage.create({ title: "Talk" });
    addBox(first.doc);
    await first.close();
    const slot = first.slot;
    m.store.beforeOperation = async (operation, key) => {
      if (operation === "write" && key.includes("/s/")) {
        m.store.beforeOperation = null;
        // Another program deletes the document while this one opens it.
        for (const k of [...m.store.data.keys()]) {
          if (k.startsWith(`doc/${slot}/`)) m.store.data.delete(k);
        }
      }
    };
    const p2 = program(m);
    const session = opened(await p2.storage.open(slot));
    const work = addBox(session.doc, 4, 4);
    await p2.scheduler.advance(5000);
    p2.crash(session);
    const again = opened(await program(m).storage.open(slot));
    expect(work in toSnapshot(again.doc).elements).toBe(true);
  });
});

describe("the recovery texts", () => {
  it("have every value filled in, in both languages", () => {
    const warnings: string[] = [];
    for (const locale of ["nb", "en"] as const) {
      const i18n = createI18n({ dev: true, locale, warn: (w) => warnings.push(w) });
      const t = i18n.translator(storageMessages);
      const values = {
        title: "Talk",
        name: "talk.galatsa",
        when: Date.UTC(2026, 10, 27, 9),
      };
      for (const key of Object.keys(storageMessages.messages.en)) {
        if (!key.startsWith("recovery.") && !key.startsWith("lastGood.")) continue;
        const text = t(key as Parameters<typeof t>[0], values);
        expect(text, `${locale} ${key}`).not.toMatch(/⟦|\{/);
      }
    }
    expect(warnings).toEqual([]);
  });
});
