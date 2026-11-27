// SPDX-License-Identifier: GPL-3.0-or-later

import { revisionOf, roots, setTitle, syncDocs, toSnapshot } from "@galatsa/core/ydoc";
import { readGalatsaFile, writeGalatsaFile } from "@galatsa/format";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { frameCheckpoint, loadCheckpoint } from "./checkpoint.ts";
import { memoryChannels } from "./environment.ts";
import { memoryFile } from "./files.ts";
import { keys } from "./layout.ts";
import type { StorageSession } from "./session.ts";
import type { OpenResult } from "./storage.ts";
import { addBox, machine, nudge, program, settle } from "./test-helpers.ts";

function opened(result: OpenResult): StorageSession {
  if (!result.ok) throw new Error(`open failed: ${result.problem.code}`);
  return result.session;
}

function journalKeys(m: ReturnType<typeof machine>, slot: string): string[] {
  return [...m.store.data.keys()].filter((k) => k.startsWith(keys.journal(slot)));
}

function checkpointKeys(m: ReturnType<typeof machine>, slot: string): string[] {
  return [...m.store.data.keys()]
    .filter((k) => k.startsWith(keys.checkpoints(slot)))
    .sort();
}

describe("storing and reopening", () => {
  it("gives back the same document after a clean close", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create({ title: "Talk" });
    const a = addBox(session.doc, 10, 20);
    addBox(session.doc, 30, 40);
    nudge(session.doc, a, 5);
    const expected = toSnapshot(session.doc);
    await session.close();
    expect(session.closed).toBe(true);

    const p2 = program(m);
    expect(await p2.storage.recoverable()).toEqual([]);
    const [stored] = await p2.storage.list();
    expect(stored?.title).toBe("Talk");
    const again = opened(await p2.storage.open(stored!.slot));
    expect(toSnapshot(again.doc)).toEqual(expected);
  });

  it("journals changes shortly after they are made, and folds them into checkpoints", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const slot = session.slot;
    addBox(session.doc);
    await p.scheduler.advance(100);
    expect(journalKeys(m, slot)).toHaveLength(0);
    await p.scheduler.advance(300);
    expect(journalKeys(m, slot)).toHaveLength(1);

    // Steady editing: entries at least once a second.
    const id = addBox(session.doc);
    for (let i = 0; i < 30; i++) {
      nudge(session.doc, id, i);
      await p.scheduler.advance(100);
    }
    expect(journalKeys(m, slot).length).toBeGreaterThanOrEqual(3);
    expect(session.status.lastStoredAt).not.toBeNull();

    // A pause after enough time: a checkpoint, and the journal it replaces
    // stays until the next one (the last good copy needs it).
    // A new document has two checkpoints from the start: a last good copy.
    expect(checkpointKeys(m, slot)).toHaveLength(2);
    await p.scheduler.advance(30_000);
    expect(checkpointKeys(m, slot)).toHaveLength(2);
    expect(checkpointKeys(m, slot).at(-1)).toBe(keys.checkpoint(slot, 3));
    const before = journalKeys(m, slot).length;
    expect(before).toBeGreaterThan(0);
    addBox(session.doc);
    await p.scheduler.advance(35_000);
    expect(checkpointKeys(m, slot)).toHaveLength(2);
    expect(journalKeys(m, slot).length).toBe(1);
    await session.close();
  });

  it("attaches work tracking before the first change", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const id = addBox(session.doc);
    await session.close();
    const again = opened(await program(m).storage.open(session.slot));
    // An edit through an editor binding (not an operation) is still work.
    const record = roots(again.doc).elements.get(id) as Y.Map<unknown>;
    const before = JSON.stringify(revisionOf(record));
    again.doc.transact(() => record.set("name", "renamed"), "test-binding");
    expect(JSON.stringify(revisionOf(record))).not.toBe(before);
  });

  it("stores assets apart from checkpoints and saves them into files", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const id = await session.putAsset(bytes);
    const { addAsset, addElement } = await import("@galatsa/core/ydoc");
    addAsset(session.doc, id, { mediaType: "image/png", byteLength: 5 });
    addElement(session.doc, {
      type: "test.media/image",
      x: 0,
      y: 0,
      size: { w: 5, h: 5 },
      data: { asset: id },
    });
    const file = memoryFile("talk.galatsa");
    const saved = await session.saveToFile(file);
    expect(saved.ok).toBe(true);
    expect(session.status.unsavedToFile).toBe(false);
    expect(session.status.fileName).toBe("talk.galatsa");
    const read = await readGalatsaFile(file.bytes!);
    expect([...read.assets.get(id)!]).toEqual([...bytes]);
    // Opening that file as a new document keeps the asset in the store.
    const p2 = program(m);
    const reopened = opened(await p2.storage.openFile(file));
    expect([...(await reopened.getAsset(id))!]).toEqual([...bytes]);
    await reopened.close();
    // A damaged asset in the store is not handed out.
    m.store.data.set(keys.asset(reopened.slot, id), new Uint8Array([9, 9]));
    const fresh = opened(await program(m).storage.open(reopened.slot));
    expect(await fresh.getAsset(id)).toBeUndefined();
  });
});

describe("recovery after a crash", () => {
  it("offers the work at the next start, as far as it was journaled", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create({ title: "Unsaved" });
    const a = addBox(session.doc);
    nudge(session.doc, a, 40);
    await p1.scheduler.advance(1000);
    const expected = toSnapshot(session.doc);
    // Changes in the last fraction of a second before the crash are lost.
    addBox(session.doc);
    p1.crash(session);

    const p2 = program(m);
    const offers = await p2.storage.recoverable();
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      slot: session.slot,
      title: "Unsaved",
      unsaved: true,
    });
    const restored = opened(await p2.storage.open(offers[0]!.slot));
    expect(toSnapshot(restored.doc)).toEqual(expected);
    // Once restored, it is no longer offered.
    expect(await p2.storage.recoverable()).toEqual([]);
  });

  it("does not offer a session that is still running in another tab", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    const p2 = program(m);
    expect(await p2.storage.recoverable()).toEqual([]);
    expect((await p2.storage.list())[0]?.open).toBe(true);
  });

  it("tells running from stopped sessions by heartbeats where locks are missing", async () => {
    const m = machine();
    const timing = { heartbeatInterval: 1000, staleAfter: 5000 };
    const p1 = program(m, timing, { heartbeats: true });
    const session = await p1.storage.create();
    addBox(session.doc);
    await p1.scheduler.advance(3000);
    const p2 = program(m, timing, { heartbeats: true });
    p2.scheduler.time = p1.scheduler.time;
    expect(await p2.storage.recoverable()).toEqual([]);
    p1.crash(session);
    p2.scheduler.time += 6000;
    expect(await p2.storage.recoverable()).toHaveLength(1);
  });

  it("does not offer a document whose changes were saved to its file", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    expect((await session.saveToFile(memoryFile("a.galatsa"))).ok).toBe(true);
    p1.crash(session);
    expect(await program(m).storage.recoverable()).toEqual([]);
  });

  it("keeps the previous entries when a journal write is torn, and says so", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    const expected = toSnapshot(session.doc);
    addBox(session.doc, 5, 5);
    m.store.tearNextWrite(25);
    await p1.scheduler.advance(1000);
    p1.crash(session);
    const result = await program(m).storage.open(session.slot);
    const restored = opened(result);
    expect(toSnapshot(restored.doc)).toEqual(expected);
    if (result.ok) expect(result.notices.map((n) => n.code)).toContain("changes-lost");
  });

  it("survives a checkpoint torn at any position", async () => {
    // One document, then the same crash at many cut positions.
    for (const cut of [0, 1, 10, 19, 20, 21, 40, 100, 300, 1000, 2000, 5000, -1]) {
      const m = machine();
      const p1 = program(m);
      const session = await p1.storage.create({ title: "Cut" });
      for (let i = 0; i < 20; i++) addBox(session.doc, i * 10, 0);
      await session.checkpoint();
      for (let i = 0; i < 5; i++) addBox(session.doc, 0, i * 10);
      await session.flush();
      const expected = toSnapshot(session.doc);
      m.store.tearNextWrite(cut < 0 ? Number.MAX_SAFE_INTEGER - 1 : cut);
      await session.checkpoint().catch(() => {});
      p1.crash(session);

      const p2 = program(m);
      const result = await p2.storage.open(session.slot);
      const restored = opened(result);
      expect(toSnapshot(restored.doc), `cut at ${cut}`).toEqual(expected);
      if (cut >= 0 && result.ok) {
        expect(
          result.notices.map((n) => n.code),
          `cut at ${cut}`,
        ).toContain("restored-previous-copy");
      }
      // The damaged checkpoint is replaced at once.
      await settle();
      const reopened = opened(await program(m).storage.open(session.slot));
      expect(toSnapshot(reopened.doc)).toEqual(expected);
    }
  });

  it("restores from the previous checkpoint when the newest one is damaged later", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    for (let i = 0; i < 10; i++) addBox(session.doc, i, i);
    await session.checkpoint();
    for (let i = 0; i < 10; i++) addBox(session.doc, -i, i);
    await session.checkpoint();
    addBox(session.doc, 99, 99);
    await session.flush();
    const expected = toSnapshot(session.doc);
    p1.crash(session);
    const newest = checkpointKeys(m, session.slot).at(-1)!;
    const whole = m.store.data.get(newest)!;
    expect(checkpointKeys(m, session.slot)).toHaveLength(2);
    for (
      let cut = 0;
      cut < whole.length;
      cut += Math.max(1, Math.floor(whole.length / 60))
    ) {
      const copy = machine();
      for (const [k, v] of m.store.data) copy.store.data.set(k, v.slice());
      copy.store.data.set(newest, whole.slice(0, cut));
      const result = await program(copy).storage.open(session.slot);
      expect(toSnapshot(opened(result).doc), `cut at ${cut}`).toEqual(expected);
    }
    // A flipped byte instead of a cut.
    const flipped = whole.slice();
    flipped[Math.floor(flipped.length / 2)]! ^= 0xff;
    m.store.data.set(newest, flipped);
    const result = await program(m).storage.open(session.slot);
    expect(toSnapshot(opened(result).doc)).toEqual(expected);
  });

  it("opens a checkpoint without usable Yjs state from its document, and says what was lost", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc, 1, 1);
    await session.checkpoint();
    const expected = toSnapshot(session.doc);
    addBox(session.doc, 2, 2);
    await session.flush();
    p1.crash(session);
    // Every checkpoint loses its ydoc.bin (as if that entry were damaged).
    for (const key of checkpointKeys(m, session.slot)) {
      const loaded = (await loadCheckpoint(m.store.data.get(key)!))!;
      const file = writeGalatsaFile(loaded.doc, () => undefined, {
        includeYdoc: false,
      }).bytes;
      m.store.data.set(
        key,
        frameCheckpoint(loaded.header, { file, keepState: false }, new Uint8Array(0)),
      );
    }
    const result = await program(m).storage.open(session.slot);
    const restored = opened(result);
    const codes = result.ok ? result.notices.map((n) => n.code) : [];
    expect(codes).toContain("restored-previous-copy");
    expect(codes).toContain("changes-lost");
    expect(Object.keys(toSnapshot(restored.doc).elements).sort()).toEqual(
      Object.keys(expected.elements).sort(),
    );
    // From here on it is an ordinary document again.
    addBox(restored.doc, 3, 3);
    const later = toSnapshot(restored.doc);
    await restored.close();
    expect(toSnapshot(opened(await program(m).storage.open(session.slot)).doc)).toEqual(
      later,
    );
  });

  it("refuses with a clear notice when every stored copy is damaged", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.close();
    for (const key of checkpointKeys(m, session.slot)) {
      m.store.data.set(key, m.store.data.get(key)!.slice(0, 30));
    }
    const result = await program(m).storage.open(session.slot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe("stored-damaged");
    const missing = await program(m).storage.open("nothing");
    expect(!missing.ok && missing.problem.code).toBe("stored-missing");
  });

  it("keeps changes in memory while the store fails, and stores them later", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const seen: string[] = [];
    session.subscribe((status) => seen.push(status.problem?.code ?? "ok"));
    m.store.failWrites(3, "full");
    addBox(session.doc);
    await p.scheduler.advance(1000);
    expect(session.status.problem?.code).toBe("storage-full");
    expect(session.status.pending).toBe(true);
    await p.scheduler.advance(20_000);
    expect(session.status.problem).toBeNull();
    expect(session.status.pending).toBe(false);
    expect(seen).toContain("storage-full");
    const expected = toSnapshot(session.doc);
    p.crash(session);
    expect(toSnapshot(opened(await program(m).storage.open(session.slot)).doc)).toEqual(
      expected,
    );
  });
});

describe("the user's file", () => {
  it("gives a clear notice and the last good copy for a file torn in the middle of a save", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create({ title: "Torn" });
    for (let i = 0; i < 8; i++) addBox(session.doc, i * 20, 0);
    const file = memoryFile("torn.galatsa");
    expect((await session.saveToFile(file)).ok).toBe(true);
    addBox(session.doc, 0, 100);
    const expected = toSnapshot(session.doc);
    const whole = writeGalatsaFile(session.doc, () => undefined).bytes;
    file.tearNextWrite(Math.floor(whole.length / 2));
    const failed = await session.saveToFile(file);
    expect(!failed.ok && failed.problem.code).toBe("save-failed");
    expect(session.status.unsavedToFile).toBe(true);
    await session.flush();
    p1.crash(session);

    const p2 = program(m);
    const codes = new Set<string>();
    for (
      let cut = 0;
      cut < whole.length;
      cut += Math.max(1, Math.floor(whole.length / 80))
    ) {
      const torn = memoryFile("torn.galatsa", whole.slice(0, cut));
      const result = await p2.storage.openFile(torn);
      expect(result.ok, `cut at ${cut}`).toBe(false);
      if (result.ok) continue;
      codes.add(result.problem.code);
      expect(["file-damaged", "file-not-galatsa"], `cut at ${cut}`).toContain(
        result.problem.code,
      );
      expect(
        result.lastGood.map((d) => d.slot),
        `cut at ${cut}`,
      ).toEqual([session.slot]);
    }
    expect(codes.has("file-damaged")).toBe(true);
    // The copy offered is the latest work, with the change the torn save lost.
    const result = await p2.storage.openFile(
      memoryFile("torn.galatsa", whole.slice(0, 100)),
    );
    if (result.ok) throw new Error("expected a failure");
    const copy = opened(await p2.storage.open(result.lastGood[0]!.slot));
    expect(toSnapshot(copy.doc)).toEqual(expected);
    // The whole file opens.
    expect((await p2.storage.openFile(memoryFile("torn.galatsa", whole))).ok).toBe(true);
  });

  it("never changes the file when a save fails before writing", async () => {
    const m = machine();
    const session = await program(m).storage.create();
    addBox(session.doc);
    const file = memoryFile("x.galatsa");
    await session.saveToFile(file);
    const before = file.bytes!.slice();
    addBox(session.doc);
    file.failNextWrite();
    const result = await session.saveToFile(file);
    expect(result.ok).toBe(false);
    expect([...file.bytes!]).toEqual([...before]);
  });

  it("says why a file is refused", async () => {
    const m = machine();
    const p = program(m);
    const notZip = await p.storage.importFile(new Uint8Array([1, 2, 3]), {
      name: "a.txt",
    });
    expect(!notZip.ok && notZip.problem.code).toBe("file-not-galatsa");
    expect(!notZip.ok && notZip.problem.values?.["name"]).toBe("a.txt");
    const unreadable = await p.storage.openFile({
      name: "gone.galatsa",
      read: () => Promise.reject(new Error("gone")),
    });
    expect(!unreadable.ok && unreadable.problem.code).toBe("file-unreadable");
  });
});

describe("several tabs with the same document", () => {
  for (const live of [true, false]) {
    it(`merge their work instead of overwriting it (${live ? "with" : "without"} a channel)`, async () => {
      const m = machine(live ? memoryChannels() : null);
      const pa = program(m);
      const pb = program(m);
      const a = await pa.storage.create({ title: "Shared" });
      const b = opened(await pb.storage.open(a.slot));
      const ids: string[] = [];
      for (let round = 0; round < 4; round++) {
        ids.push(addBox(a.doc, round, 0), addBox(b.doc, 0, round));
        await Promise.all([a.flush(), b.flush()]);
        await settle();
        if (round % 2 === 1) await Promise.all([a.checkpoint(), b.checkpoint()]);
      }
      if (live) {
        // The other tab shows the changes as soon as they are stored.
        expect(Object.keys(toSnapshot(a.doc).elements).sort()).toEqual(
          Object.keys(toSnapshot(b.doc).elements).sort(),
        );
      }
      await Promise.all([a.checkpoint(), b.checkpoint()]);
      pa.crash(a);
      pb.crash(b);
      const merged = new Y.Doc();
      syncDocs(merged, a.doc);
      syncDocs(merged, b.doc);
      const reopened = opened(await program(m).storage.open(a.slot));
      const elements = Object.keys(toSnapshot(reopened.doc).elements);
      for (const id of ids) expect(elements).toContain(id);
      expect(toSnapshot(reopened.doc)).toEqual(toSnapshot(merged));
    });
  }

  it("lose nothing when checkpoints race at every interleaving", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const m = machine();
      let x = seed * 7919;
      const random = () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        return x / 0x7fffffff;
      };
      // Every operation waits a random number of turns: the sessions interleave.
      m.store.beforeOperation = async () => {
        const turns = Math.floor(random() * 4);
        for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
      };
      const programs = [program(m), program(m), program(m)];
      const first = await programs[0]!.storage.create();
      const sessions = [first];
      for (const p of programs.slice(1))
        sessions.push(opened(await p.storage.open(first.slot)));
      for (let round = 0; round < 5; round++) {
        for (const s of sessions) {
          addBox(s.doc, round, seed);
          if (random() < 0.5) setTitle(s.doc, `title ${round}`);
        }
        await Promise.all(
          sessions.map((s) => (random() < 0.6 ? s.checkpoint() : s.flush())),
        );
      }
      await Promise.all(sessions.map((s) => s.flush()));
      sessions.forEach((s, i) => programs[i]!.crash(s));
      m.store.beforeOperation = null;
      const merged = new Y.Doc();
      for (const s of sessions) syncDocs(merged, s.doc);
      const reopened = opened(await program(m).storage.open(first.slot));
      expect(toSnapshot(reopened.doc), `seed ${seed}`).toEqual(toSnapshot(merged));
      expect(checkpointKeys(m, first.slot).length, `seed ${seed}`).toBeLessThanOrEqual(3);
    }
  }, 60_000);
});

describe("dismissing and discarding", () => {
  it("stops offering, and deletes only when no session has the document open", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    await session.flush();
    const p2 = program(m);
    expect(await p2.storage.deleteDocument(session.slot)).toBe(false);
    p1.crash(session);
    expect(await p2.storage.recoverable()).toHaveLength(1);
    await p2.storage.dismiss(session.slot);
    expect(await p2.storage.recoverable()).toEqual([]);
    expect(await p2.storage.list()).toHaveLength(1);
    const exported = await p2.storage.exportFile(session.slot);
    expect((await readGalatsaFile(exported!)).snapshot).toEqual(toSnapshot(session.doc));
    // Never saved to a file: discarding the changes would delete it all.
    expect(await p2.storage.discardChanges(session.slot)).toBe("no-file");
    expect(await p2.storage.list()).toHaveLength(1);
    expect(await p2.storage.deleteDocument(session.slot)).toBe(true);
    expect(await p2.storage.list()).toEqual([]);
    expect(m.store.data.size).toBe(0);
  });

  it("discards the changes of a document that has a file, and the file stays", async () => {
    const m = machine();
    const p1 = program(m);
    const session = await p1.storage.create();
    addBox(session.doc);
    const file = memoryFile("talk.galatsa");
    expect((await session.saveToFile(file)).ok).toBe(true);
    const saved = file.bytes!.slice();
    addBox(session.doc, 5, 5);
    await session.flush();
    const p2 = program(m);
    expect(await p2.storage.discardChanges(session.slot)).toBe("open");
    p1.crash(session);
    const [offer] = await p2.storage.recoverable();
    expect(offer?.fileName).toBe("talk.galatsa");
    expect(await p2.storage.discardChanges(offer!.slot)).toBe("discarded");
    expect(await p2.storage.list()).toEqual([]);
    expect([...file.bytes!]).toEqual([...saved]);
  });
});
