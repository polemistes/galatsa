// SPDX-License-Identifier: GPL-3.0-or-later

// Tools: pointer and keyboard interaction on the canvas. A tool turns input into
// commands; it never writes to the document itself. See
// docs/adr/0005-extension-interface.md, section 5.

import type { ElementId, Point } from "@galatsa/core";
import type {
  CommandEnvironment,
  CommandOutcome,
  ExtensionLookup,
  Gesture,
} from "./command.ts";
import type { DrawContext } from "./draw.ts";
import type { ContributionId, IconRef, Label, Shortcut } from "./ids.ts";

export interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  /** Ctrl on Windows and Linux, Cmd on macOS. */
  readonly mod: boolean;
}

export interface ToolPointerEvent {
  /** Position in CSS pixels, relative to the canvas. */
  readonly screen: Point;
  /**
   * The same position on the canvas, in root space (world units). It is
   * exact to well under a pixel wherever |world| * zoom stays within the
   * precision budget (docs/adr/0001, section 7); deep in a frame far from the
   * root it is not, and tools that must be exact there use `local`.
   */
  readonly world: Point;
  /**
   * The same position in the camera's own space: the frame the camera is
   * anchored in, or the root. Exact at any zoom, because the camera keeps its
   * numbers small there. Convert it to another space with
   * `services.scene.offset`. The editor always gives it; it is optional so
   * that events built by hand (tests) need not.
   */
  readonly local?: SpacePoint;
  readonly pointerType: "mouse" | "pen" | "touch";
  /** 0 primary, 1 middle, 2 secondary, as in DOM pointer events. */
  readonly button: number;
  /** 0 to 1; 0.5 for devices without pressure. */
  readonly pressure: number;
  readonly modifiers: Modifiers;
}

/** A point in the local space of a container (or the root, `space` null). */
export interface SpacePoint {
  readonly space: ElementId | null;
  readonly x: number;
  readonly y: number;
}

export interface ToolKeyEvent {
  /** A `KeyboardEvent.key` value. */
  readonly key: string;
  readonly modifiers: Modifiers;
  readonly repeat: boolean;
}

/** Cursor names, as in CSS. */
export type Cursor =
  | "default"
  | "crosshair"
  | "text"
  | "move"
  | "grab"
  | "grabbing"
  | "pointer"
  | "not-allowed"
  /** Resizing along a diagonal, an axis (since 1.2). */
  | "nwse-resize"
  | "nesw-resize"
  | "ns-resize"
  | "ew-resize";

/** What the editor gives a tool while it is the current tool. */
export interface ToolSession {
  /** The current editor state: the document, its undo manager, and the editor's services. */
  environment(): CommandEnvironment;
  /** Runs a command (one undo step), like a menu or a shortcut would. */
  run<R = unknown>(command: ContributionId, args?: unknown): CommandOutcome<R>;
  /**
   * Whether `run(command, args)` would be accepted now, as a menu greys out
   * an entry: a tool offers only what its commands would do (the selection
   * tool shows a handle only where its command is enabled). Since 1.2.
   */
  isEnabled(command: ContributionId, args?: unknown): boolean;
  /**
   * The loaded extensions: element types and what the user may do to an
   * element (`capabilitiesOf`, `planScale`), so that a preview shows what the
   * command it ends in will do. Since 1.2.
   */
  readonly extensions: ExtensionLookup;
  /**
   * Starts a gesture: a drag previews its result without changing the
   * document, and ends in one command (one undo step) or in nothing.
   */
  gesture(): Gesture;
  /** Device pixels per world unit at the current zoom. */
  scale(): number;
  /** Asks the renderer to draw the tool's overlay again. */
  requestOverlay(): void;
  /** Starts in-place text editing of an element (the renderer's beginTextEdit). */
  editText(id: ElementId): void;
  setCursor(cursor: Cursor): void;
  /** The tool is done; the editor switches back to the default tool. */
  done(): void;
}

/**
 * The live part of a tool, created when the user picks it. Handlers that
 * return a boolean return true if they used the event.
 */
export interface ToolHandler {
  pointerDown?(event: ToolPointerEvent): void;
  pointerMove?(event: ToolPointerEvent): void;
  pointerUp?(event: ToolPointerEvent): void;
  /** The gesture was interrupted (another app took the pointer, Escape). */
  pointerCancel?(): void;
  keyDown?(event: ToolKeyEvent): boolean;
  keyUp?(event: ToolKeyEvent): boolean;
  /**
   * Draws previews (a rubber band, the outline of a shape being drawn) in root
   * space, above the document. Called by the renderer after requestOverlay.
   */
  drawOverlay?(ctx: DrawContext): void;
  /** The user picked another tool; drop any preview. */
  stop?(): void;
}

export interface ToolDefinition {
  /** Tool name; the tool id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  readonly icon?: IconRef;
  /** Picks the tool. */
  readonly shortcuts?: readonly Shortcut[];
  /** Offered in quick mode too. Every tool is offered in advanced mode. */
  readonly quick?: boolean;
  /** Where in the toolbar it goes: tools with the same group stand together. */
  readonly group?: string;
  readonly cursor?: Cursor;
  start(session: ToolSession): ToolHandler;
}
