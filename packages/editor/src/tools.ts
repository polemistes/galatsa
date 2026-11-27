// SPDX-License-Identifier: GPL-3.0-or-later

// The current tool and the session it works through (docs/adr/0005, section
// 5). A tool turns pointer and key events into commands and previews; it never
// writes to the document. The editor starts the default tool, switches tools
// when asked (a tool's shortcut, `select`), and returns to the default tool
// when a tool says it is done.

import type { ElementId } from "@galatsa/core";
import type { ContributionId, Mode } from "@galatsa/extension-api";
import type {
  CommandEnvironment,
  CommandOutcome,
  Cursor,
  DrawContext,
  EditorHost,
  Gesture,
  ToolDefinition,
  ToolHandler,
  ToolKeyEvent,
  ToolPointerEvent,
  ToolSession,
} from "@galatsa/extension-api/editing";

/** What the tool controller needs from the editor. */
export interface ToolHost {
  readonly host: EditorHost;
  environment(): CommandEnvironment;
  mode(): Mode;
  /** Device pixels per world unit. */
  scale(): number;
  /** The overlay changed: draw again. */
  invalidate(): void;
  setCursor(cursor: Cursor): void;
  /** Starts in-place text editing; false where it is not available yet. */
  editText(id: ElementId): boolean;
  /** The current tool changed. */
  toolChanged(id: ContributionId | null): void;
}

interface Active {
  readonly id: ContributionId;
  readonly definition: ToolDefinition;
  handler: ToolHandler;
  /** Set when the tool is stopped; its session then does nothing. */
  stopped: boolean;
}

export class ToolController {
  readonly #editor: ToolHost;
  #defaultTool: ContributionId | null;
  #active: Active | null = null;
  /** True while a pointer is down on the canvas and given to the tool. */
  #pointerDown = false;

  constructor(editor: ToolHost, defaultTool: ContributionId | null) {
    this.#editor = editor;
    this.#defaultTool = defaultTool;
  }

  /** The id of the current tool, or null. */
  get current(): ContributionId | null {
    return this.#active?.id ?? null;
  }

  get defaultTool(): ContributionId | null {
    return this.#defaultTool;
  }

  /** The tools offered in the current mode, in activation order. */
  available(): { id: ContributionId; definition: ToolDefinition }[] {
    return this.#editor.host.tools(this.#editor.mode());
  }

  /**
   * Picks a tool by id. Returns false (and keeps the current tool) if no such
   * tool is offered in the current mode.
   */
  select(id: ContributionId): boolean {
    const entry = this.available().find((t) => t.id === id);
    if (!entry) return false;
    if (this.#active?.id === id) return true;
    this.#stopActive();
    const active: Active = {
      id,
      definition: entry.definition,
      handler: {},
      stopped: false,
    };
    // Current before it starts, so that its session works from the start.
    this.#active = active;
    try {
      active.handler = entry.definition.start(this.#session(active));
    } catch (error) {
      reportError(error, "start");
    }
    this.#editor.setCursor(entry.definition.cursor ?? "default");
    this.#editor.invalidate();
    this.#editor.toolChanged(id);
    return true;
  }

  /** Picks the default tool, or the first one offered if there is none. */
  selectDefault(): void {
    const tools = this.available();
    const id =
      this.#defaultTool !== null && tools.some((t) => t.id === this.#defaultTool)
        ? this.#defaultTool
        : tools[0]?.id;
    if (id !== undefined) this.select(id);
    else {
      this.#stopActive();
      this.#editor.toolChanged(null);
    }
  }

  setDefaultTool(id: ContributionId | null): void {
    this.#defaultTool = id;
  }

  #stopActive(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.stopped = true;
    this.#pointerDown = false;
    try {
      active.handler.stop?.();
    } catch (error) {
      reportError(error);
    }
    this.#editor.invalidate();
  }

  #session(active: Active): ToolSession {
    const editor = this.#editor;
    const live = (): boolean => !active.stopped && this.#active === active;
    return {
      environment: () => editor.environment(),
      run: <R>(command: ContributionId, args?: unknown): CommandOutcome<R> =>
        live()
          ? editor.host.commands.execute<R>(command, editor.environment(), args)
          : { ok: false, reason: "disabled" },
      gesture: (): Gesture => editor.host.commands.beginGesture(editor.environment()),
      scale: () => editor.scale(),
      requestOverlay: () => {
        if (live()) editor.invalidate();
      },
      editText: (id) => {
        if (live()) editor.editText(id);
      },
      setCursor: (cursor) => {
        if (live()) editor.setCursor(cursor);
      },
      done: () => {
        // Wait until the event that ended the tool's work has been handled.
        queueMicrotask(() => {
          if (live()) this.selectDefault();
        });
      },
    };
  }

  #call<A>(name: string, call: (handler: ToolHandler) => A): A | undefined {
    const handler = this.#active?.handler;
    if (!handler) return undefined;
    try {
      return call(handler);
    } catch (error) {
      reportError(error, name);
      return undefined;
    }
  }

  pointerDown(event: ToolPointerEvent): void {
    this.#pointerDown = true;
    this.#call("pointerDown", (h) => h.pointerDown?.(event));
  }

  pointerMove(event: ToolPointerEvent): void {
    this.#call("pointerMove", (h) => h.pointerMove?.(event));
  }

  pointerUp(event: ToolPointerEvent): void {
    if (!this.#pointerDown) return;
    this.#pointerDown = false;
    this.#call("pointerUp", (h) => h.pointerUp?.(event));
  }

  pointerCancel(): void {
    if (!this.#pointerDown) return;
    this.#pointerDown = false;
    this.#call("pointerCancel", (h) => h.pointerCancel?.());
  }

  /** True if the tool used the key. */
  keyDown(event: ToolKeyEvent): boolean {
    return this.#call("keyDown", (h) => h.keyDown?.(event)) === true;
  }

  keyUp(event: ToolKeyEvent): boolean {
    return this.#call("keyUp", (h) => h.keyUp?.(event)) === true;
  }

  drawOverlay(ctx: DrawContext): void {
    this.#call("drawOverlay", (h) => h.drawOverlay?.(ctx));
  }

  dispose(): void {
    this.#stopActive();
  }
}

/** A tool that throws is reported, and the editor goes on. */
function reportError(error: unknown, where?: string): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(where ?? "tool", error);
}
