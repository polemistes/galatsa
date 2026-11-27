// SPDX-License-Identifier: GPL-3.0-or-later

// The storage layer's entry point: creating, opening and recovering documents.
// See docs/adr/0006-storage.md.

import type { AssetId } from "@galatsa/core";
import { initDocument, roots, toSnapshot, trackWork } from "@galatsa/core/ydoc";
import {
  assetsToWrite,
  readGalatsaFile,
  writeGalatsaFile,
  type AssetPreview,
} from "@galatsa/format";
import * as Y from "yjs";
import type { StorageBackend } from "./backend.ts";
import {
  encodeCheckpoint,
  encodeCheckpointFile,
  frameCheckpoint,
  loadCheckpoint,
  type CheckpointEncoder,
  type LoadedCheckpoint,
} from "./checkpoint.ts";
import {
  broadcastChannels,
  systemScheduler,
  webLocksLiveness,
  type ChannelFactory,
  type Liveness,
  type Scheduler,
} from "./environment.ts";
import type { FileSource } from "./files.ts";
import { readPreviews, storePreviews } from "./previews.ts";
import { FRAME_KIND, decodeFrame } from "./frame.ts";
import {
  DOC_PREFIX,
  decodeInfo,
  decodeSession,
  encodeJson,
  groupKeys,
  keys,
  randomId,
  type SessionRecord,
  type SlotInfo,
} from "./layout.ts";
import {
  autosaveProblem,
  fileNotices,
  notice,
  openProblem,
  type Notice,
} from "./notices.ts";
import {
  DEFAULT_TIMING,
  StorageSession,
  applyStored,
  dropPending,
  openChannel,
  readAsset,
  type AutosaveTiming,
  type OpenChannel,
  type SessionContext,
  type SessionStart,
} from "./session.ts";

export interface StorageOptions {
  backend: StorageBackend;
  /**
   * How running sessions are told from stopped ones. Default: the Web Locks API
   * where there is one. Null: heartbeats in the session records only. Sessions
   * always write heartbeats, which count wherever the locks cannot be asked.
   */
  liveness?: Liveness | null;
  /** A channel between tabs. Default: BroadcastChannel where there is one. Null: none. */
  channels?: ChannelFactory | null;
  scheduler?: Scheduler;
  /** Builds checkpoint files; a program can pass one that runs in a worker. */
  encodeCheckpoint?: CheckpointEncoder;
  timing?: Partial<AutosaveTiming>;
  /** Name and version of the program, written into files. */
  generator?: string;
  /** Store at once when the page is hidden or left (default: true in a browser). */
  lifecycle?: boolean;
}

/** A document the store holds. */
export interface StoredDocument {
  slot: string;
  title: string;
  documentId: string;
  createdAt: number;
  /** When it last changed, as far as the store knows. */
  changedAt: number;
  /** The file it was opened from, last saved to or last downloaded as. */
  fileName: string | null;
  /** When it was last saved to that file (a download does not count). */
  savedToFileAt: number | null;
  /** When it was last handed to the browser as a download. */
  downloadedAt: number | null;
  /** A running session has it open (in this or another tab), or it cannot be told. */
  open: boolean;
  /** A session stored changes that are not saved to its file. */
  unsaved: boolean;
}

/** Work a session left behind when its program stopped without closing it. */
export interface RecoveryOffer extends StoredDocument {
  /** The sessions that stopped. */
  stoppedSessions: string[];
}

export type OpenResult =
  | { ok: true; session: StorageSession; notices: Notice[] }
  | {
      ok: false;
      problem: Notice;
      /** Copies the store kept of a file with the same name, newest first. */
      lastGood: StoredDocument[];
    };

/** What `discardChanges` did. */
export type DiscardResult =
  /** The file is open (`session`), and the stored copy with its changes is gone. */
  | { ok: true; session: StorageSession; notices: Notice[] }
  /**
   * Nothing was discarded: the document was never saved to a file ("no-file",
   * discarding would delete it), or a running session has it open, or that
   * cannot be told ("open").
   */
  | { ok: false; reason: "no-file" | "open" }
  /** Nothing was discarded: the file could not be opened (`problem` says why). */
  | { ok: false; reason: "file-failed"; problem: Notice };

interface Loaded {
  doc: Y.Doc;
  checkpoint: LoadedCheckpoint;
  absorbed: Set<string>;
  skipped: Set<string>;
  info: SlotInfo;
  notices: Notice[];
  damaged: boolean;
}

interface Survey {
  document: StoredDocument;
  sessions: { id: string; record: SessionRecord | null; alive: boolean }[];
}

/**
 * The storage layer. One per program; it opens any number of documents.
 *
 * - `create` starts a new document, `openFile` opens a file the user chose,
 *   `open` opens a document the store holds.
 * - At start, `recoverable` lists work that sessions left behind when their
 *   program stopped; `open` restores it, `dismiss` stops offering it,
 *   `discardChanges` drops it (only for a document that has a file), and
 *   `deleteDocument` removes a stored document altogether.
 * - When a file cannot be opened, the result says why and lists the copies the
 *   store kept of a file with that name (`lastGood`).
 *
 * Nothing here fails because the store is full or gone: documents open with a
 * notice saying so, and saving to a file still works.
 */
export class DocumentStorage {
  readonly backend: StorageBackend;
  #ctx: SessionContext;

  constructor(options: StorageOptions) {
    this.backend = options.backend;
    const hasDocument =
      typeof (globalThis as { document?: unknown }).document !== "undefined";
    this.#ctx = {
      backend: options.backend,
      liveness: options.liveness === undefined ? webLocksLiveness() : options.liveness,
      channels: options.channels === undefined ? broadcastChannels() : options.channels,
      scheduler: options.scheduler ?? systemScheduler,
      encoder: options.encodeCheckpoint ?? encodeCheckpoint,
      timing: { ...DEFAULT_TIMING, ...options.timing },
      generator: options.generator ?? "Galatsa",
      lifecycle: options.lifecycle ?? hasDocument,
    };
  }

  /**
   * Starts a new, empty document. If the store cannot take it, the session's
   * status says so, and the store is tried again.
   */
  async create(init: { title?: string } = {}): Promise<StorageSession> {
    const doc = new Y.Doc();
    initDocument(doc, init.title === undefined ? {} : { title: init.title });
    const slot = await this.#newSlot(doc, null, new Map(), new Map());
    return this.#start(slot.start);
  }

  /**
   * Opens a Galatsa file's bytes as a new stored document. If the file cannot be
   * opened, the result says why and offers the copies kept of a file with the
   * same name.
   */
  async importFile(bytes: Uint8Array, from: { name?: string } = {}): Promise<OpenResult> {
    const name = from.name ?? null;
    let read;
    try {
      read = await readGalatsaFile(bytes);
    } catch (error) {
      return {
        ok: false,
        problem: openProblem(error, name ?? ""),
        lastGood: await this.#lastGood(name),
      };
    }
    const slot = await this.#newSlot(read.doc, name, read.assets, read.previews);
    const session = await this.#start(slot.start);
    const notices = fileNotices(read.warnings);
    if (session.status.problem) notices.push(session.status.problem);
    return { ok: true, session, notices };
  }

  /** Reads a file the user chose and opens it (see importFile). */
  async openFile(source: FileSource): Promise<OpenResult> {
    let bytes: Uint8Array;
    try {
      bytes = await source.read();
    } catch (error) {
      return {
        ok: false,
        problem: notice("file-unreadable", { name: source.name }, error),
        lastGood: await this.#lastGood(source.name),
      };
    }
    return this.importFile(bytes, { name: source.name });
  }

  /**
   * Opens a stored document: the newest checkpoint that reads, and every change
   * journaled since. Restores recovered work, and stops offering it. Works
   * while the store cannot be written to (the result has a notice about it).
   */
  async open(slot: string): Promise<OpenResult> {
    // Listen to other tabs before reading, so that no entry stored meanwhile
    // is missed.
    const channel = openChannel(this.#ctx.channels, this.backend, slot);
    let loaded: Loaded | Notice;
    try {
      loaded = await this.#load(slot);
    } catch (error) {
      channel?.channel.close();
      return {
        ok: false,
        problem: notice("storage-unavailable", undefined, error),
        lastGood: [],
      };
    }
    if (!("doc" in loaded)) {
      channel?.channel.close();
      return { ok: false, problem: loaded, lastGood: [] };
    }
    const stopped = await this.#stoppedSessions(slot).catch(() => []);
    const info = loaded.info;
    const unsavedToFile =
      stopped.some((s) => s.record?.unsaved) ||
      (info.fileName !== null &&
        (info.savedToFileAt === null || info.changedAt > info.savedToFileAt));
    const session = await this.#start({
      slot,
      doc: loaded.doc,
      generation: loaded.checkpoint.header.generation,
      baseIncludes: loaded.checkpoint.header.includes,
      absorbed: loaded.absorbed,
      skipped: loaded.skipped,
      info,
      unsavedToFile,
      needsCheckpoint: loaded.damaged,
      channel,
    });
    if (stopped.length > 0) {
      await this.backend
        .remove(stopped.map((s) => keys.session(slot, s.id)))
        .catch(() => {});
    }
    if (loaded.damaged) await session.checkpoint().catch(() => {});
    const notices = [...loaded.notices];
    if (session.status.problem) notices.push(session.status.problem);
    return { ok: true, session, notices };
  }

  /** Every document the store holds, most recently changed first. */
  async list(): Promise<StoredDocument[]> {
    return (await this.#survey()).map((entry) => entry.document);
  }

  /**
   * Documents whose sessions stopped without closing and had changes not saved
   * to a file, most recent first. Records of stopped sessions without such
   * changes are cleared. A session that cannot be told stopped is not offered.
   */
  async recoverable(): Promise<RecoveryOffer[]> {
    const offers: RecoveryOffer[] = [];
    for (const entry of await this.#survey()) {
      const stopped = entry.sessions.filter((s) => !s.alive);
      const unsaved = stopped.filter((s) => s.record?.unsaved);
      const quiet = stopped.filter((s) => s.record && !s.record.unsaved);
      if (quiet.length > 0) {
        await this.backend
          .remove(quiet.map((s) => keys.session(entry.document.slot, s.id)))
          .catch(() => {});
      }
      if (unsaved.length > 0) {
        offers.push({ ...entry.document, stoppedSessions: unsaved.map((s) => s.id) });
      }
    }
    return offers;
  }

  /**
   * Stops offering a document for recovery, for good. The document stays in the
   * store, with the recovered work, and is listed by `list()`.
   */
  async dismiss(slot: string): Promise<void> {
    const stopped = await this.#stoppedSessions(slot);
    // The records are the only place that may say the document has changes not
    // in its file (when it stopped before its first checkpoint): keep that in
    // its description, so it does not open as saved.
    const changedAt = Math.max(
      0,
      ...stopped.map((s) => (s.record?.unsaved ? (s.record.changedAt ?? 0) : 0)),
    );
    const info = decodeInfo(await this.backend.read(keys.info(slot)));
    if (changedAt > info.changedAt) {
      await this.backend.write(keys.info(slot), encodeJson({ ...info, changedAt }));
    }
    await this.backend.remove(stopped.map((s) => keys.session(slot, s.id)));
  }

  /**
   * Drops the changes a document has that are not in its file: opens the file
   * (`file`, the one the document was last saved to) as a new stored document,
   * and only if that worked removes the old stored copy. Only for a document
   * that has been saved to a file (`savedToFileAt`); for one that never was this
   * would delete the whole presentation, so it does nothing and says "no-file"
   * (`deleteDocument` is the way, after the user has been told). Does nothing
   * while a running session has the document open.
   */
  async discardChanges(slot: string, file: FileSource): Promise<DiscardResult> {
    const info = decodeInfo(await this.backend.read(keys.info(slot)));
    if (info.fileName === null || info.savedToFileAt === null) {
      return { ok: false, reason: "no-file" };
    }
    if (await this.#isOpen(slot)) return { ok: false, reason: "open" };
    // The file first: the stored copies go only once it has opened.
    const reopened = await this.openFile(file);
    if (!reopened.ok)
      return { ok: false, reason: "file-failed", problem: reopened.problem };
    // If a session opened the old copy meanwhile, it stays (nothing is lost).
    await this.#removeSlot(slot).catch(() => false);
    return { ok: true, session: reopened.session, notices: reopened.notices };
  }

  /**
   * Deletes a stored document and everything kept of it, including every copy
   * of a presentation that was never saved to a file. Returns false (and
   * deletes nothing) while a running session has it open, or while that cannot
   * be told.
   */
  async deleteDocument(slot: string): Promise<boolean> {
    return this.#removeSlot(slot);
  }

  /**
   * The stored document as a Galatsa file, with its assets: to save a kept copy
   * somewhere else. Throws a FileFormatError if it cannot be written, and
   * returns null if it cannot be read.
   */
  async exportFile(slot: string): Promise<Uint8Array | null> {
    const loaded = await this.#load(slot);
    if (!("doc" in loaded)) return null;
    try {
      const assets = new Map<AssetId, Uint8Array>();
      const previews = new Map<AssetId, AssetPreview[]>();
      for (const id of assetsToWrite(toSnapshot(loaded.doc))) {
        const bytes = await readAsset(this.backend, slot, id).catch(() => undefined);
        if (bytes) assets.set(id, bytes);
        const list = await readPreviews(this.backend, slot, id).catch(() => []);
        if (list.length > 0) previews.set(id, list);
      }
      return writeGalatsaFile(loaded.doc, (id) => assets.get(id), {
        generator: this.#ctx.generator,
        previews: (id) => previews.get(id),
      }).bytes;
    } finally {
      loaded.doc.destroy();
    }
  }

  /**
   * The bytes of an asset, and its reduced versions, from any stored document
   * that has them (checked against the id), other than `except`; null if none
   * has. For pasting between documents of the program: the clipboard carries
   * an asset's description, not its bytes.
   */
  async findAsset(
    id: AssetId,
    except?: string,
  ): Promise<{ bytes: Uint8Array; previews: AssetPreview[] } | null> {
    const suffix = `/a/${id}`;
    for (const key of await this.backend.list(DOC_PREFIX)) {
      if (!key.endsWith(suffix)) continue;
      const slot = key.slice(DOC_PREFIX.length, key.length - suffix.length);
      if (slot === except || slot.includes("/")) continue;
      const bytes = await readAsset(this.backend, slot, id).catch(() => undefined);
      if (bytes === undefined) continue;
      const previews = await readPreviews(this.backend, slot, id).catch(() => []);
      return { bytes, previews };
    }
    return null;
  }

  // --- Internals ------------------------------------------------------------

  /**
   * Writes a new slot: its assets, its description and two checkpoints, so that
   * a last good copy exists from the start. Never fails because of the store;
   * whatever could not be written is written later by the session.
   */
  async #newSlot(
    doc: Y.Doc,
    fileName: string | null,
    assets: ReadonlyMap<AssetId, Uint8Array>,
    previews: ReadonlyMap<AssetId, readonly AssetPreview[]>,
  ): Promise<{ start: SessionStart }> {
    trackWork(doc);
    const slot = randomId();
    const now = this.#ctx.scheduler.now();
    const meta = roots(doc).meta;
    const info: SlotInfo = {
      title: String(meta.get("title") ?? ""),
      documentId: String(meta.get("id") ?? ""),
      createdAt: now,
      changedAt: now,
      fileName,
      savedToFileAt: fileName === null ? null : now,
      downloadedAt: null,
    };
    let problem: Notice | null = null;
    const unstored = new Set<AssetId>();
    for (const [id, bytes] of assets) {
      try {
        await this.backend.create(keys.asset(slot, id), bytes);
      } catch (error) {
        unstored.add(id);
        problem ??= autosaveProblem(error);
      }
    }
    // Previews are a cache: one that cannot be stored now is stored later.
    const unstoredPreviews = new Set<AssetId>();
    for (const [id, list] of previews) {
      try {
        await storePreviews(this.backend, slot, id, list);
      } catch {
        unstoredPreviews.add(id);
      }
    }
    await this.backend.write(keys.info(slot), encodeJson(info)).catch(() => {});
    // The first checkpoints are built here, on this thread: a worker that does
    // not answer must not keep a document from opening.
    const state = Y.encodeStateAsUpdate(doc);
    const encoded = encodeCheckpointFile(state, this.#ctx.generator);
    let generation = 0;
    try {
      for (const g of [1, 2]) {
        const header = {
          generation: g,
          base: g - 1,
          session: "",
          includes: [],
          createdAt: now,
        };
        await this.backend.create(
          keys.checkpoint(slot, g),
          frameCheckpoint(header, encoded, state),
        );
        generation = g;
      }
    } catch (error) {
      problem ??= autosaveProblem(error);
    }
    return {
      start: {
        slot,
        doc,
        generation,
        baseIncludes: [],
        absorbed: new Set(),
        info,
        unsavedToFile: false,
        needsCheckpoint: generation < 2,
        assets,
        unstoredAssets: unstored,
        previews,
        unstoredPreviews,
        problem,
      },
    };
  }

  async #start(
    start: SessionStart & { channel?: OpenChannel | null },
  ): Promise<StorageSession> {
    // Every change must be recorded as work from the first one (ADR 0001,
    // section 5.5). Loading attached it already; this makes sure.
    trackWork(start.doc);
    const session = new StorageSession(this.#ctx, start, randomId());
    await session.start();
    return session;
  }

  async #load(slot: string): Promise<Loaded | Notice> {
    const backend = this.backend;
    const grouped = groupKeys(await backend.list(keys.slot(slot))).get(slot);
    if (!grouped || grouped.checkpoints.length === 0) return notice("stored-missing");
    const info = decodeInfo(await backend.read(keys.info(slot)));
    let checkpoint: LoadedCheckpoint | null = null;
    let rebuilt: LoadedCheckpoint | null = null;
    let damaged = 0;
    for (let i = grouped.checkpoints.length - 1; i >= 0; i--) {
      const bytes = await backend.read(keys.checkpoint(slot, grouped.checkpoints[i]!));
      const loaded = bytes ? await loadCheckpoint(bytes) : null;
      if (loaded?.mergeIdentityKept) {
        checkpoint = loaded;
        break;
      }
      damaged++;
      if (loaded && !rebuilt) rebuilt = loaded;
      else loaded?.doc.destroy();
    }
    const notices: Notice[] = [];
    if (!checkpoint) {
      if (!rebuilt)
        return notice("stored-damaged", { name: info.fileName ?? info.title });
      // Only a checkpoint whose Yjs state was unusable: the journal cannot be
      // applied to it.
      notices.push(notice("restored-previous-copy"));
      if (grouped.journal.length > 0) {
        notices.push(notice("changes-lost", { count: grouped.journal.length }));
      }
      notices.push(...fileNotices(rebuilt.warnings));
      return {
        doc: rebuilt.doc,
        checkpoint: rebuilt,
        // The journal belongs to the lost Yjs history and cannot be applied.
        absorbed: new Set(grouped.journal),
        skipped: new Set(),
        info,
        notices,
        damaged: true,
      };
    }
    if (rebuilt) rebuilt.doc.destroy();
    const doc = checkpoint.doc;
    const absorbed = new Set(checkpoint.header.includes);
    const skipped = new Set<string>();
    const updates: Uint8Array[] = [];
    for (const key of grouped.journal) {
      if (absorbed.has(key)) continue;
      const bytes = await backend.read(key);
      const frame = bytes ? decodeFrame(bytes, FRAME_KIND.journal) : null;
      if (!frame) {
        if (bytes) skipped.add(key);
        continue;
      }
      updates.push(frame.payload);
      absorbed.add(key);
    }
    applyStored(doc, updates);
    // What builds on a damaged entry cannot be shown, and must not travel
    // into the next checkpoint.
    const incomplete = dropPending(doc);
    if (damaged > 0) notices.push(notice("restored-previous-copy"));
    if (skipped.size > 0) notices.push(notice("changes-lost", { count: skipped.size }));
    if (incomplete) notices.push(notice("changes-incomplete"));
    notices.push(...fileNotices(checkpoint.warnings));
    return {
      doc,
      checkpoint,
      absorbed,
      skipped,
      info,
      notices,
      damaged: damaged > 0 || skipped.size > 0 || incomplete,
    };
  }

  /**
   * The sessions among `ids` that are running, or cannot be told stopped. The
   * locks are asked first; where they cannot answer, heartbeats decide, which
   * every session writes. A record that cannot be read counts as running.
   */
  async #alive(
    ids: readonly string[],
    records: readonly (SessionRecord | null)[],
  ): Promise<ReadonlySet<string>> {
    const asked = this.#ctx.liveness
      ? await this.#ctx.liveness.alive(ids).catch(() => null)
      : null;
    if (asked) return asked;
    const now = this.#ctx.scheduler.now();
    const staleAfter = this.#ctx.timing.staleAfter;
    return new Set(
      ids.filter((_id, i) => {
        const record = records[i];
        return !record || now - record.heartbeatAt < staleAfter;
      }),
    );
  }

  async #sessionsOf(
    slot: string,
    ids: readonly string[],
  ): Promise<{ id: string; record: SessionRecord | null; alive: boolean }[]> {
    const records = await Promise.all(
      ids.map(async (id) =>
        decodeSession(await this.backend.read(keys.session(slot, id))),
      ),
    );
    const alive = await this.#alive(ids, records);
    return ids.map((id, i) => ({ id, record: records[i] ?? null, alive: alive.has(id) }));
  }

  async #survey(): Promise<Survey[]> {
    const grouped = groupKeys(await this.backend.list(DOC_PREFIX));
    const out: Survey[] = [];
    for (const entry of grouped.values()) {
      if (entry.checkpoints.length === 0) continue;
      const info = decodeInfo(await this.backend.read(keys.info(entry.slot)));
      const sessions = await this.#sessionsOf(entry.slot, entry.sessions);
      let changedAt = info.changedAt;
      for (const s of sessions) {
        if (s.record?.changedAt !== null && s.record?.changedAt !== undefined) {
          changedAt = Math.max(changedAt, s.record.changedAt);
        }
      }
      out.push({
        document: {
          slot: entry.slot,
          title: info.title,
          documentId: info.documentId,
          createdAt: info.createdAt,
          changedAt,
          fileName: info.fileName,
          savedToFileAt: info.savedToFileAt,
          downloadedAt: info.downloadedAt,
          open: sessions.some((s) => s.alive),
          unsaved: sessions.some((s) => s.record?.unsaved === true),
        },
        sessions,
      });
    }
    return out.sort((a, b) => b.document.changedAt - a.document.changedAt);
  }

  async #stoppedSessions(
    slot: string,
  ): Promise<{ id: string; record: SessionRecord | null }[]> {
    const ids =
      groupKeys(await this.backend.list(keys.sessions(slot))).get(slot)?.sessions ?? [];
    return (await this.#sessionsOf(slot, ids)).filter((s) => !s.alive);
  }

  async #isOpen(slot: string): Promise<boolean> {
    const ids =
      groupKeys(await this.backend.list(keys.sessions(slot))).get(slot)?.sessions ?? [];
    return (await this.#sessionsOf(slot, ids)).some((s) => s.alive);
  }

  /** Removes a slot, unless a session has it open or that cannot be told. */
  async #removeSlot(slot: string): Promise<boolean> {
    const all = await this.backend.list(keys.slot(slot));
    const ids = groupKeys(all).get(slot)?.sessions ?? [];
    if ((await this.#sessionsOf(slot, ids)).some((s) => s.alive)) return false;
    await this.backend.remove(all);
    return true;
  }

  async #lastGood(name: string | null): Promise<StoredDocument[]> {
    if (!name) return [];
    try {
      return (await this.list()).filter((d) => d.fileName === name);
    } catch {
      return [];
    }
  }
}
