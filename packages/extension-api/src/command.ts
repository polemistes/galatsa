// SPDX-License-Identifier: GPL-3.0-or-later

// Commands and the command registry. Every change a user makes to a document
// goes through a command, and one command is one undo step. See
// docs/adr/0005-extension-interface.md, section 4.

import type { ElementId, Rect } from "@galatsa/core";
import type { DocumentUndoManager } from "@galatsa/core/ydoc";
import type * as Y from "yjs";
import type { AnyElementType, ElementCapabilities } from "./element-type.ts";
import {
  availableIn,
  normalizeShortcut,
  type ContributionId,
  type ExtensionId,
  type IconRef,
  type Label,
  type Mode,
  type Shortcut,
} from "./ids.ts";

/**
 * The editor state a command runs against. The editor builds one for each
 * call; tests build their own.
 */
export interface CommandEnvironment {
  readonly doc: Y.Doc;
  /** The document's undo manager (createUndoManager in @galatsa/core/ydoc). */
  readonly undo: DocumentUndoManager;
  readonly mode: Mode;
  /** Selected elements, in selection order. */
  readonly selection: readonly ElementId[];
  /**
   * The part of the canvas the user sees, in root space; where new elements go
   * when the command is not told where.
   */
  readonly viewport?: Rect;
}

/** What commands, tools and panels may ask about the loaded extensions. */
export interface ExtensionLookup {
  /** The definition of an element type id, if its extension is loaded. */
  elementType(type: string): AnyElementType | undefined;
  /** What the user may do to an element of this type and layout version. */
  capabilities(element: {
    readonly type: string;
    readonly typeVersion: number;
  }): ElementCapabilities;
}

export interface CommandContext extends CommandEnvironment {
  readonly extensions: ExtensionLookup;
  /**
   * Runs another command as part of this one: same undo step, and its failure
   * fails this command. Throws CommandError if it is unknown or disabled.
   */
  run<R = unknown>(command: ContributionId, args?: unknown): R;
}

/**
 * A command. `A` is its argument, `R` its result.
 *
 * `execute` is synchronous. Asynchronous work (reading a file, hashing an
 * asset, decoding an image) happens before the command runs, and its result is
 * the argument. `execute` changes the document only through the operations of
 * @galatsa/core/ydoc (and `edit()` for in-place edits of shared text and
 * collections), never with `doc.transact`: operations that create records
 * refuse to run inside another transaction, and a transaction with another
 * origin would not be undoable.
 */
export interface CommandDefinition<A = unknown, R = unknown> {
  /** Command name; the command id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  /** Longer text for tooltips and the command search. */
  readonly description?: Label;
  readonly icon?: IconRef;
  readonly shortcuts?: readonly Shortcut[];
  /** Offered in quick mode too. Every command is offered in advanced mode. */
  readonly quick?: boolean;
  /**
   * False for commands that do not change the document (camera, panels, mode,
   * selection, and undo and redo themselves): they run without an undo step.
   * Default true.
   */
  readonly undoable?: boolean;
  /** Whether the command can run now, with these arguments. Default: always. */
  enabled?(ctx: CommandContext, args: A | undefined): boolean;
  /** Whether menus and toolbars show it now. Default: always. */
  visible?(ctx: CommandContext): boolean;
  execute(ctx: CommandContext, args: A): R;
}

/** Identity function that infers a command's argument and result types. */
export function defineCommand<A = undefined, R = void>(
  definition: CommandDefinition<A, R>,
): CommandDefinition<A, R> {
  return definition;
}

/** A command as the registry holds it. */
export interface RegisteredCommand {
  readonly id: ContributionId;
  readonly extension: ExtensionId;
  readonly definition: CommandDefinition;
}

export type CommandOutcome<R = unknown> =
  | { readonly ok: true; readonly value: R }
  | {
      readonly ok: false;
      readonly reason: "unknown" | "disabled" | "failed";
      readonly error?: unknown;
    };

/** Thrown by CommandContext.run when the nested command cannot run. */
export class CommandError extends Error {
  readonly command: ContributionId;
  readonly reason: "unknown" | "disabled";

  constructor(command: ContributionId, reason: "unknown" | "disabled") {
    super(
      `Command ${command} is ${reason === "unknown" ? "not registered" : "disabled"}`,
    );
    this.name = "CommandError";
    this.command = command;
    this.reason = reason;
  }
}

/**
 * Several commands, run over time (a drag), that become one undo step. Each
 * command changes the document when it runs. After commit or cancel, run does
 * nothing.
 */
export interface Gesture {
  run<R = unknown>(command: ContributionId, args?: unknown): CommandOutcome<R>;
  /** Ends the gesture; what it changed is one undo step. */
  commit(): void;
  /** Ends the gesture and takes back everything it changed, without a redo step. */
  cancel(): void;
}

/** A shortcut that two commands claim; the first registered keeps it. */
export interface ShortcutConflict {
  readonly shortcut: Shortcut;
  readonly kept: ContributionId;
  readonly ignored: ContributionId;
}

/**
 * The command registry. The extension host fills it from the extensions'
 * contributions; the editor builds menus, toolbars, the command search and the
 * keyboard map from it, and runs every user action through `execute`.
 */
export class CommandRegistry {
  readonly #commands = new Map<ContributionId, RegisteredCommand>();
  readonly #lookup: ExtensionLookup;
  /** Nesting depth of execute and run: only the outermost makes an undo step. */
  #depth = 0;
  /** The running gesture, if any. */
  #gesture: object | null = null;

  constructor(lookup: ExtensionLookup) {
    this.#lookup = lookup;
  }

  /** Adds a command; throws if its id is taken. Returns a function that removes it. */
  register(extension: ExtensionId, definition: CommandDefinition): () => void {
    const id = `${extension}/${definition.name}`;
    if (this.#commands.has(id)) throw new Error(`Command ${id} is registered already`);
    const entry: RegisteredCommand = { id, extension, definition };
    this.#commands.set(id, entry);
    return () => {
      if (this.#commands.get(id) === entry) this.#commands.delete(id);
    };
  }

  get(id: ContributionId): RegisteredCommand | undefined {
    return this.#commands.get(id);
  }

  /** Commands in registration order; with a mode, only those offered in it. */
  list(mode?: Mode): RegisteredCommand[] {
    const all = [...this.#commands.values()];
    return mode === undefined
      ? all
      : all.filter((c) => availableIn(c.definition.quick, mode));
  }

  /**
   * The keyboard map for a mode: shortcut to command, and the conflicts found.
   * Commands not offered in the mode have no shortcut there.
   */
  shortcuts(mode: Mode): {
    map: Map<Shortcut, ContributionId>;
    conflicts: ShortcutConflict[];
  } {
    const map = new Map<Shortcut, ContributionId>();
    const conflicts: ShortcutConflict[] = [];
    for (const command of this.list(mode)) {
      for (const raw of command.definition.shortcuts ?? []) {
        const shortcut = normalizeShortcut(raw);
        if (shortcut === undefined) continue;
        const kept = map.get(shortcut);
        if (kept === undefined) map.set(shortcut, command.id);
        else if (kept !== command.id)
          conflicts.push({ shortcut, kept, ignored: command.id });
      }
    }
    return { map, conflicts };
  }

  /** The context a command sees. */
  context(env: CommandEnvironment): CommandContext {
    return {
      ...env,
      extensions: this.#lookup,
      run: <R>(command: ContributionId, args?: unknown): R => {
        const entry = this.#commands.get(command);
        if (!entry) throw new CommandError(command, "unknown");
        const ctx = this.context(env);
        if (!this.#allowed(entry, ctx, args)) throw new CommandError(command, "disabled");
        this.#depth += 1;
        try {
          return entry.definition.execute(ctx, args) as R;
        } finally {
          this.#depth -= 1;
        }
      },
    };
  }

  #allowed(entry: RegisteredCommand, ctx: CommandContext, args: unknown): boolean {
    if (!availableIn(entry.definition.quick, ctx.mode)) return false;
    try {
      return entry.definition.enabled?.(ctx, args) ?? true;
    } catch {
      return false;
    }
  }

  /** True if the command exists, is offered in the mode and is enabled. */
  isEnabled(id: ContributionId, env: CommandEnvironment, args?: unknown): boolean {
    const entry = this.#commands.get(id);
    return entry !== undefined && this.#allowed(entry, this.context(env), args);
  }

  /** True if menus and toolbars should show the command now. */
  isVisible(id: ContributionId, env: CommandEnvironment): boolean {
    const entry = this.#commands.get(id);
    if (!entry || !availableIn(entry.definition.quick, env.mode)) return false;
    try {
      return entry.definition.visible?.(this.context(env)) ?? true;
    } catch {
      return false;
    }
  }

  /**
   * Runs a command as one undo step (unless it is not undoable). A disabled or
   * unknown command does nothing. A command that throws leaves no trace: what
   * it changed before it failed is undone, and the step is not offered for
   * redo. Called from inside another command, it joins that command's step.
   */
  execute<R = unknown>(
    id: ContributionId,
    env: CommandEnvironment,
    args?: unknown,
  ): CommandOutcome<R> {
    const entry = this.#commands.get(id);
    if (!entry) return { ok: false, reason: "unknown" };
    const ctx = this.context(env);
    if (!this.#allowed(entry, ctx, args)) return { ok: false, reason: "disabled" };
    const run = (): R => {
      this.#depth += 1;
      try {
        return entry.definition.execute(ctx, args) as R;
      } finally {
        this.#depth -= 1;
      }
    };
    if (this.#depth > 0 || entry.definition.undoable === false) {
      try {
        return { ok: true, value: run() };
      } catch (error) {
        if (this.#depth > 0) throw error;
        return { ok: false, reason: "failed", error };
      }
    }
    if (this.#gesture !== null) {
      // Inside a gesture: the gesture's open step collects the change.
      try {
        return { ok: true, value: run() };
      } catch (error) {
        return { ok: false, reason: "failed", error };
      }
    }
    const undo = env.undo;
    const before = undo.undoStack.length;
    try {
      return { ok: true, value: undo.group(run) };
    } catch (error) {
      // group() closed the step; take back what the command did before it failed.
      if (undo.undoStack.length > before) takeBack(undo);
      return { ok: false, reason: "failed", error };
    }
  }

  /**
   * Starts a gesture (see Gesture). Only one gesture runs at a time; starting
   * another commits the first.
   */
  beginGesture(env: () => CommandEnvironment): Gesture {
    const undo = env().undo;
    const timeout = undo.captureTimeout;
    undo.stopCapturing();
    const before = undo.undoStack.length;
    undo.captureTimeout = Number.POSITIVE_INFINITY;
    const token = {};
    this.#gesture = token;
    const end = (): boolean => {
      if (this.#gesture !== token) return false;
      this.#gesture = null;
      undo.captureTimeout = timeout;
      undo.stopCapturing();
      return true;
    };
    return {
      run: <R>(command: ContributionId, args?: unknown): CommandOutcome<R> =>
        this.#gesture === token
          ? this.execute<R>(command, env(), args)
          : { ok: false, reason: "disabled" },
      commit: () => {
        end();
      },
      cancel: () => {
        if (end() && undo.undoStack.length > before) takeBack(undo);
      },
    };
  }
}

/** Undoes the newest step and drops it from the redo stack. */
function takeBack(undo: DocumentUndoManager): void {
  undo.undo();
  undo.redoStack.pop();
}
