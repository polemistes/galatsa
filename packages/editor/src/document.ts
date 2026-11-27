// SPDX-License-Identifier: GPL-3.0-or-later

// One open document as the storage layer holds it (docs/adr/0006), and what
// the editor must do with it (section 7.1 there): show the save status and
// problems, warn before the window closes while changes are not stored, offer
// to save as a file before a document with unstored changes is closed, show
// that closing is going on, and ask for persistent storage once there is work
// worth keeping.
//
// Closing: if the store has a problem, the offer comes at once. If changes are
// only waiting for their turn (`pending`), they are stored first (a flush,
// which normally takes well under a second) and the offer comes only if that
// does not clear them, so that closing right after an edit does not always
// ask. Then `close()`; if it answers that not everything reached the store,
// the offer comes, and only after it may the document be closed anyway
// (`evenIfUnstored`).
//
// Without the browser's storage (the program fell back to a store in memory,
// which a reload or a closed tab loses), "stored" means nothing: the status
// never says "Saved", and leaving or closing warns and offers to save as a
// file whenever there are changes not saved to a file.

import { roots } from "@galatsa/core/ydoc";
import { FILE_EXTENSION } from "@galatsa/format";
import type { I18n } from "@galatsa/i18n";
import {
  pickFileToSave,
  requestPersistentStorage,
  type FileTarget,
  type Notice,
  type SaveResult,
  type SessionStatus,
  type StorageSession,
} from "@galatsa/storage";

export type DocumentPhase =
  /** Open for editing. */
  | "open"
  /** Closing: storing the last changes. */
  | "closing"
  /** Not everything is stored: the user is offered to save as a file before closing. */
  | "offer-save"
  | "closed";

export interface DocumentState {
  readonly phase: DocumentPhase;
  readonly status: SessionStatus;
  /** Notices to show until the user dismisses them, newest last. */
  readonly notices: readonly Notice[];
  /** A save to a file is running. */
  readonly savingFile: boolean;
  /** The store is in memory only: nothing survives a reload (`DocumentOptions.volatile`). */
  readonly volatile: boolean;
}

/** The save status in words: a message key of the editor or the storage layer, and its values. */
export function statusMessage(
  state: DocumentState,
): { readonly key: string; readonly values?: { readonly when: number } } | null {
  const s = state.status;
  if (state.phase === "closing") return { key: "editor:status.closing" };
  if (state.savingFile) return { key: "editor:status.savingFile" };
  if (state.volatile) {
    // Only a file keeps the work: "stored" in memory is not saved.
    return s.unsavedToFile || s.fileName === null
      ? { key: "editor:status.notStored" }
      : null;
  }
  if (s.problem !== null) return { key: "storage:status.failed" };
  if (s.saving || s.pending) return { key: "storage:status.saving" };
  if (s.unsavedToFile && s.fileName !== null)
    return { key: "storage:status.unsavedToFile" };
  if (s.lastStoredAt !== null)
    return { key: "storage:status.saved", values: { when: s.lastStoredAt } };
  return null;
}

/** How long closing waits for changes that are only waiting for their turn. */
const FLUSH_WAIT_MS = 5000;

/** Persistent storage is asked for once per program run. */
let persistenceAsked = false;

export interface DocumentOptions {
  readonly i18n: I18n;
  /** Where to save; default the file picker (or a download where there is none). */
  readonly pickTarget?: (suggestedName: string) => Promise<FileTarget | null>;
  /** Default `requestPersistentStorage` from the storage layer. */
  readonly requestPersistence?: () => Promise<boolean>;
  /** Warn before the window closes while changes are not stored (default: in a browser). */
  readonly warnOnUnload?: boolean;
  /**
   * The store is in memory only (the browser's storage could not be used):
   * changes not saved to a file are lost when the page goes.
   */
  readonly volatile?: boolean;
}

export class EditorDocument {
  readonly session: StorageSession;
  readonly #i18n: I18n;
  readonly #options: DocumentOptions;
  #state: DocumentState;
  readonly #listeners = new Set<(state: DocumentState) => void>();
  readonly #cleanup: Array<() => void> = [];

  constructor(
    session: StorageSession,
    options: DocumentOptions,
    notices: readonly Notice[] = [],
  ) {
    this.session = session;
    this.#i18n = options.i18n;
    this.#options = options;
    this.#state = {
      phase: session.closed ? "closed" : "open",
      status: session.status,
      notices: [...notices],
      savingFile: false,
      volatile: options.volatile === true,
    };
    this.#cleanup.push(
      session.subscribe((status) => {
        this.#set({ status });
        if (status.pending || status.unsavedToFile) this.#askPersistence();
      }),
    );
    const win = (globalThis as { window?: Window }).window;
    if (win !== undefined && options.warnOnUnload !== false) {
      const onUnload = (event: BeforeUnloadEvent): void => {
        if (!this.wouldLoseWork()) return;
        event.preventDefault();
        // Browsers show their own text; some still want a value here.
        event.returnValue = this.#i18n.t("editor:unload.warning");
      };
      win.addEventListener("beforeunload", onUnload);
      this.#cleanup.push(() => win.removeEventListener("beforeunload", onUnload));
    }
  }

  get state(): DocumentState {
    return this.#state;
  }

  /**
   * True if work would be lost if the page went now: changes not in the store
   * (or a store with a problem), or, with a store in memory only, changes not
   * saved to a file.
   */
  wouldLoseWork(): boolean {
    if (this.#state.phase === "closed") return false;
    const { pending, problem, unsavedToFile } = this.session.status;
    return pending || problem !== null || (this.#state.volatile && unsavedToFile);
  }

  subscribe(listener: (state: DocumentState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(change: Partial<DocumentState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch (error) {
        console.error(error);
      }
    }
  }

  #askPersistence(): void {
    if (persistenceAsked) return;
    persistenceAsked = true;
    void (this.#options.requestPersistence ?? requestPersistentStorage)().catch(
      () => false,
    );
  }

  /** The document's title, or "Untitled presentation". */
  title(): string {
    const title = roots(this.session.doc).meta.get("title");
    return typeof title === "string" && title.trim() !== ""
      ? title
      : this.#i18n.t("editor:document.untitled");
  }

  /** A file name to suggest when saving. */
  suggestedName(): string {
    const name = this.session.status.fileName;
    if (name !== null && name !== "") return name;
    return `${this.title()}${FILE_EXTENSION}`;
  }

  addNotices(notices: readonly Notice[]): void {
    if (notices.length > 0) this.#set({ notices: [...this.#state.notices, ...notices] });
  }

  dismissNotice(index: number): void {
    const notices = this.#state.notices.filter((_, i) => i !== index);
    this.#set({ notices });
  }

  /**
   * Lets the user choose a file and saves the document to it. Resolves to
   * null if the user cancelled the choice. Its notices are shown.
   */
  async saveAsFile(): Promise<SaveResult | null> {
    const pick =
      this.#options.pickTarget ??
      ((name: string) => pickFileToSave(name, this.#i18n.t("editor:file.type")));
    const target = await pick(this.suggestedName());
    if (target === null) return null;
    this.#set({ savingFile: true });
    try {
      const result = await this.session.saveToFile(target);
      this.addNotices(result.ok ? result.notices : [result.problem]);
      return result;
    } finally {
      this.#set({ savingFile: false });
    }
  }

  /**
   * Closes the document, or stops at the offer to save as a file when not
   * everything is stored ("offer-save"). Then `saveAsFile`, and `closeAnyway`
   * or `keepOpen`.
   */
  async close(): Promise<DocumentPhase> {
    if (this.#state.phase === "closed" || this.#state.phase === "closing")
      return this.#state.phase;
    this.#set({ phase: "closing" });
    let status = this.session.status;
    if (status.problem === null && status.pending) {
      await Promise.race([
        this.session.flush().catch(() => false),
        new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS)),
      ]);
      status = this.session.status;
    }
    if (
      status.problem !== null ||
      status.pending ||
      (this.#state.volatile && status.unsavedToFile)
    ) {
      this.#set({ phase: "offer-save", status });
      return "offer-save";
    }
    const result = await this.session.close();
    if (!result.ok) {
      this.#set({
        phase: "offer-save",
        notices: [...this.#state.notices, result.problem],
      });
      return "offer-save";
    }
    this.#closed();
    return "closed";
  }

  /**
   * After the offer: saves as a file, and closes if the file is known to hold
   * everything. A download is not: nothing can confirm that it arrived (the
   * user may cancel the browser's dialog), so the offer stays, with the notice
   * that tells the user to check the downloads folder, and the user closes.
   */
  async saveThenClose(): Promise<DocumentPhase> {
    if (this.#state.phase !== "offer-save" || this.#state.savingFile)
      return this.#state.phase;
    const result = await this.saveAsFile();
    const confirmed =
      result?.ok === true && !result.notices.some((n) => n.code === "save-downloaded");
    if (confirmed && this.#state.phase === "offer-save") await this.closeAnyway();
    return this.#state.phase;
  }

  /** After the offer: closes although not everything is stored. */
  async closeAnyway(): Promise<void> {
    this.#set({ phase: "closing" });
    await this.session.close({ evenIfUnstored: true });
    this.#closed();
  }

  /** After the offer: goes back to editing. */
  keepOpen(): void {
    if (this.#state.phase === "offer-save") this.#set({ phase: "open" });
  }

  #closed(): void {
    this.#set({ phase: "closed", status: this.session.status });
    this.dispose();
  }

  /** Stops listening to the session and the window (closing does this itself). */
  dispose(): void {
    for (const stop of this.#cleanup.splice(0)) stop();
  }
}
