// SPDX-License-Identifier: GPL-3.0-or-later

// One open document: it records every change in a journal shortly after it is
// made, folds the journal into checkpoints now and then, and saves to the user's
// file on request. Sections 4 and 5 of docs/adr/0006-storage.md.

import type { AssetId } from "@galatsa/core";
import { lineageOf, roots, toSnapshot } from "@galatsa/core/ydoc";
import {
  FileFormatError,
  assetIdOf,
  assetsToWrite,
  normalizePreviews,
  writeGalatsaFile,
  type AssetPreview,
  type PreviewFacts,
  type PreviewSource,
} from "@galatsa/format";
import * as Y from "yjs";
import {
  previewKey,
  readPreviews,
  storePreviews,
  storedPreviewFacts,
} from "./previews.ts";
import { StorageError, type StorageBackend } from "./backend.ts";
import {
  encodeCheckpointFile,
  frameCheckpoint,
  loadCheckpoint,
  type CheckpointEncoder,
  type EncodedCheckpoint,
} from "./checkpoint.ts";
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
  /**
   * How long the checkpoint encoder may take before the checkpoint is built on
   * this thread instead (and the encoder is not used again in this session).
   */
  checkpointTimeout: number;
  /**
   * How long saving to a file waits for the store (to flush, to bring in other
   * tabs' work, to read assets) before it goes on with what is in memory.
   */
  storeWait: number;
  /** How long `close()` waits for its last checkpoint and flush. */
  closeWait: number;
  /** First wait before trying a failed write again (doubles up to a minute). */
  retryDelay: number;
  /** How often a running session writes a sign of life into its record. */
  heartbeatInterval: number;
  /** A session without a sign of life for this long counts as stopped. */
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
  checkpointTimeout: 60_000,
  storeWait: 5000,
  closeWait: 90_000,
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
  /**
   * There are changes since the document was opened or last saved to a file.
   * A save by download does not clear it: nothing can confirm the file arrived.
   */
  unsavedToFile: boolean;
  /** The file the document was opened from or saved to, if any. */
  fileName: string | null;
  /** When the document was last handed to the browser as a download. */
  downloadedAt: number | null;
  /** Why changes are not reaching the store, while that lasts. */
  problem: Notice | null;
}

export type SaveResult = { ok: true; notices: Notice[] } | { ok: false; problem: Notice };

/**
 * What `close()` did. `ok: false` means changes are not in the store; unless
 * `evenIfUnstored` was passed, the session then stays open (`closed` is false)
 * and goes on trying, so the program can offer to save as a file first.
 */
export type CloseResult =
  { ok: true; closed: true } | { ok: false; closed: boolean; problem: Notice };

const TIMED_OUT = Symbol("timed out");

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

/**
 * A channel that was opened before the document was read, so that no entry
 * another tab stores while it is read can be missed. Messages wait until the
 * session takes them.
 */
export interface OpenChannel {
  channel: Channel;
  take(listener: (message: ChannelMessage) => void): void;
}

export function openChannel(
  factory: ChannelFactory | null,
  backend: StorageBackend,
  slot: string,
): OpenChannel | null {
  if (!factory) return null;
  const channel = factory(`galatsa-storage:${backend.name}:${slot}`);
  const waiting: ChannelMessage[] = [];
  let target: ((message: ChannelMessage) => void) | null = null;
  channel.listen((message) => (target ? target(message) : waiting.push(message)));
  return {
    channel,
    take(listener) {
      target = listener;
      for (const message of waiting.splice(0)) listener(message);
    },
  };
}

/** Where a session starts: a document loaded from (or just written to) a slot. */
export interface SessionStart {
  slot: string;
  doc: Y.Doc;
  /** The checkpoint the document was loaded from; 0 if none could be written. */
  generation: number;
  /** The journal entries that checkpoint holds. */
  baseIncludes: string[];
  /** Every journal entry whose content is in the document. */
  absorbed: Set<string>;
  /** Damaged journal entries, removed after the next checkpoint. */
  skipped?: Set<string>;
  info: SlotInfo;
  /** True if the document is not what its file holds (changes were restored). */
  unsavedToFile: boolean;
  /** True if the stored copy should be rewritten soon (it had damage). */
  needsCheckpoint: boolean;
  /** Asset bytes already in memory (from the file it was opened from). */
  assets?: ReadonlyMap<AssetId, Uint8Array>;
  /** Of those, the ones not yet in the store. */
  unstoredAssets?: ReadonlySet<AssetId>;
  /** Reduced versions of image assets already in memory (from the file). */
  previews?: ReadonlyMap<AssetId, readonly AssetPreview[]>;
  /** Of those, the assets whose previews are not yet in the store. */
  unstoredPreviews?: ReadonlySet<AssetId>;
  /** The channel to other tabs, opened before the document was read. */
  channel?: OpenChannel | null;
  /** Why the store could not take the document, if it could not. */
  problem?: Notice | null;
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
 * Drops the updates Yjs holds back because something they build on is missing
 * (after a damaged journal entry). Yjs would carry them into every encoded
 * state, and a state with such updates is not a complete document: the file
 * reader rejects it, and every later checkpoint would lose its merge identity.
 * Returns true if anything was dropped. What was dropped is still in the
 * journal entries it came from, and in the checkpoints of a session that had
 * what it builds on.
 */
export function dropPending(doc: Y.Doc): boolean {
  const store = doc.store;
  if (store.pendingStructs === null && store.pendingDs === null) return false;
  store.pendingStructs = null;
  store.pendingDs = null;
  return true;
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
  #skipped: Set<string>;
  #generation: number;
  #baseIncludes: string[];
  #journalBytes = 0;
  #changes = 0;
  #dirtySince: number | null = null;
  #lastChangeAt = 0;
  #lastCheckpointAt: number;
  /** Journal entries, session records and assets: short writes, in order. */
  #journalQueue: Promise<unknown> = Promise.resolve();
  /** Checkpoints and merges: long work that never holds up the journal. */
  #checkpointQueue: Promise<unknown> = Promise.resolve();
  #saves: Promise<unknown> = Promise.resolve();
  #flushTimer: unknown = null;
  #checkpointTimer: unknown = null;
  #retryTimer: unknown = null;
  #heartbeatTimer: unknown = null;
  #retryDelay: number;
  #encoderBroken = false;
  #status: SessionStatus;
  #listeners = new Set<(status: SessionStatus) => void>();
  #closed = false;
  #release: () => void = () => {};
  #open: OpenChannel | null;
  #startProblem: Notice | null;
  /** Asset bytes this session has seen, so a save works when the store does not. */
  #assets = new Map<AssetId, Uint8Array>();
  #unstoredAssets = new Set<AssetId>();
  /**
   * Previews this session made or opened from a file. A cache: kept so that a
   * save works when the store does not, and written to the store later if it
   * could not take them.
   */
  #previews = new Map<AssetId, readonly AssetPreview[]>();
  #unstoredPreviews = new Set<AssetId>();
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
    this.#skipped = start.skipped ?? new Set();
    this.#open = start.channel ?? null;
    this.#startProblem = start.problem ?? null;
    for (const [assetId, bytes] of start.assets ?? []) this.#assets.set(assetId, bytes);
    for (const assetId of start.unstoredAssets ?? []) this.#unstoredAssets.add(assetId);
    for (const [assetId, list] of start.previews ?? []) this.#previews.set(assetId, list);
    for (const assetId of start.unstoredPreviews ?? [])
      this.#unstoredPreviews.add(assetId);
    this.#retryDelay = ctx.timing.retryDelay;
    const now = ctx.scheduler.now();
    this.#lastCheckpointAt = now;
    if (start.needsCheckpoint || start.generation === 0) this.#dirtySince = now;
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
      downloadedAt: start.info.downloadedAt,
      problem: null,
    };
    const onUpdate = (update: Uint8Array, origin: unknown) =>
      this.#onUpdate(update, origin);
    this.doc.on("update", onUpdate);
    this.#detach.push(() => this.doc.off("update", onUpdate));
  }

  /**
   * Marks the session as running, writes its record and starts listening to
   * other tabs. Never fails because of the store: a store that cannot be
   * written to shows as the status's problem, and writing is tried again.
   */
  async start(): Promise<void> {
    // Running before the record exists, so that no other program can take
    // the record for one of a stopped session.
    try {
      this.#release = (await this.#ctx.liveness?.hold(this.id)) ?? (() => {});
    } catch {
      // Heartbeats tell instead.
    }
    let problem = this.#startProblem;
    try {
      await this.#ctx.backend.write(
        keys.session(this.slot, this.id),
        encodeJson(this.#record),
      );
      // The document may have been deleted elsewhere while it was opened:
      // then the first thing stored must be a whole checkpoint.
      const stored = await this.#ctx.backend.list(keys.checkpoints(this.slot));
      if (stored.length === 0) {
        this.#generation = 0;
        this.#dirtySince ??= this.#ctx.scheduler.now();
      }
    } catch (error) {
      problem ??= autosaveProblem(error);
    }
    this.#scheduleHeartbeat();
    this.#open ??= openChannel(this.#ctx.channels, this.#ctx.backend, this.slot);
    this.#open?.take((message) => this.#onMessage(message));
    this.#attachLifecycle();
    if (problem) {
      this.#setStatus({ problem });
      this.#scheduleRetry();
    } else if (this.#generation === 0 || this.#unstoredAssets.size > 0) {
      this.#scheduleRetry();
    }
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
    return this.#onJournal(() => this.#flushNow());
  }

  /**
   * Stores everything now and folds it into a new checkpoint (when something
   * changed since the last one). Rejects if the store fails; the changes stay
   * in memory and are written later.
   */
  checkpoint(): Promise<void> {
    return this.#onCheckpoints(() => this.#flushAndCheckpoint());
  }

  /**
   * Stores an asset's bytes (an image, a video) and returns its id. The caller
   * then describes it in the document (`addAsset`) in the command that uses it.
   * The bytes are also kept in memory for the session, so that saving to a
   * file works even if the store cannot be read; if the store cannot take them
   * now, they are written later.
   */
  async putAsset(bytes: Uint8Array): Promise<AssetId> {
    const id = await assetIdOf(bytes);
    this.#assets.set(id, bytes);
    try {
      await this.#ctx.backend.create(keys.asset(this.slot, id), bytes);
    } catch (error) {
      this.#unstoredAssets.add(id);
      this.#fail(error);
    }
    return id;
  }

  /** An asset's bytes, or undefined if they are missing or damaged. */
  async getAsset(id: AssetId): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readAsset(this.#ctx.backend, this.slot, id);
    } catch {
      bytes = undefined;
    }
    if (bytes) {
      this.#assets.set(id, bytes);
      return bytes;
    }
    return this.#assets.get(id);
  }

  /**
   * Stores reduced versions of an image asset (docs/adr/0012), made when the
   * image was added. They are kept in memory for the session too; if the
   * store cannot take them now, they are written later. Never fails: they are
   * a cache.
   */
  async putPreviews(id: AssetId, previews: readonly AssetPreview[]): Promise<void> {
    const list = normalizePreviews(previews);
    if (list.length === 0) return;
    this.#previews.set(id, list);
    try {
      await storePreviews(this.#ctx.backend, this.slot, id, list);
    } catch {
      this.#unstoredPreviews.add(id);
    }
  }

  /**
   * The pixel sizes and encodings of an asset's previews, smallest first,
   * without their bytes (the renderer's list of versions). Empty if there are
   * none, or the store cannot be read and none are in memory.
   */
  async previewFacts(id: AssetId): Promise<PreviewFacts[]> {
    try {
      const stored = await storedPreviewFacts(this.#ctx.backend, this.slot, id);
      if (stored.length > 0) return stored;
    } catch {
      // The store cannot be read: what is in memory.
    }
    return (this.#previews.get(id) ?? []).map(({ width, height, mediaType }) => ({
      width,
      height,
      mediaType,
    }));
  }

  /** The bytes of one preview, or undefined if it is not there. */
  async getPreview(id: AssetId, facts: PreviewFacts): Promise<Uint8Array | undefined> {
    const kept = this.#previews
      .get(id)
      ?.find((p) => p.width === facts.width && p.height === facts.height);
    if (kept) return kept.bytes;
    try {
      const bytes = await this.#ctx.backend.read(previewKey(this.slot, id, facts));
      return bytes !== undefined && bytes.length > 0 ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every preview of an asset with its bytes, smallest first (for saving a file). */
  async getPreviews(id: AssetId): Promise<AssetPreview[]> {
    try {
      const stored = await readPreviews(this.#ctx.backend, this.slot, id);
      if (stored.length > 0) return stored;
    } catch {
      // The store cannot be read: what is in memory.
    }
    return [...(this.#previews.get(id) ?? [])];
  }

  /**
   * Saves the document, with its assets, to a file the user chose. The file is
   * replaced atomically (see FileTarget), and read back to check it where that
   * is possible. A save that fails leaves the old file as it was; the document
   * stays safe in the store either way. Before saving, it brings in what other
   * tabs have stored. It works with what is in memory when the store cannot be
   * used, so saving as a file is always a way out.
   *
   * A target that cannot read back (a download) gives the notice
   * "save-downloaded", and the document still counts as not saved to a file.
   */
  saveToFile(
    target: FileTarget,
    options: { thumbnail?: Uint8Array } = {},
  ): Promise<SaveResult> {
    const run = async (): Promise<SaveResult> => {
      // The store gets a while to take the latest changes and to give what other
      // tabs stored; a store that fails or hangs does not stop the save.
      const wait = this.#ctx.timing.storeWait;
      try {
        await this.#within(this.flush(), wait);
        await this.#within(
          this.#onCheckpoints(() => this.#mergeStored()),
          wait,
        );
      } catch {
        // The store cannot be read: save what this session has.
      }
      const changes = this.#changes;
      let bytes: Uint8Array;
      let notices: Notice[];
      const download = !target.canRead;
      try {
        const assets = new Map<AssetId, Uint8Array>();
        const previewsOf = new Map<AssetId, readonly AssetPreview[]>();
        for (const id of assetsToWrite(toSnapshot(this.doc))) {
          const asset = await this.#within(this.getAsset(id), wait).catch(
            () => undefined,
          );
          const bytes =
            asset === TIMED_OUT || asset === undefined ? this.#assets.get(id) : asset;
          if (bytes) assets.set(id, bytes);
          const previews = await this.#within(this.getPreviews(id), wait).catch(
            () => undefined,
          );
          const list =
            previews === TIMED_OUT || previews === undefined || previews.length === 0
              ? this.#previews.get(id)
              : previews;
          if (list) previewsOf.set(id, list);
        }
        const writeOptions: {
          generator: string;
          thumbnail?: Uint8Array;
          previews: PreviewSource;
        } = {
          generator: this.#ctx.generator,
          previews: (id) => previewsOf.get(id),
        };
        if (options.thumbnail) writeOptions.thumbnail = options.thumbnail;
        const written = writeGalatsaFile(this.doc, (id) => assets.get(id), writeOptions);
        bytes = written.bytes;
        notices = fileNotices(written.warnings);
        await target.write(bytes);
      } catch (error) {
        return { ok: false, problem: saveProblem(error, target.name, download) };
      }
      if (download) {
        // Nothing confirms that the file exists: still unsaved.
        const now = this.#ctx.scheduler.now();
        this.#info = { ...this.#info, fileName: target.name, downloadedAt: now };
        await this.#within(
          this.#onJournal(() => this.#writeInfo(false)),
          wait,
        );
        this.#setStatus({ fileName: target.name, downloadedAt: now });
        return {
          ok: true,
          notices: [notice("save-downloaded", { name: target.name }), ...notices],
        };
      }
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
      const now = this.#ctx.scheduler.now();
      this.#info = { ...this.#info, fileName: target.name, savedToFileAt: now };
      if (this.#changes === changes) this.#record = { ...this.#record, unsaved: false };
      await this.#within(
        this.#onJournal(async () => {
          await this.#writeInfo(false);
          await this.#writeRecord();
        }),
        wait,
      );
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
   * Stores everything, writes a last checkpoint and ends the session.
   *
   * If changes could not be stored (the store is full, gone or does not answer
   * within `closeWait`), it says so and the session stays open and goes on
   * trying: the program should offer to save as a file, and may then close with
   * `evenIfUnstored`, which ends the session anyway. The session record then
   * stays, so the next start offers what reached the store.
   */
  async close(options: { evenIfUnstored?: boolean } = {}): Promise<CloseResult> {
    if (this.#closed) return { ok: true, closed: true };
    let problem: Notice | null = null;
    try {
      const done = await this.#within(
        (async () => {
          try {
            await this.checkpoint();
          } catch {
            // What matters is that every change is in the journal.
          }
          return this.flush();
        })(),
        this.#ctx.timing.closeWait,
      );
      if (done !== true || this.#pending.length > 0) {
        problem =
          this.#status.problem ?? notice("autosave-failed", undefined, "close timed out");
      }
    } catch (error) {
      problem = autosaveProblem(error);
    }
    if (problem && !options.evenIfUnstored) return { ok: false, closed: false, problem };
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
    this.#open?.channel.close();
    if (!problem) {
      await this.#within(
        this.#ctx.backend.remove([keys.session(this.slot, this.id)]),
        this.#ctx.timing.storeWait,
      ).catch(() => {});
    }
    this.#release();
    return problem ? { ok: false, closed: true, problem } : { ok: true, closed: true };
  }

  /** The work's result, or TIMED_OUT after `ms` (by the session's clock). */
  async #within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: unknown = null;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = this.#ctx.scheduler.setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== null) this.#ctx.scheduler.clearTimeout(timer);
    }
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
    // The timer looks again when it fires, so it is armed once, not per change.
    if (this.#checkpointTimer === null) this.#scheduleCheckpoint();
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

  #onJournal<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#journalQueue.then(task, task);
    this.#journalQueue = run.catch(() => {});
    return run;
  }

  #onCheckpoints<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#checkpointQueue.then(task, task);
    this.#checkpointQueue = run.catch(() => {});
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
        else void this.checkpoint().catch(() => {});
      },
    );
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null || this.#closed) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(this.#retryDelay * 2, 60_000);
    this.#retryTimer = this.#ctx.scheduler.setTimeout(() => {
      this.#retryTimer = null;
      void this.checkpoint().catch(() => {});
    }, delay);
  }

  #scheduleHeartbeat(): void {
    // Written also where locks tell running sessions apart: if asking the
    // locks fails, the heartbeats must be there to fall back on.
    this.#heartbeatTimer = this.#ctx.scheduler.setTimeout(() => {
      this.#heartbeatTimer = null;
      if (this.#closed) return;
      this.#record = { ...this.#record, heartbeatAt: this.#ctx.scheduler.now() };
      void this.#onJournal(() => this.#writeRecord());
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

  async #storeAssets(): Promise<void> {
    for (const id of [...this.#unstoredAssets]) {
      const bytes = this.#assets.get(id);
      if (bytes) await this.#ctx.backend.create(keys.asset(this.slot, id), bytes);
      this.#unstoredAssets.delete(id);
    }
    for (const id of [...this.#unstoredPreviews]) {
      const list = this.#previews.get(id);
      if (list) await storePreviews(this.#ctx.backend, this.slot, id, list);
      this.#unstoredPreviews.delete(id);
    }
  }

  async #flushNow(): Promise<boolean> {
    if (this.#flushTimer !== null) {
      this.#ctx.scheduler.clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    try {
      await this.#storeAssets();
    } catch (error) {
      this.#fail(error);
      return false;
    }
    if (this.#pending.length === 0) return true;
    if (this.#generation === 0) {
      // No checkpoint yet: entries would have nothing to apply to. The next
      // checkpoint holds these changes; it is written first.
      this.#scheduleRetry();
      return false;
    }
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
    this.#open?.channel.post({ session: this.id, key, update });
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
   * than the one this session is based on, and every intact journal entry not
   * yet in the document. Damaged entries are noted, never taken as held.
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
    dropPending(this.doc);
    return { generations, base, baseIncludes, journal: new Set(journal) };
  }

  /** The encoder, with a time limit; this thread when it fails or hangs. */
  async #encode(state: Uint8Array): Promise<EncodedCheckpoint> {
    const local = () => encodeCheckpointFile(state, this.#ctx.generator);
    if (this.#encoderBroken) return local();
    let timer: unknown = null;
    const timeout = new Promise<null>((resolve) => {
      timer = this.#ctx.scheduler.setTimeout(
        () => resolve(null),
        this.#ctx.timing.checkpointTimeout,
      );
    });
    try {
      const result = await Promise.race([
        this.#ctx.encoder(state).then(
          (encoded) => encoded,
          (error: unknown) => {
            if (error instanceof FileFormatError) throw error;
            return null;
          },
        ),
        timeout,
      ]);
      if (result) return result;
      this.#encoderBroken = true;
      return local();
    } finally {
      if (timer !== null) this.#ctx.scheduler.clearTimeout(timer);
    }
  }

  /** Flushes the journal, then writes a checkpoint (one first if there is none). */
  async #flushAndCheckpoint(): Promise<void> {
    if (this.#generation === 0) await this.#checkpointNow();
    if (!(await this.flush())) {
      throw (
        this.#status.problem?.cause ??
        new StorageError("failed", "The journal could not be written")
      );
    }
    await this.#checkpointNow();
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
        const damaged = [...this.#skipped].filter((key) => merged.journal.has(key));
        if (
          this.#dirtySince === null &&
          top > 0 &&
          top === merged.base &&
          damaged.length === 0 &&
          [...merged.journal].every((key) => held.has(key))
        ) {
          break;
        }
        // The state and the list of what it holds, taken together.
        const state = Y.encodeStateAsUpdate(this.doc);
        const includes = [...this.#absorbed].sort();
        const changes = this.#changes;
        const encoded = await this.#encode(state);
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
        // Only one session can create a generation; the one that loses merges
        // the winner's checkpoint and tries again.
        if (!(await backend.create(key, bytes))) continue;
        const back = await backend.read(key);
        this.#generation = generation;
        this.#baseIncludes = includes;
        this.#journalBytes = 0;
        this.#lastCheckpointAt = this.#ctx.scheduler.now();
        this.#dirtySince = this.#changes === changes ? null : this.#lastCheckpointAt;
        if (!sameBytes(back, bytes)) {
          // Nothing is removed: the store does not keep what it is given.
          throw new StorageError(
            "failed",
            "A checkpoint read back differs from what was written",
          );
        }
        // The previous base and what it holds stay: they are the last good copy
        // should this checkpoint be damaged later. Damaged entries hold nothing
        // that can be used, and go.
        const stale = merged.generations
          .filter((g) => g < generation && g !== merged.base)
          .map((g) => keys.checkpoint(this.slot, g));
        await backend.remove([...stale, ...merged.baseIncludes, ...damaged]);
        for (const entry of merged.baseIncludes) this.#absorbed.delete(entry);
        for (const entry of damaged) this.#skipped.delete(entry);
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
