// SPDX-License-Identifier: GPL-3.0-or-later

// Closing a document with the offer to save as a file first, the save status,
// and asking for persistent storage (docs/adr/0006, section 7.1).

import { addElement } from "@galatsa/core/ydoc";
import {
  DocumentStorage,
  createMemoryStore,
  memoryFile,
  memoryLiveness,
  type MemoryStore,
} from "@galatsa/storage";
import { describe, expect, it, vi } from "vitest";
import { EditorDocument, statusMessage } from "./document.ts";
import { registerEditorMessages } from "./extensions.ts";
import { testI18n } from "./test-support.ts";

function setup(store: MemoryStore = createMemoryStore()) {
  const storage = new DocumentStorage({
    backend: store.backend(),
    liveness: memoryLiveness(),
    channels: null,
    lifecycle: false,
    timing: { storeWait: 200, closeWait: 500 },
  });
  const i18n = testI18n();
  registerEditorMessages(i18n);
  return { store, storage, i18n };
}

function addBox(doc: import("yjs").Doc): void {
  addElement(doc, {
    type: "test/box",
    typeVersion: 1,
    parent: null,
    x: 0,
    y: 0,
    size: { w: 10, h: 10 },
    data: {},
  });
}

describe("closing a document", () => {
  it("closes when everything is stored, showing that closing goes on", async () => {
    const { storage, i18n } = setup();
    const session = await storage.create({ title: "Talk" });
    const persist = vi.fn(async () => true);
    const doc = new EditorDocument(session, {
      i18n,
      requestPersistence: persist,
      warnOnUnload: false,
    });
    const phases: string[] = [];
    doc.subscribe((s) => phases.push(s.phase));
    addBox(session.doc);
    const closed = await doc.close();
    expect(closed).toBe("closed");
    expect(phases).toContain("closing");
    expect(phases[phases.length - 1]).toBe("closed");
    expect(session.closed).toBe(true);
    // Asked once there was work worth keeping (once per program run).
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("offers to save as a file when the store fails, and closes after the save", async () => {
    const { store, storage, i18n } = setup();
    const session = await storage.create({ title: "Talk" });
    const file = memoryFile("talk.galatsa");
    const doc = new EditorDocument(session, {
      i18n,
      pickTarget: async () => file,
      requestPersistence: async () => true,
      warnOnUnload: false,
    });
    await session.flush();
    store.failWrites(1_000_000, "full");
    addBox(session.doc);
    expect(await doc.close()).toBe("offer-save");
    expect(doc.state.phase).toBe("offer-save");
    expect(session.closed).toBe(false);
    const saved = await doc.saveAsFile();
    expect(saved?.ok).toBe(true);
    expect(file.bytes).not.toBeNull();
    await doc.closeAnyway();
    expect(doc.state.phase).toBe("closed");
    expect(session.closed).toBe(true);
  });

  it("goes back to editing when the user keeps it open", async () => {
    const { store, storage, i18n } = setup();
    const session = await storage.create();
    const doc = new EditorDocument(session, {
      i18n,
      requestPersistence: async () => true,
      warnOnUnload: false,
    });
    await session.flush();
    store.failWrites(1_000_000, "full");
    addBox(session.doc);
    expect(await doc.close()).toBe("offer-save");
    doc.keepOpen();
    expect(doc.state.phase).toBe("open");
    expect(session.closed).toBe(false);
    await session.close({ evenIfUnstored: true });
  });

  it("names the file after the title, or 'Untitled presentation'", async () => {
    const { storage, i18n } = setup();
    const named = new EditorDocument(await storage.create({ title: "Talk" }), {
      i18n,
      warnOnUnload: false,
    });
    expect(named.suggestedName()).toBe("Talk.galatsa");
    const untitled = new EditorDocument(await storage.create(), {
      i18n,
      warnOnUnload: false,
    });
    expect(untitled.suggestedName()).toBe("Untitled presentation.galatsa");
    expect(untitled.state.notices).toEqual([]);
  });
});

describe("without the browser's storage (a store in memory)", () => {
  it("never says saved, warns and offers a file while changes are not in a file", async () => {
    const { storage, i18n } = setup();
    const session = await storage.create({ title: "Talk" });
    const file = memoryFile("talk.galatsa");
    const doc = new EditorDocument(session, {
      i18n,
      volatile: true,
      pickTarget: async () => file,
      requestPersistence: async () => true,
      warnOnUnload: false,
    });
    expect(doc.wouldLoseWork()).toBe(false);
    addBox(session.doc);
    await session.flush();
    // Stored in memory: the status must not say "Saved".
    expect(session.status.pending).toBe(false);
    expect(session.status.lastStoredAt).not.toBeNull();
    expect(statusMessage(doc.state)?.key).toBe("editor:status.notStored");
    expect(doc.wouldLoseWork()).toBe(true);
    expect(await doc.close()).toBe("offer-save");
    expect(session.closed).toBe(false);
    // Saved to a file: nothing to lose, and it closes.
    doc.keepOpen();
    expect((await doc.saveAsFile())?.ok).toBe(true);
    expect(doc.wouldLoseWork()).toBe(false);
    expect(await doc.close()).toBe("closed");
  });

  it("with the browser's storage, a stored change is saved and leaving is safe", async () => {
    const { storage, i18n } = setup();
    const session = await storage.create({ title: "Talk" });
    const doc = new EditorDocument(session, { i18n, warnOnUnload: false });
    addBox(session.doc);
    await session.flush();
    expect(statusMessage(doc.state)?.key).toBe("storage:status.saved");
    expect(doc.wouldLoseWork()).toBe(false);
    await session.close({ evenIfUnstored: true });
  });
});
