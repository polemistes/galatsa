// SPDX-License-Identifier: GPL-3.0-or-later

// The editor program around the editor core: the storage layer (IndexedDB,
// with checkpoints built in a worker), the recovery offers at start
// (docs/adr/0006, section 7.1), opening a document, the editor over it, and
// the Svelte interface for panels and the storage dialogs.

import type { AssetId } from "@galatsa/core";
import type { ContributionId, Mode } from "@galatsa/extension-api";
import type {
  EditExtension,
  LoadProblem,
  ShortcutConflict,
  ViewExtension,
} from "@galatsa/extension-api/editing";
import type { I18n } from "@galatsa/i18n";
import {
  DocumentStorage,
  indexedDbBackend,
  memoryBackend,
  pickFileToOpen,
  workerEncoder,
  type DiscardResult,
  type Notice,
  type OpenResult,
  type RecoveryOffer,
  type StorageBackend,
  type StorageSession,
  type WorkerLike,
} from "@galatsa/storage";
import { mountEditor } from "./dom.ts";
import { EditorDocument } from "./document.ts";
import { Editor } from "./editor.ts";
import { loadExtensions } from "./extensions.ts";
import { assetImages } from "./images.ts";
import { checkDiscardFile, type DiscardFileCheck } from "./recovery.ts";

export type AppPhase =
  | "starting"
  /** Work from a program that stopped is offered (`offers`). */
  | "recovery"
  | "opening"
  | "editing"
  /** The document was closed. */
  | "closed"
  /** Nothing could be opened (`problem`). */
  | "failed";

export interface AppState {
  readonly phase: AppPhase;
  readonly offers: readonly RecoveryOffer[];
  readonly editor: Editor | null;
  readonly document: EditorDocument | null;
  /** Why opening failed: for "failed", or with the recovery offers. */
  readonly problem: Notice | null;
  /** The browser's storage could not be used: nothing is stored automatically. */
  readonly noStorage: boolean;
  /** Extensions left out at start. */
  readonly problems: readonly LoadProblem[];
  /** Shortcuts claimed twice in the current mode. */
  readonly conflicts: readonly ShortcutConflict[];
}

export interface EditorAppOptions {
  /** The element the program fills: the canvas and the panels go inside. */
  readonly root: HTMLElement;
  readonly i18n: I18n;
  /** The program's extensions; the basics extension is loaded before them. */
  readonly extensions: readonly (ViewExtension | EditExtension)[];
  /** Starts the checkpoint worker ("@galatsa/storage/checkpoint-worker"). */
  readonly createWorker?: () => WorkerLike;
  /** Default IndexedDB; the memory store if that cannot be opened. */
  readonly backend?: () => Promise<StorageBackend>;
  /** What to open when no recovered work is restored. */
  readonly openDefault: (storage: DocumentStorage) => Promise<OpenResult>;
  readonly defaultTool?: ContributionId;
  readonly mode?: Mode;
  /** Draws the interface (the editor's `renderEditorUi`); left out in tests. */
  readonly renderUi?: (app: EditorApp, container: HTMLElement) => () => void;
  /** Called when an editor is created over a document (after it is fitted). */
  readonly onEditor?: (editor: Editor) => void;
}

/** The checkpoint encoder in a worker, or on this thread if the worker cannot start. */
function encoderFor(createWorker: (() => WorkerLike) | undefined) {
  if (!createWorker) return undefined;
  try {
    return workerEncoder(createWorker());
  } catch {
    return undefined;
  }
}

export class EditorApp {
  readonly i18n: I18n;
  readonly storage: DocumentStorage;
  readonly #options: EditorAppOptions;
  readonly #loaded: ReturnType<typeof loadExtensions>;
  readonly #stage: HTMLElement;
  readonly #ui: HTMLElement;
  #state: AppState;
  readonly #listeners = new Set<(state: AppState) => void>();
  #unmountCanvas: (() => void) | null = null;
  #unmountUi: (() => void) | null = null;
  #stopDocument: (() => void) | null = null;
  #stopEditor: (() => void) | null = null;

  private constructor(
    options: EditorAppOptions,
    storage: DocumentStorage,
    noStorage: boolean,
  ) {
    this.#options = options;
    this.i18n = options.i18n;
    this.storage = storage;
    this.#loaded = loadExtensions(options.i18n, options.extensions);
    const root = options.root;
    root.replaceChildren();
    // The canvas and the panels are placed over each other inside the root.
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.style.overflow = "hidden";
    this.#stage = document.createElement("div");
    this.#stage.className = "galatsa-stage";
    Object.assign(this.#stage.style, { position: "absolute", inset: "0" });
    this.#ui = document.createElement("div");
    this.#ui.className = "galatsa-ui";
    root.append(this.#stage, this.#ui);
    this.#state = {
      phase: "starting",
      offers: [],
      editor: null,
      document: null,
      problem: null,
      noStorage,
      problems: this.#loaded.problems,
      conflicts: this.#loaded.conflicts[options.mode ?? "quick"],
    };
    this.#unmountUi = options.renderUi?.(this, this.#ui) ?? null;
  }

  /** Starts the program: the store, then recovery offers or the default document. */
  static async start(options: EditorAppOptions): Promise<EditorApp> {
    let backend: StorageBackend;
    let noStorage = false;
    try {
      backend = await (options.backend ?? (() => indexedDbBackend()))();
    } catch {
      backend = memoryBackend();
      noStorage = true;
    }
    const encodeCheckpoint = encoderFor(options.createWorker);
    const storage = new DocumentStorage({
      backend,
      ...(encodeCheckpoint ? { encodeCheckpoint } : {}),
    });
    const app = new EditorApp(options, storage, noStorage);
    const offers = await storage.recoverable().catch(() => []);
    if (offers.length > 0) app.#set({ phase: "recovery", offers });
    else await app.openDefault();
    return app;
  }

  get state(): AppState {
    return this.#state;
  }

  get host() {
    return this.#loaded.host;
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(change: Partial<AppState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Opens what the program opens when no recovered work is restored. */
  async openDefault(): Promise<void> {
    this.#set({ phase: "opening", offers: [] });
    await this.#show(await this.#options.openDefault(this.storage));
  }

  async #show(
    result: OpenResult | { ok: true; session: StorageSession; notices: Notice[] },
  ): Promise<void> {
    if (!result.ok) {
      this.#set({ phase: "failed", problem: result.problem });
      return;
    }
    this.#closeEditor();
    const session = result.session;
    const doc = new EditorDocument(
      session,
      { i18n: this.i18n, volatile: this.#state.noStorage },
      result.notices,
    );
    let editor: Editor | null = null;
    const images = assetImages(
      session.doc,
      (id: AssetId) => session.getAsset(id),
      (assets) => editor?.renderer.imagesChanged(assets),
    );
    editor = new Editor({
      doc: session.doc,
      host: this.#loaded.host,
      i18n: this.i18n,
      images,
      ...(this.#options.mode ? { mode: this.#options.mode } : {}),
      ...(this.#options.defaultTool ? { defaultTool: this.#options.defaultTool } : {}),
    });
    this.#unmountCanvas = mountEditor(editor, this.#stage, this.i18n);
    const created = editor;
    this.#stopEditor = editor.subscribe((change) => {
      if (change === "mode")
        this.#set({ conflicts: this.#loaded.conflicts[created.mode] });
    });
    this.#stopDocument = doc.subscribe((state) => {
      if (state.phase === "closed" && this.#state.document === doc) {
        this.#closeEditor();
        this.#set({ phase: "closed", editor: null });
      }
    });
    this.#set({ phase: "editing", editor, document: doc, problem: null });
    editor.fitAll();
    this.#options.onEditor?.(editor);
  }

  #closeEditor(): void {
    this.#stopDocument?.();
    this.#stopDocument = null;
    this.#stopEditor?.();
    this.#stopEditor = null;
    this.#unmountCanvas?.();
    this.#unmountCanvas = null;
    this.#state.editor?.dispose();
  }

  // --- Recovery offers (docs/adr/0006, section 7.1) --------------------------

  #without(slot: string): RecoveryOffer[] {
    return this.#state.offers.filter((o) => o.slot !== slot);
  }

  /** After an offer is settled: the next one, or the default document. */
  async #next(offers: RecoveryOffer[]): Promise<void> {
    if (offers.length > 0) this.#set({ offers });
    else await this.openDefault();
  }

  /** "Restore": opens the stored document with the recovered work. */
  async restore(slot: string): Promise<void> {
    this.#set({ phase: "opening" });
    const result = await this.storage.open(slot);
    if (!result.ok) {
      // The offer stays; the problem is shown with it.
      this.#set({ phase: "recovery", problem: result.problem });
      return;
    }
    this.#set({ offers: [], problem: null });
    await this.#show(result);
  }

  /** "Not now": offered again at the next start. */
  async later(slot: string): Promise<void> {
    await this.#next(this.#without(slot));
  }

  /** "Keep it, but don't ask again". */
  async dismiss(slot: string): Promise<void> {
    await this.storage.dismiss(slot).catch(() => {});
    await this.#next(this.#without(slot));
  }

  /**
   * "Discard the changes", for a document saved to a file: the user picks the
   * file (no file handle is kept yet), which is opened before the stored copy
   * goes. Resolves to null if the user did not pick a file. A file that is
   * not the same presentation is refused before anything is discarded
   * ("other-document"); the user can pick again.
   */
  async discard(
    slot: string,
  ): Promise<DiscardResult | Extract<DiscardFileCheck, { ok: false }> | null> {
    const offer = this.#state.offers.find((o) => o.slot === slot);
    if (offer === undefined) return null;
    const picked = await pickFileToOpen(this.i18n.t("editor:file.type"));
    if (picked === null) return null;
    const check = await checkDiscardFile(offer, picked);
    if (!check.ok) return check;
    const result = await this.storage.discardChanges(slot, check.file);
    if (result.ok) {
      this.#set({ offers: this.#without(slot) });
      await this.#show(result);
    }
    return result;
  }

  /** "Delete the presentation", after the user confirmed twice. */
  async deleteOffer(slot: string): Promise<boolean> {
    const deleted = await this.storage.deleteDocument(slot).catch(() => false);
    if (deleted) await this.#next(this.#without(slot));
    return deleted;
  }

  dispose(): void {
    this.#closeEditor();
    this.#state.document?.dispose();
    this.#unmountUi?.();
    this.#unmountUi = null;
    this.#listeners.clear();
  }
}
