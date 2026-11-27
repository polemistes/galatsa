// SPDX-License-Identifier: GPL-3.0-or-later

// The editor core: one document, with work tracking attached before the first
// edit and one undo manager; the document's live resolver feeding the
// renderer; the editor services and the command environment that extensions
// get; the current tool; and the keyboard map. See docs/adr/0007.
//
// Nothing here touches the DOM until `mount`: the core runs over an attached
// 2D context (`attach`) and takes input as plain values, so it is tested in
// Node. `dom.ts` turns DOM events into those values.

import {
  type CameraView,
  type ElementId,
  type Fragment,
  type LiveResolver,
  type Point,
  type Rect,
} from "@galatsa/core";
import {
  createUndoManager,
  detachLiveResolver,
  liveResolver,
  trackWork,
  type DocumentUndoManager,
} from "@galatsa/core/ydoc";
import type { ContributionId, Label, Mode, Shortcut } from "@galatsa/extension-api";
import type {
  CommandEnvironment,
  CommandOutcome,
  Cursor,
  DrawContext,
  EditorHost,
  EditorServices,
  Modifiers,
  ToolKeyEvent,
  ToolPointerEvent,
} from "@galatsa/extension-api/editing";
import { BASICS } from "@galatsa/extension-basics";
import type { I18n, MessageValues } from "@galatsa/i18n";
import {
  CanvasRenderer,
  spaceMap,
  type Canvas2D,
  type ImageSource,
  type SceneAssets,
  type Viewport,
} from "@galatsa/renderer";
import type * as Y from "yjs";
import { fitCamera, panBy, screenToWorld, zoomAbout, type ScreenSize } from "./camera.ts";
import { documentAssets } from "./images.ts";
import {
  detectPlatform,
  isClipboardKey,
  matchShortcut,
  platformShortcut,
  type KeyInput,
  type Platform,
} from "./keymap.ts";
import { projectedContext, type Projection } from "./overlay.ts";
import { EditorScene } from "./scene-source.ts";
import {
  createServices,
  topLevel,
  type EditorState,
  type StateChange,
} from "./services.ts";
import { ToolController } from "./tools.ts";

/** Runs `frame` before the next repaint; returns how to cancel it. */
export type FrameScheduler = (frame: () => void) => () => void;

export interface EditorOptions {
  /** The document to edit. Work tracking is attached to it before anything else. */
  readonly doc: Y.Doc;
  /** The extensions, loaded (the basics extension among them, see `loadExtensions`). */
  readonly host: EditorHost;
  readonly i18n: I18n;
  /** Image bytes for the renderer; without it, images draw their stand-ins. */
  readonly images?: ImageSource;
  /** Natural pixel sizes of images; default the document's asset descriptions. */
  readonly assets?: SceneAssets;
  readonly mode?: Mode;
  /** The tool picked at start and after a tool is done (the first tool when absent). */
  readonly defaultTool?: ContributionId;
  readonly platform?: Platform;
  /** Default: requestAnimationFrame. */
  readonly schedule?: FrameScheduler;
  readonly background?: string;
}

/** A pointer event as the editor takes it: a position in CSS pixels of the drawing area. */
export interface PointerInput {
  readonly x: number;
  readonly y: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly button: number;
  readonly pressure: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export type EditorChange = StateChange | "tool" | "cursor";

/** What a key press did, for whoever wants to know (tests, a status line). */
export type KeyResult =
  | null
  /** The current tool used it. */
  | { readonly kind: "tool-key" }
  | ShortcutResult;

/** What a shortcut ran. */
export type ShortcutResult =
  | { readonly kind: "tool"; readonly tool: ContributionId }
  | {
      readonly kind: "command";
      readonly command: ContributionId;
      readonly outcome: CommandOutcome;
    };

const SELECTION_COLOR = "#2563eb";

function defaultScheduler(): FrameScheduler {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void })
    .cancelAnimationFrame;
  if (typeof raf === "function") {
    return (frame) => {
      const id = raf(frame);
      return () => caf?.(id);
    };
  }
  return (frame) => {
    const id = setTimeout(frame, 16);
    return () => clearTimeout(id);
  };
}

export class Editor {
  readonly doc: Y.Doc;
  readonly host: EditorHost;
  readonly i18n: I18n;
  /** The document's one undo manager. */
  readonly undo: DocumentUndoManager;
  readonly live: LiveResolver;
  readonly scene: EditorScene;
  readonly renderer: CanvasRenderer;
  readonly services: EditorServices;
  readonly tools: ToolController;
  readonly platform: Platform;
  readonly #state: EditorState;
  readonly #schedule: FrameScheduler;
  readonly #listeners = new Set<(change: EditorChange) => void>();
  readonly #cleanup: Array<() => void> = [];
  #cancelFrame: (() => void) | null = null;
  #cursor: Cursor = "default";
  #keymap: { mode: Mode; map: Map<Shortcut, ShortcutTarget> } | null = null;
  #clipboard: Fragment | null = null;
  #disposed = false;
  #version = 0;
  #inputEnabled = true;

  constructor(options: EditorOptions) {
    const doc = options.doc;
    // Before anything can write to the document: an edit made without the work
    // tracker is not recorded as work and loses against a concurrent delete
    // (docs/adr/0001, section 12, assumption 7). Attaching twice does nothing.
    trackWork(doc);
    this.doc = doc;
    this.host = options.host;
    this.i18n = options.i18n;
    this.platform = options.platform ?? detectPlatform();
    this.#schedule = options.schedule ?? defaultScheduler();
    this.undo = createUndoManager(doc);
    this.live = liveResolver(doc);
    this.scene = new EditorScene(doc, this.live);
    this.#state = {
      selection: [],
      camera: { space: null, cx: 0, cy: 0, zoom: 1 },
      mode: options.mode ?? "quick",
      openPanels: new Set(),
    };
    this.renderer = new CanvasRenderer({
      host: options.host,
      ...(options.images ? { images: options.images } : {}),
      assets: options.assets ?? documentAssets(doc),
      t: (label: Label, values?: MessageValues) => this.i18n.t(label, values),
      background: options.background ?? "#ffffff",
      onInvalidate: () => this.invalidate(),
    });
    this.renderer.setScene(this.scene);
    this.renderer.setCamera(this.#state.camera);
    this.renderer.setOverlay((ctx) => this.#drawOverlay(ctx));
    this.#cleanup.push(
      this.live.subscribe((changes) => {
        const ids = [...changes.added, ...changes.changed, ...changes.removed];
        this.renderer.applyChanges(ids);
        this.#pruneSelection();
        this.invalidate();
      }),
    );
    this.services = createServices(
      {
        live: this.live,
        scene: this.scene,
        renderer: this.renderer,
        screen: () => this.screen,
        invalidate: () => this.invalidate(),
        changed: (what) => {
          if (what === "mode") {
            this.#keymap = null;
            // A tool not offered in the new mode is put away.
            const current = this.tools.current;
            if (current !== null && !this.tools.available().some((t) => t.id === current))
              this.tools.selectDefault();
          }
          this.#emit(what);
        },
      },
      this.#state,
    );
    this.tools = new ToolController(
      {
        host: this.host,
        environment: () => this.environment(),
        run: <R>(command: ContributionId, args?: unknown) => this.run<R>(command, args),
        isEnabled: (command, args) => this.isEnabled(command, args),
        mode: () => this.#state.mode,
        scale: () => this.#state.camera.zoom * this.renderer.viewport.devicePixelRatio,
        invalidate: () => this.invalidate(),
        setCursor: (cursor) => {
          this.#cursor = cursor;
          this.#emit("cursor");
        },
        editText: (id) => {
          try {
            this.renderer.beginTextEdit(id);
            return true;
          } catch {
            // In-place text editing is not built yet.
            return false;
          }
        },
        toolChanged: () => this.#emit("tool"),
      },
      options.defaultTool ?? null,
    );
    this.tools.selectDefault();
  }

  /** The editor state behind the services. */
  get selection(): readonly ElementId[] {
    return this.#state.selection;
  }

  get camera(): CameraView {
    return this.#state.camera;
  }

  get mode(): Mode {
    return this.#state.mode;
  }

  get cursor(): Cursor {
    return this.#cursor;
  }

  /** The fragment the last copy gave, for paste (in memory; not the system clipboard). */
  get clipboard(): Fragment | null {
    return this.#clipboard;
  }

  /** What commands run against: this document, its undo manager and the services. */
  environment(): CommandEnvironment {
    return { doc: this.doc, undo: this.undo, services: this.services };
  }

  /**
   * Runs a command as one undo step, as a menu or a shortcut would. While a
   * gesture (a drag) is open on the document, commands that change the
   * document are refused ("disabled"): the drag ends in a command of its own,
   * and one run in the middle of it would leave the drag to commit over what
   * it changed (a move of an element just deleted, as an extra undo step).
   * Commands that do not change the document (undoable: false) still run;
   * undo and redo refuse by themselves until the gesture ends.
   */
  run<R = unknown>(command: ContributionId, args?: unknown): CommandOutcome<R> {
    const env = this.environment();
    if (this.host.commands.gestureActive(env)) {
      const entry = this.host.commands.get(command);
      if (entry !== undefined && entry.definition.undoable !== false)
        return { ok: false, reason: "disabled" };
    }
    return this.host.commands.execute<R>(command, env, args);
  }

  /** Whether `run` would accept the command now, with these arguments (a menu's check). */
  isEnabled(command: ContributionId, args?: unknown): boolean {
    const env = this.environment();
    if (this.host.commands.gestureActive(env)) {
      const entry = this.host.commands.get(command);
      if (entry !== undefined && entry.definition.undoable !== false) return false;
    }
    return this.host.commands.isEnabled(command, env, args);
  }

  /** Calls `listener` when the selection, camera, mode, panels, tool or cursor change. */
  subscribe(listener: (change: EditorChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Rises with every change listeners are told of (for the interface's reactive stores). */
  get version(): number {
    return this.#version;
  }

  #emit(change: EditorChange): void {
    this.#version++;
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Drops selected elements that are gone (after an undo of their creation, say). */
  #pruneSelection(): void {
    const selection = this.#state.selection;
    if (selection.length === 0) return;
    const kept = selection.filter(
      (id) => this.live.get(id) !== undefined && !this.live.isGone(id),
    );
    if (kept.length !== selection.length) this.services.selection.set(kept);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Draws the canvas into a 2D context of one's own (tests, an offscreen canvas). */
  attach(ctx: Canvas2D, viewport: Viewport): void {
    this.renderer.attach(ctx, viewport);
    this.invalidate();
  }

  /**
   * Adds the renderer's canvas to `container`; it follows the container's size
   * and the device pixel ratio. Input is the caller's (see `bindInput`).
   */
  mountCanvas(container: HTMLElement): void {
    this.renderer.mount(container);
    this.invalidate();
  }

  /** The size of the drawing area changed (with `attach`; a mounted canvas follows by itself). */
  setViewport(viewport: Viewport): void {
    this.renderer.setViewport(viewport);
    this.invalidate();
  }

  /** The size of the drawing area, in CSS pixels. */
  get screen(): ScreenSize {
    const { width, height } = this.renderer.viewport;
    return { width, height };
  }

  /** Something visible changed: draw again before the next repaint. */
  invalidate(): void {
    if (this.#disposed || this.#cancelFrame !== null) return;
    this.#cancelFrame = this.#schedule(() => {
      this.#cancelFrame = null;
      this.renderNow();
    });
  }

  /** Draws one frame now. */
  renderNow(): void {
    if (this.#disposed) return;
    this.renderer.render();
  }

  /**
   * The overlay, in screen space (CSS pixels): the selection outline from the
   * renderer's screen rectangles, then the tool's preview, which the tool
   * draws in root space through a projection.
   */
  #drawOverlay(ctx: DrawContext): void {
    const px = 1 / ctx.scale;
    for (const id of this.#state.selection) {
      const rect = this.renderer.screenBounds(id);
      if (rect === null) continue;
      const path = ctx.createPath();
      rect.corners.forEach((corner, i) => {
        if (i === 0) path.moveTo(corner.x, corner.y);
        else path.lineTo(corner.x, corner.y);
      });
      path.closePath();
      ctx.stroke(path, { color: SELECTION_COLOR, width: 2 * px });
    }
    this.tools.drawOverlay(projectedContext(ctx, this.projection(null)));
  }

  /**
   * How a space of the document (a container's, or the root's) lies on the
   * screen now: screen = point * scale + (ox, oy), in CSS pixels. Computed
   * from the offset between that space and the camera's, so it stays exact
   * wherever the camera is anchored.
   */
  projection(space: ElementId | null): Projection {
    const viewport = this.renderer.viewport;
    const camera = this.#state.camera;
    const map = spaceMap(camera, viewport, this.scene.offset(space, camera.space));
    const ratio = viewport.devicePixelRatio;
    return { space, scale: map.scale / ratio, ox: map.ox / ratio, oy: map.oy / ratio };
  }

  // -------------------------------------------------------------------------
  // The camera (the real controls come later; these are enough to reach things)
  // -------------------------------------------------------------------------

  screenToWorld(point: Point): Point {
    return screenToWorld(
      this.#state.camera,
      this.screen,
      (a, b) => this.scene.offset(a, b),
      point,
    );
  }

  /** Shows `rect` (root space by default) filling the view. */
  fit(rect: Rect, space: ElementId | null = null): void {
    this.services.camera.set(fitCamera(rect, space, this.screen));
  }

  /** Shows everything the document has at the top level. */
  fitAll(): void {
    let all: Rect | null = null;
    for (const id of topLevel(this.live)) {
      const b = this.live.bounds(id);
      if (b === null) continue;
      if (all === null) all = b;
      else {
        const x = Math.min(all.x, b.x);
        const y = Math.min(all.y, b.y);
        all = {
          x,
          y,
          w: Math.max(all.x + all.w, b.x + b.w) - x,
          h: Math.max(all.y + all.h, b.y + b.h) - y,
        };
      }
    }
    if (all !== null && this.screen.width > 0 && this.screen.height > 0) this.fit(all);
  }

  /** Zooms by `factor` about a point on screen. */
  zoomAt(point: Point, factor: number): void {
    if (!this.#inputEnabled) return;
    this.services.camera.set(zoomAbout(this.#state.camera, this.screen, point, factor));
  }

  /** Moves the canvas by a distance in screen pixels. */
  pan(dx: number, dy: number): void {
    if (!this.#inputEnabled) return;
    this.services.camera.set(panBy(this.#state.camera, dx, dy));
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #modifiers(e: {
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }): Modifiers {
    return {
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      mod: this.platform.mac ? e.metaKey : e.ctrlKey,
    };
  }

  #toolPointer(e: PointerInput): ToolPointerEvent {
    const screen = { x: e.x, y: e.y };
    return {
      screen,
      world: this.screenToWorld(screen),
      pointerType: e.pointerType,
      button: e.button,
      pressure: e.pressure,
      modifiers: this.#modifiers(e),
    };
  }

  /**
   * Whether the canvas takes input (pointer, keys, wheel). The program turns
   * it off while a document closes or offers to be saved as a file; a drag in
   * progress is then cancelled.
   */
  setInputEnabled(enabled: boolean): void {
    if (enabled === this.#inputEnabled) return;
    this.#inputEnabled = enabled;
    if (!enabled) this.tools.pointerCancel();
  }

  get inputEnabled(): boolean {
    return this.#inputEnabled;
  }

  pointerDown(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    this.tools.pointerDown(this.#toolPointer(e));
  }

  pointerMove(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    this.tools.pointerMove(this.#toolPointer(e));
  }

  pointerUp(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    this.tools.pointerUp(this.#toolPointer(e));
  }

  pointerCancel(): void {
    this.tools.pointerCancel();
  }

  /**
   * A key was pressed on the canvas. The current tool gets it first (Escape
   * cancels its drag); then the keyboard map: commands, then tools. Returns
   * null if nothing used it; otherwise the caller prevents the browser's
   * default (also when the command was disabled, so that Ctrl+D with nothing
   * selected does not open the browser's bookmark dialog).
   *
   * Copy, cut and paste (Mod+C, Mod+X, Mod+V) are left to the browser, which
   * then sends its copy, cut and paste events; the page passes those to
   * `clipboardCopy`, `clipboardCut` and `clipboardPaste`. So the system
   * clipboard can be used for them later.
   */
  keyDown(input: KeyInput & { readonly repeat?: boolean }): KeyResult {
    const toolEvent: ToolKeyEvent = {
      key: input.key,
      modifiers: this.#modifiers(input),
      repeat: input.repeat ?? false,
    };
    if (!this.#inputEnabled) return null;
    if (this.tools.keyDown(toolEvent)) return { kind: "tool-key" };
    if (isClipboardKey(input, this.platform)) return null;
    const match = matchShortcut(input, this.platform, this.#keymapFor().map);
    if (match === undefined) return null;
    const target = match.value;
    if (target.kind === "tool") {
      if (!input.repeat) this.tools.select(target.id);
      return { kind: "tool", tool: target.id };
    }
    return {
      kind: "command",
      command: target.id,
      outcome: this.runFromShortcut(target.id),
    };
  }

  keyUp(input: KeyInput): boolean {
    if (!this.#inputEnabled) return false;
    return this.tools.keyUp({
      key: input.key,
      modifiers: this.#modifiers(input),
      repeat: false,
    });
  }

  /** The browser's copy event: copies the selection. True if something was copied. */
  clipboardCopy(): boolean {
    if (!this.#inputEnabled || this.#state.selection.length === 0) return false;
    return this.runFromShortcut(BASICS.copy).ok;
  }

  /** The browser's cut event: copies the selection, then deletes it. */
  clipboardCut(): boolean {
    if (!this.clipboardCopy()) return false;
    return this.runFromShortcut(BASICS.delete).ok;
  }

  /** The browser's paste event: pastes what the last copy gave. */
  clipboardPaste(): boolean {
    if (!this.#inputEnabled) return false;
    return this.runFromShortcut(BASICS.paste).ok;
  }

  /**
   * Runs a command the way a shortcut or a menu does: with the selection as
   * its elements (`{ ids }`), and for the basics' copy and paste through the
   * editor's clipboard (in memory for now; the system clipboard comes with
   * the selection tool).
   */
  runFromShortcut(command: ContributionId): CommandOutcome {
    const ids = this.#state.selection;
    if (command === BASICS.paste) {
      if (this.#clipboard === null) return { ok: false, reason: "disabled" };
      return this.run(command, { fragment: this.#clipboard });
    }
    const outcome = this.run(command, ids.length > 0 ? { ids: [...ids] } : undefined);
    if (command === BASICS.copy && outcome.ok)
      this.#clipboard = outcome.value as Fragment;
    return outcome;
  }

  /** The keyboard map of the current mode: commands first, then the tools' shortcuts. */
  #keymapFor(): { mode: Mode; map: Map<Shortcut, ShortcutTarget> } {
    const mode = this.#state.mode;
    if (this.#keymap?.mode === mode) return this.#keymap;
    const map = new Map<Shortcut, ShortcutTarget>();
    for (const [shortcut, id] of this.host.commands.shortcuts(mode).map) {
      const key = platformShortcut(shortcut, this.platform);
      if (key !== undefined && !map.has(key)) map.set(key, { kind: "command", id });
    }
    for (const tool of this.host.tools(mode)) {
      for (const raw of tool.definition.shortcuts ?? []) {
        const key = platformShortcut(raw, this.platform);
        if (key !== undefined && !map.has(key))
          map.set(key, { kind: "tool", id: tool.id });
      }
    }
    this.#keymap = { mode, map };
    return this.#keymap;
  }

  /** The keyboard map of the current mode, shortcut to command or tool. */
  keymap(): ReadonlyMap<Shortcut, ShortcutTarget> {
    return this.#keymapFor().map;
  }

  /** The extensions changed (loaded or unloaded): rebuild what depends on them. */
  extensionsChanged(): void {
    this.#keymap = null;
    this.renderer.setScene(this.scene);
    const current = this.tools.current;
    if (current === null || !this.tools.available().some((t) => t.id === current))
      this.tools.selectDefault();
    this.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.tools.dispose();
    this.#disposed = true;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    for (const stop of this.#cleanup.splice(0)) stop();
    this.renderer.dispose();
    this.undo.destroy();
    detachLiveResolver(this.doc);
    this.#listeners.clear();
  }
}

export type ShortcutTarget =
  | { readonly kind: "command"; readonly id: ContributionId }
  | { readonly kind: "tool"; readonly id: ContributionId };
