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
  SpacePoint,
  ToolPointerEvent,
} from "@galatsa/extension-api/editing";
import { BASICS, readFragment } from "@galatsa/extension-basics";
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
import {
  fragmentBounds,
  withinLimits,
  writeFragment,
  type ClipboardContent,
  type ClipboardOrigin,
  type ClipboardProblem,
  type ClipboardTarget,
} from "./clipboard.ts";
import { ContextMenu } from "./context-menu.ts";
import { CameraControl } from "./camera-control.ts";
import { screenToWorld, type ScreenSize } from "./camera.ts";
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

export type EditorChange = StateChange | "tool" | "cursor" | "notice";

/** A message the interface shows (a message key of the editor's bundle). */
export interface EditorNotice {
  readonly message: string;
}

/** The notice for each reason a paste is refused. */
const PASTE_PROBLEMS: { readonly [problem in ClipboardProblem]: string } = {
  "too-large": "editor:paste.tooLarge",
  "other-version": "editor:paste.otherVersion",
  damaged: "editor:paste.damaged",
};

/** What a key press did, for whoever wants to know (tests, a status line). */
export type KeyResult =
  | null
  /** The current tool used it. */
  | { readonly kind: "tool-key" }
  /** Space: the hand is out (a drag moves the canvas). */
  | { readonly kind: "hand" }
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
  #clipboard: { readonly fragment: Fragment; readonly origin: ClipboardOrigin } | null =
    null;
  #notice: EditorNotice | null = null;
  /** The context menu (right click), drawn by the interface. */
  readonly contextMenu = new ContextMenu();
  #disposed = false;
  #version = 0;
  #inputEnabled = true;
  /** The camera controls (anchoring, zoom, pan, the hand). */
  readonly #view: CameraControl;
  /** A pointer is down and belongs to the tool. */
  #toolPointer = false;
  /** What the tool's press may take back (`pointerWithdraw`): the state before it. */
  #press: {
    readonly selection: readonly ElementId[];
    readonly tool: ContributionId | null;
    /** The undo steps before the press, and the last of them. */
    readonly steps: number;
    readonly top: unknown;
  } | null = null;

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
    this.#view = new CameraControl({
      live: this.live,
      scene: this.scene,
      screen: () => this.screen,
      camera: () => this.#state.camera,
      setCamera: (view) => this.services.camera.set(view),
      cursorChanged: () => this.#emit("cursor"),
    });
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
        this.#view.documentChanged();
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
        placeCamera: (view) => this.#view.place(view),
        previewChanged: () => this.#view.follow(),
        toScreen: (point) => this.#view.toScreen(point),
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
    return this.#view.handCursor ?? this.#cursor;
  }

  /**
   * The fragment the last copy in this editor gave. The system clipboard
   * carries it too; this copy is for a paste from the context menu where the
   * browser does not let the page read the clipboard.
   */
  get clipboard(): Fragment | null {
    return this.#clipboard?.fragment ?? null;
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
  // The camera (camera-control.ts, docs/adr/0009)
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
    this.services.camera.fit(rect, space);
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

  /** Zooms by `factor` about a point on screen, which stays where it is. */
  zoomAt(point: Point, factor: number): void {
    if (!this.#inputEnabled) return;
    this.#view.zoomAt(point, factor);
  }

  /** Moves the canvas by a distance in screen pixels. */
  pan(dx: number, dy: number): void {
    if (!this.#inputEnabled) return;
    this.#view.pan(dx, dy);
  }

  /**
   * Two fingers moved (or a pinch on a trackpad): the point that was between
   * them at `from` (on screen) is now at `to`, and the view is scaled by `factor`.
   */
  pinch(from: Point, to: Point, factor: number): void {
    if (!this.#inputEnabled) return;
    this.#view.pinch(from, to, factor);
  }

  /** A point on screen in the camera's own space, exact at any zoom. */
  pointerAt(screen: Point): SpacePoint {
    return this.#view.pointAt(screen);
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

  #toolEvent(e: PointerInput): ToolPointerEvent {
    const screen = { x: e.x, y: e.y };
    const world = this.screenToWorld(screen);
    this.#view.notePointer(screen, world);
    return {
      screen,
      world,
      local: this.#view.pointAt(screen),
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
    if (!enabled) {
      this.#toolPointer = false;
      this.tools.pointerCancel();
      this.#view.handUp(null);
      this.#view.releaseHand();
    }
  }

  get inputEnabled(): boolean {
    return this.#inputEnabled;
  }

  pointerDown(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    if (this.#view.handDown({ x: e.x, y: e.y })) return;
    this.#toolPointer = true;
    const stack = this.undo.undoStack;
    this.#press = {
      selection: this.#state.selection,
      tool: this.tools.current,
      steps: stack.length,
      top: stack[stack.length - 1],
    };
    this.tools.pointerDown(this.#toolEvent(e));
  }

  pointerMove(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    if (this.#view.handMove({ x: e.x, y: e.y })) return;
    this.tools.pointerMove(this.#toolEvent(e));
  }

  pointerUp(e: PointerInput): void {
    if (!this.#inputEnabled) return;
    if (this.#view.handUp({ x: e.x, y: e.y })) return;
    this.#toolPointer = false;
    this.tools.pointerUp(this.#toolEvent(e));
  }

  pointerCancel(): void {
    if (this.#view.handUp(null)) return;
    this.#toolPointer = false;
    this.tools.pointerCancel();
  }

  /**
   * The press turned out to be the first finger of a pinch: everything it did
   * is taken back. The hand lets go of it, or the tool's drag is cancelled,
   * then every undo step made since the press is undone and dropped from the
   * redo stack (a tool may run a command as soon as the finger goes down, as
   * the text sketch does), and the selection and the tool are put back as
   * they were before the press. Steps are only taken back while the stack
   * still holds the step that was last before the press, so nothing older is
   * ever undone.
   */
  pointerWithdraw(): void {
    if (this.#view.handUp(null)) return;
    const press = this.#press;
    if (!this.#toolPointer || press === null) return;
    this.pointerCancel();
    this.#press = null;
    const undo = this.undo;
    if (undo.undoStack[press.steps - 1] === press.top) {
      let taken = 0;
      while (undo.undoStack.length > press.steps) {
        const length = undo.undoStack.length;
        undo.undo();
        if (undo.undoStack.length >= length) break;
        taken++;
      }
      undo.redoStack.splice(Math.max(0, undo.redoStack.length - taken), taken);
    }
    if (press.tool !== null && this.tools.current !== press.tool)
      this.tools.select(press.tool);
    this.services.selection.set(press.selection);
  }

  /** The canvas lost focus: keys held down (Space) are let go. */
  focusLost(): void {
    this.#view.releaseHand();
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
   * `clipboardCopy`, `clipboardCut` and `clipboardPaste`, with the system
   * clipboard's data.
   */
  keyDown(input: KeyInput & { readonly repeat?: boolean }): KeyResult {
    const toolEvent: ToolKeyEvent = {
      key: input.key,
      modifiers: this.#modifiers(input),
      repeat: input.repeat ?? false,
    };
    if (!this.#inputEnabled) return null;
    if (this.tools.keyDown(toolEvent)) return { kind: "tool-key" };
    if (isHandKey(input) && this.#view.holdHand(this.#toolPointer))
      return { kind: "hand" };
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
    // Space let go with a modifier held still puts the hand away.
    if (input.key === " " && this.#view.releaseHand()) return true;
    return this.tools.keyUp({
      key: input.key,
      modifiers: this.#modifiers(input),
      repeat: false,
    });
  }

  /**
   * The browser's copy event: copies the selection, onto `target` (the
   * event's clipboard data) and into the editor's memory, with where it was
   * copied from. True if something was copied.
   */
  clipboardCopy(target?: ClipboardTarget): boolean {
    if (!this.#inputEnabled || this.#state.selection.length === 0) return false;
    const outcome = this.runFromShortcut(BASICS.copy);
    if (!outcome.ok || this.#clipboard === null) return false;
    if (target !== undefined)
      writeFragment(target, this.#clipboard.fragment, this.#clipboard.origin);
    return true;
  }

  /** The browser's cut event: copies the selection, then deletes it. */
  clipboardCut(target?: ClipboardTarget): boolean {
    if (!this.clipboardCopy(target)) return false;
    return this.runFromShortcut(BASICS.delete).ok;
  }

  /**
   * The browser's paste event, with what the clipboard holds (`readClipboard`
   * of its data): pastes a fragment of the program. Text and files from other
   * programs are not pasted yet (false, so the browser's default goes on).
   * What the program does not paste (too large, another version, damaged) is
   * told in a notice. Without `content`, pastes what the last copy in this
   * editor gave. True if something was pasted.
   */
  clipboardPaste(content?: ClipboardContent): boolean {
    if (!this.#inputEnabled) return false;
    if (content === undefined) {
      if (this.#clipboard === null) return false;
      return this.#paste(this.#clipboard.fragment, this.#clipboard.origin).ok;
    }
    if (content.problem !== null) {
      this.#notify(PASTE_PROBLEMS[content.problem]);
      return false;
    }
    if (content.fragment === undefined) return false;
    return this.#paste(content.fragment, content.origin).ok;
  }

  /** Pastes a fragment (still unchecked) where it was copied from, within the limits. */
  #paste(fragment: unknown, origin: ClipboardOrigin | null): CommandOutcome {
    if (!withinLimits(fragment)) {
      this.#notify(PASTE_PROBLEMS["too-large"]);
      return { ok: false, reason: "disabled" };
    }
    const outcome = this.run(BASICS.paste, {
      fragment,
      ...this.#pasteTarget(fragment, origin),
    });
    if (outcome.ok) this.dismissNotice();
    else if (!this.host.commands.gestureActive(this.environment()))
      this.#notify(PASTE_PROBLEMS.damaged);
    return outcome;
  }

  /** A container the user can paste into: there, seen, not locked. */
  #openContainer(id: ElementId): boolean {
    const live = this.live;
    return (
      live.get(id) !== undefined &&
      live.isContainer(id) &&
      !live.isGone(id) &&
      !live.isLocked(id)
    );
  }

  /**
   * Where a paste lands: into the container it was copied from while that is
   * there (an element copied from a frame goes back into the frame), else on
   * the canvas at the same place in root space; and if none of that is in
   * view, with its centre in the middle of the view.
   */
  #pasteTarget(
    raw: unknown,
    origin: ClipboardOrigin | null,
  ): { parent: ElementId | null; dx: number; dy: number } {
    let parent: ElementId | null = null;
    // What the fragment's positions need to be in the target's space.
    let shift: Point = { x: 0, y: 0 };
    if (origin !== null) {
      if (origin.container !== null && this.#openContainer(origin.container))
        parent = origin.container;
      else shift = origin.at;
    }
    const { fragment } = readFragment(raw);
    const bounds = fragment === null ? null : fragmentBounds(fragment);
    if (bounds === null || this.screen.width === 0)
      return { parent, dx: shift.x, dy: shift.y };
    const toRoot = parent === null ? shift : this.live.offset(parent, null);
    const x = bounds.x + toRoot.x;
    const y = bounds.y + toRoot.y;
    const view = this.services.camera.viewport();
    const seen =
      x <= view.x + view.w &&
      view.x <= x + bounds.w &&
      y <= view.y + view.h &&
      view.y <= y + bounds.h;
    if (seen) return { parent, dx: shift.x, dy: shift.y };
    return {
      parent,
      dx: shift.x + view.x + view.w / 2 - (x + bounds.w / 2),
      dy: shift.y + view.y + view.h / 2 - (y + bounds.h / 2),
    };
  }

  /** Where a fragment copied now comes from: its roots' container, and that container's origin. */
  #originOf(fragment: Fragment): ClipboardOrigin {
    const first = fragment.roots[0];
    const container =
      first === undefined || this.live.get(first) === undefined
        ? null
        : this.live.logicalParentOf(first);
    return { container, at: this.live.offset(container, null) };
  }

  /** A message for the user (a paste refused, say), until dismissed or replaced. */
  get notice(): EditorNotice | null {
    return this.#notice;
  }

  dismissNotice(): void {
    if (this.#notice === null) return;
    this.#notice = null;
    this.#emit("notice");
  }

  #notify(message: string): void {
    this.#notice = { message };
    this.#emit("notice");
  }

  /**
   * Runs a command the way a shortcut or a menu does: with the selection as
   * its elements (`{ ids }`); paste takes what the last copy gave, and copy
   * keeps what it gave for that.
   */
  runFromShortcut(command: ContributionId): CommandOutcome {
    const ids = this.#state.selection;
    if (command === BASICS.paste) {
      if (this.#clipboard === null) return { ok: false, reason: "disabled" };
      return this.#paste(this.#clipboard.fragment, this.#clipboard.origin);
    }
    const outcome = this.run(command, ids.length > 0 ? { ids: [...ids] } : undefined);
    if (command === BASICS.copy && outcome.ok) {
      const fragment = outcome.value as Fragment;
      this.#clipboard = { fragment, origin: this.#originOf(fragment) };
    }
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

/** Space alone (no modifiers): the hand. */
function isHandKey(input: KeyInput): boolean {
  return (
    input.key === " " &&
    !input.ctrlKey &&
    !input.altKey &&
    !input.metaKey &&
    !input.shiftKey
  );
}

export type ShortcutTarget =
  | { readonly kind: "command"; readonly id: ContributionId }
  | { readonly kind: "tool"; readonly id: ContributionId };
