// SPDX-License-Identifier: GPL-3.0-or-later

// The storage layer's entry point: creating, opening and recovering documents.
// See docs/adr/0006-storage.md.

import type { AssetId } from "@galatsa/core";
import { initDocument, roots, toSnapshot, trackWork } from "@galatsa/core/ydoc";
import { assetsToWrite, readGalatsaFile, writeGalatsaFile } from "@galatsa/format";
import * as Y from "yjs";
import type { StorageBackend } from "./backend.ts";
import {
  encodeCheckpoint,
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
import { fileNotices, notice, openProblem, type Notice } from "./notices.ts";
import {
  DEFAULT_TIMING,
  StorageSession,
  applyStored,
  readAsset,
  type AutosaveTiming,
  type SessionContext,
} from "./session.ts";

export interface StorageOptions {
  backend: StorageBackend;
  /**
   * How running sessions are told from stopped ones. Default: the Web Locks API
   * where there is one. Null: heartbeats in the session records.
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
  /** The file it was opened from or last saved to. */
  fileName: string | null;
  savedToFileAt: number | null;
  /** A running session has it open (in this or another tab). */
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

interface Loaded {
  doc: Y.Doc;
  checkpoint: LoadedCheckpoint;
  absorbed: Set<string>;
  info: SlotInfo;
  notices: Notice[];
  damaged: boolean;
}

/**
 * The storage layer. One per program; it opens any number of documents.
 *
 * - `create` starts a new document, `openFile` opens a file the user chose,
 *   `open` opens a document the store holds.
 * - At start, `recoverable` lists work that sessions left behind when their
 *   program stopped; `open` restores it, `dismiss` stops offering it.
 * - When a file cannot be opened, the result says why and lists the copies the
 *   store kept of a file with that name (`lastGood`).
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

  /** Starts a new, empty document. */
  async create(init: { title?: string } = {}): Promise<StorageSession> {
    const doc = new Y.Doc();
    initDocument(doc, init.title === undefined ? {} : { title: init.title });
    const { slot, info } = await this.#newSlot(doc, null, new Map());
    return this.#start(slot, info, doc, 1, [], new Set(), false, false);
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
    const { slot, info } = await this.#newSlot(read.doc, name, read.assets);
    const session = await this.#start(
      slot,
      info,
      read.doc,
      1,
      [],
      new Set(),
      false,
      false,
    );
    return { ok: true, session, notices: fileNotices(read.warnings) };
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
   * journaled since. Restores recovered work, and stops offering it.
   */
  async open(slot: string): Promise<OpenResult> {
    let loaded: Loaded | Notice;
    try {
      loaded = await this.#load(slot);
    } catch (error) {
      return {
        ok: false,
        problem: notice("storage-unavailable", undefined, error),
        lastGood: [],
      };
    }
    if (!("doc" in loaded)) return { ok: false, problem: loaded, lastGood: [] };
    const stopped = await this.#stoppedSessions(slot);
    const info = loaded.info;
    const unsavedToFile =
      stopped.some((s) => s.record?.unsaved) ||
      (info.fileName !== null &&
        (info.savedToFileAt === null || info.changedAt > info.savedToFileAt));
    const session = await this.#start(
      slot,
      info,
      loaded.doc,
      loaded.checkpoint.header.generation,
      loaded.checkpoint.header.includes,
      loaded.absorbed,
      unsavedToFile,
      loaded.damaged,
    );
    if (stopped.length > 0) {
      await this.backend
        .remove(stopped.map((s) => keys.session(slot, s.id)))
        .catch(() => {});
    }
    if (loaded.damaged) await session.checkpoint().catch(() => {});
    return { ok: true, session, notices: loaded.notices };
  }

  /** Every document the store holds, most recently changed first. */
  async list(): Promise<StoredDocument[]> {
    return (await this.#survey()).map((entry) => entry.document);
  }

  /**
   * Documents whose sessions stopped without closing and had changes not saved
   * to a file, most recent first. Records of stopped sessions without such
   * changes are cleared.
   */
  async recoverable(): Promise<RecoveryOffer[]> {
    const offers: RecoveryOffer[] = [];
    for (const entry of await this.#survey()) {
      const stopped = entry.sessions.filter((s) => !s.alive);
      const unsaved = stopped.filter((s) => s.record?.unsaved);
      const quiet = stopped.filter((s) => !s.record?.unsaved);
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

  /** Stops offering a document's stopped sessions for recovery. Keeps the document. */
  async dismiss(slot: string): Promise<void> {
    const stopped = await this.#stoppedSessions(slot);
    await this.backend.remove(stopped.map((s) => keys.session(slot, s.id)));
  }

  /**
   * Deletes a stored document and everything kept of it. Refuses (returns false)
   * while a running session has it open.
   */
  async discard(slot: string): Promise<boolean> {
    const all = await this.backend.list(keys.slot(slot));
    const sessions = groupKeys(all).get(slot)?.sessions ?? [];
    const records = await Promise.all(
      sessions.map(async (id) =>
        decodeSession(await this.backend.read(keys.session(slot, id))),
      ),
    );
    const alive = await this.#alive(sessions, records);
    if (alive.size > 0) return false;
    await this.backend.remove(all);
    return true;
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
      for (const id of assetsToWrite(toSnapshot(loaded.doc))) {
        const bytes = await readAsset(this.backend, slot, id);
        if (bytes) assets.set(id, bytes);
      }
      return writeGalatsaFile(loaded.doc, (id) => assets.get(id), {
        generator: this.#ctx.generator,
      }).bytes;
    } finally {
      loaded.doc.destroy();
    }
  }

  // --- Internals ------------------------------------------------------------

  async #newSlot(
    doc: Y.Doc,
    fileName: string | null,
    assets: ReadonlyMap<AssetId, Uint8Array>,
  ): Promise<{ slot: string; info: SlotInfo }> {
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
    };
    for (const [id, bytes] of assets)
      await this.backend.create(keys.asset(slot, id), bytes);
    await this.backend.write(keys.info(slot), encodeJson(info));
    // The slot exists once its first checkpoint does.
    const state = Y.encodeStateAsUpdate(doc);
    const encoded = await this.#ctx.encoder(state);
    const header = { generation: 1, base: 0, session: "", includes: [], createdAt: now };
    await this.backend.create(
      keys.checkpoint(slot, 1),
      frameCheckpoint(header, encoded, state),
    );
    return { slot, info };
  }

  async #start(
    slot: string,
    info: SlotInfo,
    doc: Y.Doc,
    generation: number,
    baseIncludes: string[],
    absorbed: Set<string>,
    unsavedToFile: boolean,
    needsCheckpoint: boolean,
  ): Promise<StorageSession> {
    // Every change must be recorded as work from the first one (ADR 0001,
    // section 5.5). Loading attached it already; this makes sure.
    trackWork(doc);
    const session = new StorageSession(
      this.#ctx,
      {
        slot,
        doc,
        generation,
        baseIncludes,
        absorbed,
        info,
        unsavedToFile,
        needsCheckpoint,
      },
      randomId(),
    );
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
        info,
        notices,
        damaged: true,
      };
    }
    if (rebuilt) rebuilt.doc.destroy();
    const doc = checkpoint.doc;
    const absorbed = new Set(checkpoint.header.includes);
    const updates: Uint8Array[] = [];
    let lost = 0;
    for (const key of grouped.journal) {
      if (absorbed.has(key)) continue;
      const bytes = await backend.read(key);
      const frame = bytes ? decodeFrame(bytes, FRAME_KIND.journal) : null;
      if (!frame) {
        if (bytes) lost++;
        continue;
      }
      updates.push(frame.payload);
      absorbed.add(key);
    }
    lost += applyStored(doc, updates);
    if (damaged > 0) notices.push(notice("restored-previous-copy"));
    if (lost > 0) notices.push(notice("changes-lost", { count: lost }));
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
      notices.push(notice("changes-incomplete"));
    }
    notices.push(...fileNotices(checkpoint.warnings));
    return {
      doc,
      checkpoint,
      absorbed,
      info,
      notices,
      damaged: damaged > 0 || lost > 0,
    };
  }

  async #alive(
    ids: readonly string[],
    records: readonly (SessionRecord | null)[],
  ): Promise<ReadonlySet<string>> {
    const asked = this.#ctx.liveness ? await this.#ctx.liveness.alive(ids) : null;
    if (asked) return asked;
    const now = this.#ctx.scheduler.now();
    const staleAfter = this.#ctx.timing.staleAfter;
    return new Set(
      ids.filter((_id, i) => {
        const record = records[i];
        return (
          record !== null && record !== undefined && now - record.heartbeatAt < staleAfter
        );
      }),
    );
  }

  async #survey(): Promise<
    {
      document: StoredDocument;
      sessions: { id: string; record: SessionRecord | null; alive: boolean }[];
    }[]
  > {
    const grouped = groupKeys(await this.backend.list(DOC_PREFIX));
    const out = [];
    for (const entry of grouped.values()) {
      if (entry.checkpoints.length === 0) continue;
      const info = decodeInfo(await this.backend.read(keys.info(entry.slot)));
      const records = await Promise.all(
        entry.sessions.map(async (id) =>
          decodeSession(await this.backend.read(keys.session(entry.slot, id))),
        ),
      );
      const alive = await this.#alive(entry.sessions, records);
      const sessions = entry.sessions.map((id, i) => ({
        id,
        record: records[i] ?? null,
        alive: alive.has(id),
      }));
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
    const sessions =
      groupKeys(await this.backend.list(keys.sessions(slot))).get(slot)?.sessions ?? [];
    const records = await Promise.all(
      sessions.map(async (id) =>
        decodeSession(await this.backend.read(keys.session(slot, id))),
      ),
    );
    const alive = await this.#alive(sessions, records);
    return sessions
      .map((id, i) => ({ id, record: records[i] ?? null }))
      .filter((s) => !alive.has(s.id));
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
