// SPDX-License-Identifier: GPL-3.0-or-later

// One open document: it records every change in a journal shortly after it is
// made, folds the journal into checkpoints now and then, and saves to the user's
// file on request. Sections 4 and 5 of docs/adr/0006-storage.md.

import type { AssetId } from "@galatsa/core";
import { lineageOf, roots, toSnapshot } from "@galatsa/core/ydoc";
import { assetIdOf, assetsToWrite, writeGalatsaFile } from "@galatsa/format";
import * as Y from "yjs";
import { StorageError, type StorageBackend } from "./backend.ts";
import { frameCheckpoint, loadCheckpoint, type CheckpointEncoder } from "./checkpoint.ts";
import type {
  Channel,
  ChannelFactory,
  ChannelMessage,
  Liveness,
  Scheduler,
} from "./environment.ts";
import type { FileTarget } from "./files.ts";
import { FRAME_KIND, decodeFrame, encodeFrame } from "./frame.ts";
import {
  encodeJson,
  generationOf,
  keys,
  type SessionRecord,
  type SlotInfo,
} from "./layout.ts";
import {
  autosaveProblem,
  fileNotices,
  notice,
  saveProblem,
  type Notice,
} from "./notices.ts";

/**
 * Origin of the transactions in which the layer brings stored changes into a
 * document (other sessions' journal entries and checkpoints). They are not
 * journaled again, and, being remote, they are neither work nor undoable.
 */
export const STORAGE_ORIGIN = "galatsa:storage";

/** When the layer writes. All times in milliseconds. */
export interface AutosaveTiming {
  /** Journal changes this long after the last one... */
  journalDelay: number;
  /** ...but no later than this after the first one not yet journaled. */
  journalMaxDelay: number;
  /** Write a checkpoint when editing has paused this long... */
  checkpointIdle: number;
  /** ...and the last checkpoint is at least this old... */
  checkpointInterval: number;
  /** ...or the journal has grown by this many bytes since it... */
  checkpointBytes: number;
  /** ...and in any case no later than this after the first change since it. */
  checkpointMaxDelay: number;
  /** First wait before trying a failed write again (doubles up to a minute). */
  retryDelay: number;
  /** Heartbeats, where liveness cannot be asked. */
  heartbeatInterval: number;
  /** A session without a heartbeat for this long counts as stopped. */
  staleAfter: number;
  /** How often a session updates when it last changed something. */
  changedAtResolution: number;
}

export const DEFAULT_TIMING: AutosaveTiming = {
  journalDelay: 300,
  journalMaxDelay: 1000,
  checkpointIdle: 2000,
  checkpointInterval: 30_000,
  checkpointBytes: 4 * 1024 * 1024,
  checkpointMaxDelay: 300_000,
  retryDelay: 2000,
  heartbeatInterval: 30_000,
  staleAfter: 120_000,
  changedAtResolution: 10_000,
};

export interface SessionStatus {
  /** A write to the store is in progress. */
  saving: boolean;
  /** There are changes that are not in the store yet. */
  pending: boolean;
  /** When a change last reached the store. */
  lastStoredAt: number | null;
  /** There are changes since the document was opened or last saved to a file. */
  unsavedToFile: boolean;
  /** The file the document was opened from or saved to, if any. */
  fileName: string | null;
  /** Why changes are not reaching the store, while that lasts. */
  problem: Notice | null;
}

export type SaveResult = { ok: true; notices: Notice[] } | { ok: false; problem: Notice };

/** What a session gets from the storage that opened it. */
export interface SessionContext {
  backend: StorageBackend;
  liveness: Liveness | null;
  channels: ChannelFactory | null;
  scheduler: Scheduler;
  encoder: CheckpointEncoder;
  timing: AutosaveTiming;
  generator: string;
  lifecycle: boolean;
}

/** Where a session starts: a document loaded from (or just written to) a slot. */
export interface SessionStart {
  slot: string;
  doc: Y.Doc;
  /** The checkpoint the document was loaded from. */
  generation: number;
  /** The journal entries that checkpoint holds. */
  baseIncludes: string[];
  /** Every journal entry whose content is in the document. */
  absorbed: Set<string>;
  info: SlotInfo;
  /** True if the document is not what its file holds (changes were restored). */
  unsavedToFile: boolean;
  /** True if the stored copy should be rewritten soon (it had damage). */
  needsCheckpoint: boolean;
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Applies stored updates as one remote change; falls back to one by one. */
export function applyStored(doc: Y.Doc, updates: readonly Uint8Array[]): number {
  if (updates.length === 0) return 0;
  try {
    Y.applyUpdate(
      doc,
      updates.length === 1 ? updates[0]! : Y.mergeUpdates([...updates]),
      STORAGE_ORIGIN,
    );
    return 0;
  } catch {
    let failed = 0;
    for (const update of updates) {
      try {
        Y.applyUpdate(doc, update, STORAGE_ORIGIN);
      } catch {
        failed++;
      }
    }
    return failed;
  }
}

/**
 * An open document. The document (`doc`) has work tracking attached; whoever
 * edits it should get the live resolver with `liveResolver(doc)` and an undo
 * manager with `createUndoManager(doc)`. Every change to it, from any origin
 * other than this layer, is stored. Call `close()` when the document is closed;
 * changes made after that are not stored.
 */
export class StorageSession {
  readonly slot: string;
  readonly id: string;
  readonly doc: Y.Doc;

  #ctx: SessionContext;
  #info: SlotInfo;
  #record: SessionRecord;
  #pending: Uint8Array[] = [];
  #firstPendingAt = 0;
  #seq = 0;
  #absorbed: Set<string>;
  #skipped = new Set<string>();
  #generation: number;
  #baseIncludes: string[];
  #journalBytes = 0;
  #changes = 0;
  #dirtySince: number | null = null;
  #lastChangeAt = 0;
  #lastCheckpointAt: number;
  #queue: Promise<unknown> = Promise.resolve();
  #saves: Promise<unknown> = Promise.resolve();
  #flushTimer: unknown = null;
  #checkpointTimer: unknown = null;
  #retryTimer: unknown = null;
  #heartbeatTimer: unknown = null;
  #retryDelay: number;
  #status: SessionStatus;
  #listeners = new Set<(status: SessionStatus) => void>();
  #closed = false;
  #release: () => void = () => {};
  #channel: Channel | null = null;
  #detach: (() => void)[] = [];

  /** Use DocumentStorage to open sessions. */
  constructor(ctx: SessionContext, start: SessionStart, id: string) {
    this.#ctx = ctx;
    this.slot = start.slot;
    this.id = id;
    this.doc = start.doc;
    this.#info = start.info;
    this.#generation = start.generation;
    this.#baseIncludes = start.baseIncludes;
    this.#absorbed = start.absorbed;
    this.#retryDelay = ctx.timing.retryDelay;
    const now = ctx.scheduler.now();
    this.#lastCheckpointAt = now;
    if (start.needsCheckpoint) this.#dirtySince = now;
    this.#record = {
      startedAt: now,
      heartbeatAt: now,
      changedAt: start.unsavedToFile ? now : null,
      unsaved: start.unsavedToFile,
    };
    this.#status = {
      saving: false,
      pending: false,
      lastStoredAt: null,
      unsavedToFile: start.unsavedToFile,
      fileName: start.info.fileName,
      problem: null,
    };
    const onUpdate = (update: Uint8Array, origin: unknown) =>
      this.#onUpdate(update, origin);
    this.doc.on("update", onUpdate);
    this.#detach.push(() => this.doc.off("update", onUpdate));
  }

  /** Writes the session record and starts listening to other tabs. */
  async start(): Promise<void> {
    await this.#ctx.backend.write(
      keys.session(this.slot, this.id),
      encodeJson(this.#record),
    );
    this.#release = this.#ctx.liveness?.hold(this.id) ?? (() => {});
    if (!this.#ctx.liveness) this.#scheduleHeartbeat();
    const channels = this.#ctx.channels;
    if (channels) {
      this.#channel = channels(`galatsa-storage:${this.#ctx.backend.name}:${this.slot}`);
      this.#channel.listen((message) => this.#onMessage(message));
    }
    this.#attachLifecycle();
  }

  get status(): SessionStatus {
    return { ...this.#status };
  }

  /** Calls the listener whenever the status changes. Returns a function that stops it. */
  subscribe(listener: (status: SessionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Stores the changes made so far in the journal now. Resolves to false if that failed. */
  flush(): Promise<boolean> {
    return this.#enqueue(() => this.#flushNow());
  }

  /**
   * Stores everything now and folds it into a new checkpoint (when something
   * changed since the last one). Rejects if the store fails; the changes stay
   * in memory and are written later.
   */
  checkpoint(): Promise<void> {
    return this.#enqueue(async () => {
      if (!(await this.#flushNow())) {
        throw (
          this.#status.problem?.cause ??
          new StorageError("failed", "The journal could not be written")
        );
      }
      await this.#checkpointNow();
    });
  }

  /**
   * Stores an asset's bytes (an image, a video) and returns its id. The caller
   * then describes it in the document (`addAsset`) in the command that uses it.
   */
  async putAsset(bytes: Uint8Array): Promise<AssetId> {
    const id = await assetIdOf(bytes);
    await this.#ctx.backend.create(keys.asset(this.slot, id), bytes);
    return id;
  }

  /** An asset's bytes, or undefined if they are missing or damaged. */
  async getAsset(id: AssetId): Promise<Uint8Array | undefined> {
    return readAsset(this.#ctx.backend, this.slot, id);
  }

  /**
   * Saves the document, with its assets, to a file the user chose. The file is
   * replaced atomically (see FileTarget), and read back to check it where that
   * is possible. A save that fails leaves the old file as it was; the document
   * stays safe in the store either way.
   */
  saveToFile(
    target: FileTarget,
    options: { thumbnail?: Uint8Array } = {},
  ): Promise<SaveResult> {
    const run = async (): Promise<SaveResult> => {
      await this.flush();
      const changes = this.#changes;
      let bytes: Uint8Array;
      let notices: Notice[];
      try {
        const assets = new Map<AssetId, Uint8Array>();
        for (const id of assetsToWrite(toSnapshot(this.doc))) {
          const asset = await this.getAsset(id);
          if (asset) assets.set(id, asset);
        }
        const writeOptions: { generator: string; thumbnail?: Uint8Array } = {
          generator: this.#ctx.generator,
        };
        if (options.thumbnail) writeOptions.thumbnail = options.thumbnail;
        const written = writeGalatsaFile(this.doc, (id) => assets.get(id), writeOptions);
        bytes = written.bytes;
        notices = fileNotices(written.warnings);
        await target.write(bytes);
      } catch (error) {
        return { ok: false, problem: saveProblem(error, target.name) };
      }
      if (target.canRead) {
        let back: Uint8Array | undefined;
        try {
          back = await target.read();
        } catch {
          back = undefined;
        }
        if (!sameBytes(back, bytes)) {
          return {
            ok: false,
            problem: notice("save-verify-failed", { name: target.name }),
          };
        }
      }
      const now = this.#ctx.scheduler.now();
      this.#info = { ...this.#info, fileName: target.name, savedToFileAt: now };
      await this.#enqueue(async () => {
        await this.#writeInfo(false);
        if (this.#changes === changes) {
          this.#record = { ...this.#record, unsaved: false };
          await this.#writeRecord();
        }
      });
      this.#setStatus({
        fileName: target.name,
        unsavedToFile: this.#changes !== changes,
      });
      return { ok: true, notices };
    };
    const result = this.#saves.then(run, run);
    this.#saves = result;
    return result;
  }

  /**
   * Stores everything, writes a last checkpoint and ends the session. If that
   * fails, the session record stays, so the next start offers the document.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    let clean = false;
    try {
      await this.checkpoint();
      // Changes made while the checkpoint was written.
      if (this.#pending.length > 0) await this.flush();
      clean = this.#pending.length === 0;
    } catch {
      // Not clean: the record stays.
    } finally {
      this.#closed = true;
      for (const detach of this.#detach) detach();
      this.#detach = [];
      for (const timer of [
        this.#flushTimer,
        this.#checkpointTimer,
        this.#retryTimer,
        this.#heartbeatTimer,
      ]) {
        if (timer !== null) this.#ctx.scheduler.clearTimeout(timer);
      }
      this.#channel?.close();
    }
    if (clean) {
      await this.#ctx.backend.remove([keys.session(this.slot, this.id)]).catch(() => {});
    }
    this.#release();
  }

  // --- Changes --------------------------------------------------------------

  #onUpdate(update: Uint8Array, origin: unknown): void {
    if (this.#closed || origin === STORAGE_ORIGIN) return;
    const now = this.#ctx.scheduler.now();
    this.#pending.push(update);
    if (this.#pending.length === 1) this.#firstPendingAt = now;
    this.#lastChangeAt = now;
    this.#dirtySince ??= now;
    this.#changes++;
    if (!this.#status.pending || !this.#status.unsavedToFile) {
      this.#setStatus({ pending: true, unsavedToFile: true });
    }
    this.#scheduleFlush();
  }

  #onMessage(message: ChannelMessage): void {
    if (this.#closed || message.session === this.id || this.#absorbed.has(message.key))
      return;
    try {
      Y.applyUpdate(this.doc, message.update, STORAGE_ORIGIN);
      this.#absorbed.add(message.key);
    } catch {
      // The entry is in the journal; the next checkpoint reads it from there.
    }
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  #setStatus(change: Partial<SessionStatus>): void {
    const next = { ...this.#status, ...change };
    const keysOf = Object.keys(change) as (keyof SessionStatus)[];
    if (keysOf.every((key) => next[key] === this.#status[key])) return;
    this.#status = next;
    for (const listener of this.#listeners) {
      try {
        listener({ ...next });
      } catch {
        // A listener's error is not the store's.
      }
    }
  }

  #fail(error: unknown): void {
    this.#setStatus({ saving: false, problem: autosaveProblem(error) });
    this.#scheduleRetry();
  }

  // --- Timers ---------------------------------------------------------------

  #timer(current: unknown, ms: number, callback: () => void): unknown {
    if (current !== null) this.#ctx.scheduler.clearTimeout(current);
    return this.#ctx.scheduler.setTimeout(callback, Math.max(0, ms));
  }

  #scheduleFlush(): void {
    const t = this.#ctx.timing;
    const now = this.#ctx.scheduler.now();
    const delay = Math.min(
      t.journalDelay,
      this.#firstPendingAt + t.journalMaxDelay - now,
    );
    this.#flushTimer = this.#timer(this.#flushTimer, delay, () => {
      this.#flushTimer = null;
      void this.flush();
    });
  }

  #checkpointDue(): number | null {
    if (this.#dirtySince === null) return null;
    const t = this.#ctx.timing;
    let due = this.#lastChangeAt + t.checkpointIdle;
    if (this.#journalBytes < t.checkpointBytes) {
      due = Math.max(due, this.#lastCheckpointAt + t.checkpointInterval);
    }
    return Math.min(due, this.#dirtySince + t.checkpointMaxDelay);
  }

  #scheduleCheckpoint(): void {
    const due = this.#checkpointDue();
    if (due === null || this.#closed) return;
    this.#checkpointTimer = this.#timer(
      this.#checkpointTimer,
      due - this.#ctx.scheduler.now(),
      () => {
        this.#checkpointTimer = null;
        const again = this.#checkpointDue();
        if (again === null) return;
        if (again > this.#ctx.scheduler.now()) this.#scheduleCheckpoint();
        else void this.#enqueue(() => this.#checkpointNow()).catch(() => {});
      },
    );
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null || this.#closed) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(this.#retryDelay * 2, 60_000);
    this.#retryTimer = this.#ctx.scheduler.setTimeout(() => {
      this.#retryTimer = null;
      void this.#enqueue(async () => {
        if (await this.#flushNow()) await this.#checkpointNow();
      }).catch(() => {});
    }, delay);
  }

  #scheduleHeartbeat(): void {
    this.#heartbeatTimer = this.#ctx.scheduler.setTimeout(() => {
      this.#heartbeatTimer = null;
      if (this.#closed) return;
      this.#record = { ...this.#record, heartbeatAt: this.#ctx.scheduler.now() };
      void this.#enqueue(() => this.#writeRecord());
      this.#scheduleHeartbeat();
    }, this.#ctx.timing.heartbeatInterval);
  }

  #attachLifecycle(): void {
    if (!this.#ctx.lifecycle) return;
    const doc = (globalThis as { document?: Document }).document;
    const win = globalThis as {
      addEventListener?: Window["addEventListener"];
      removeEventListener?: Window["removeEventListener"];
    };
    if (!doc || typeof win.addEventListener !== "function") return;
    // The tab may be closed or frozen after it is hidden: store at once.
    const onHide = () => {
      if (doc.visibilityState === "hidden") void this.flush();
    };
    const onPageHide = () => void this.flush();
    doc.addEventListener("visibilitychange", onHide);
    win.addEventListener("pagehide", onPageHide);
    this.#detach.push(() => {
      doc.removeEventListener("visibilitychange", onHide);
      win.removeEventListener?.("pagehide", onPageHide);
    });
  }

  // --- Journal --------------------------------------------------------------

  async #flushNow(): Promise<boolean> {
    if (this.#flushTimer !== null) {
      this.#ctx.scheduler.clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#pending.length === 0) return true;
    const taken = this.#pending.length;
    const update =
      taken === 1 ? this.#pending[0]! : Y.mergeUpdates(this.#pending.slice(0, taken));
    const seq = ++this.#seq;
    const key = keys.entry(this.slot, this.id, seq);
    const now = this.#ctx.scheduler.now();
    const bytes = encodeFrame(
      FRAME_KIND.journal,
      { session: this.id, seq, at: now },
      update,
    );
    this.#setStatus({ saving: true });
    try {
      await this.#ctx.backend.write(key, bytes);
    } catch (error) {
      this.#fail(error);
      return false;
    }
    this.#pending.splice(0, taken);
    if (this.#pending.length > 0) this.#firstPendingAt = now;
    this.#absorbed.add(key);
    this.#journalBytes += bytes.length;
    this.#retryDelay = this.#ctx.timing.retryDelay;
    this.#channel?.post({ session: this.id, key, update });
    this.#setStatus({
      saving: false,
      pending: this.#pending.length > 0,
      lastStoredAt: now,
      problem: null,
    });
    const record = this.#record;
    if (
      !record.unsaved ||
      record.changedAt === null ||
      now - record.changedAt >= this.#ctx.timing.changedAtResolution
    ) {
      this.#record = { ...record, unsaved: true, changedAt: now };
      await this.#writeRecord();
    }
    this.#scheduleCheckpoint();
    return true;
  }

  async #writeRecord(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#ctx.backend.write(
        keys.session(this.slot, this.id),
        encodeJson(this.#record),
      );
    } catch {
      // Only the recovery offer depends on it; the journal holds the work.
    }
  }

  async #writeInfo(changed = true): Promise<void> {
    const meta = roots(this.doc).meta;
    const title = meta.get("title");
    const documentId = meta.get("id");
    this.#info = {
      ...this.#info,
      title: typeof title === "string" ? title : this.#info.title,
      documentId: typeof documentId === "string" ? documentId : this.#info.documentId,
      changedAt: changed ? this.#ctx.scheduler.now() : this.#info.changedAt,
    };
    try {
      await this.#ctx.backend.write(keys.info(this.slot), encodeJson(this.#info));
    } catch {
      // Descriptive only.
    }
  }

  // --- Checkpoints ----------------------------------------------------------

  /**
   * Brings in what other sessions stored: the newest readable checkpoint newer
   * than the one this session is based on, and every journal entry not yet in
   * the document.
   */
  async #mergeStored(): Promise<{
    generations: number[];
    base: number;
    baseIncludes: string[];
    journal: Set<string>;
  }> {
    const backend = this.#ctx.backend;
    const generations = (await backend.list(keys.checkpoints(this.slot)))
      .map(generationOf)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    let base = this.#generation;
    let baseIncludes = this.#baseIncludes;
    for (let i = generations.length - 1; i >= 0; i--) {
      const generation = generations[i]!;
      if (generation <= this.#generation) break;
      const bytes = await backend.read(keys.checkpoint(this.slot, generation));
      const loaded = bytes ? await loadCheckpoint(bytes) : null;
      if (!loaded) continue;
      const usable =
        loaded.mergeIdentityKept && lineageOf(loaded.doc) === lineageOf(this.doc);
      if (usable) {
        Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(loaded.doc), STORAGE_ORIGIN);
        for (const key of loaded.header.includes) this.#absorbed.add(key);
        base = generation;
        baseIncludes = loaded.header.includes;
      }
      loaded.doc.destroy();
      if (usable) break;
    }
    const journal = await backend.list(keys.journal(this.slot));
    const updates: Uint8Array[] = [];
    for (const key of journal) {
      if (this.#absorbed.has(key) || this.#skipped.has(key)) continue;
      const bytes = await backend.read(key);
      if (!bytes) continue;
      const frame = decodeFrame(bytes, FRAME_KIND.journal);
      if (!frame) {
        this.#skipped.add(key);
        continue;
      }
      updates.push(frame.payload);
      this.#absorbed.add(key);
    }
    applyStored(this.doc, updates);
    return { generations, base, baseIncludes, journal: new Set(journal) };
  }

  async #checkpointNow(): Promise<void> {
    if (this.#closed) return;
    if (this.#checkpointTimer !== null) {
      this.#ctx.scheduler.clearTimeout(this.#checkpointTimer);
      this.#checkpointTimer = null;
    }
    const backend = this.#ctx.backend;
    this.#setStatus({ saving: true });
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const merged = await this.#mergeStored();
        for (const key of this.#absorbed)
          if (!merged.journal.has(key)) this.#absorbed.delete(key);
        const top = merged.generations[merged.generations.length - 1] ?? 0;
        // A newer checkpoint that was merged is this session's base from now on.
        this.#generation = merged.base;
        this.#baseIncludes = merged.baseIncludes;
        const held = new Set(merged.baseIncludes);
        if (
          this.#dirtySince === null &&
          top === merged.base &&
          [...merged.journal].every((key) => held.has(key))
        ) {
          break;
        }
        // The state and the list of what it holds, taken together.
        const state = Y.encodeStateAsUpdate(this.doc);
        const includes = [...this.#absorbed].sort();
        const changes = this.#changes;
        const encoded = await this.#ctx.encoder(state);
        const generation = top + 1;
        const key = keys.checkpoint(this.slot, generation);
        const bytes = frameCheckpoint(
          {
            generation,
            base: merged.base,
            session: this.id,
            includes,
            createdAt: this.#ctx.scheduler.now(),
          },
          encoded,
          state,
        );
        if (!(await backend.create(key, bytes))) continue;
        // A session that listed long ago can create a generation that others
        // have since passed and removed. Such a checkpoint is stale: take it back.
        const after = (await backend.list(keys.checkpoints(this.slot))).map(generationOf);
        if (after.some((g) => g > generation)) {
          await backend.remove([key]);
          continue;
        }
        const back = await backend.read(key);
        this.#generation = generation;
        this.#baseIncludes = includes;
        this.#journalBytes = 0;
        this.#lastCheckpointAt = this.#ctx.scheduler.now();
        this.#dirtySince = this.#changes === changes ? null : this.#lastCheckpointAt;
        if (!sameBytes(back, bytes)) {
          throw new StorageError(
            "failed",
            "A checkpoint read back differs from what was written",
          );
        }
        // The previous base and what it holds stay: they are the last good copy
        // should this checkpoint be damaged later.
        const stale = merged.generations
          .filter((g) => g < generation && g !== merged.base)
          .map((g) => keys.checkpoint(this.slot, g));
        await backend.remove([...stale, ...merged.baseIncludes]);
        for (const entry of merged.baseIncludes) this.#absorbed.delete(entry);
        await this.#writeInfo();
        break;
      }
      this.#setStatus({ saving: false, problem: null });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    this.#scheduleCheckpoint();
  }
}

/** Reads an asset and checks its bytes against its id. */
export async function readAsset(
  backend: StorageBackend,
  slot: string,
  id: AssetId,
): Promise<Uint8Array | undefined> {
  const bytes = await backend.read(keys.asset(slot, id));
  if (!bytes) return undefined;
  return (await assetIdOf(bytes)) === id ? bytes : undefined;
}
