// SPDX-License-Identifier: GPL-3.0-or-later

// Commands and the command registry. Every change a user makes to a document
// goes through a command, and one command is one undo step. See
// docs/adr/0005-extension-interface.md, section 4.

import type { DocumentUndoManager } from "@galatsa/core/ydoc";
import type * as Y from "yjs";
import type { ElementCapabilities, RegisteredElementType } from "./element-editing.ts";
import type { ElementFacts } from "./host.ts";
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
import type { EditorServices, PreviewChanges } from "./services.ts";

/**
 * What a command runs against: one document, its undo manager, and the
 * editor's services. The editor builds one for each call; tests build their own.
 */
export interface CommandEnvironment {
  readonly doc: Y.Doc;
  /** The document's undo manager (createUndoManager in @galatsa/core/ydoc). */
  readonly undo: DocumentUndoManager;
  readonly services: EditorServices;
}

/** What commands, tools and panels may ask about the loaded extensions. */
export interface ExtensionLookup {
  /** Both parts of an element type id, if its extension is loaded. */
  elementType(type: string): RegisteredElementType | undefined;
  /** What the user may do to an element of this type and layout version. */
  capabilities(element: ElementFacts): ElementCapabilities;
}

/**
 * What an undo step is, as the editor names it ("Undo move"). Steps made by a
 * command carry the command's id and step label; other steps (typing through
 * an editor binding) carry neither.
 */
export interface HistoryStep {
  readonly command?: ContributionId;
  /** The command's `undoLabel`, or its `label` when it has none. */
  readonly label?: Label;
}

/** Undo and redo, as commands may use them. */
export interface History {
  /** False while a gesture or a command step is open on this document. */
  canUndo(): boolean;
  canRedo(): boolean;
  /** Undoes the last step; false if it cannot now. */
  undo(): boolean;
  redo(): boolean;
  /**
   * The step the next undo takes back, or null if there is none. Yjs skips a
   * step that would change nothing (everything it did was overwritten by
   * others), so the step undone may then be an earlier one.
   */
  undoStep(): HistoryStep | null;
  /** The step the next redo makes again, or null if there is none. */
  redoStep(): HistoryStep | null;
}

export interface CommandContext extends CommandEnvironment {
  readonly extensions: ExtensionLookup;
  /** The current mode (from the mode service). */
  readonly mode: Mode;
  readonly history: History;
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
 * @galatsa/core/ydoc (and `edit()` for in-place edits and for batching writes
 * that create nothing into one transaction), never with `doc.transact`:
 * operations that create records refuse to run inside another transaction, and
 * a transaction with another origin would not be undoable.
 */
export interface CommandDefinition<A = unknown, R = unknown> {
  /** Command name; the command id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  /**
   * The name of the undo step the command makes, for "Undo ..." and "Redo
   * ..." in menus: a noun phrase ("move" rather than "Move"), because
   * languages such as Norwegian word the two differently ("Flytt", "Angre
   * flytting"). Default: `label`.
   */
  readonly undoLabel?: Label;
  /** Longer text for tooltips and the command search. */
  readonly description?: Label;
  /** An icon of the program's icon set; the toolbar falls back to the command's name. */
  readonly icon?: IconRef;
  readonly shortcuts?: readonly Shortcut[];
  /** Offered in quick mode too. Every command is offered in advanced mode. */
  readonly quick?: boolean;
  /**
   * The toolbar group the command has a button in (docs/adr/0016): commands
   * with the same group stand together, groups in the order their first
   * command was registered. The button runs the command the way a shortcut
   * does, with the selection as its elements, and is shown while the mode
   * offers the command and `visible` allows it. Without it, no button.
   */
  readonly toolbar?: string;
  /**
   * False for commands that do not change the document themselves (camera,
   * panels, mode, selection, undo and redo): they run without an undo step of
   * their own. Commands they run that do change the document are each one undo
   * step, taken back if they fail. Default true.
   */
  readonly undoable?: boolean;
  /** Whether the command can run now, with these arguments. Default: always. */
  enabled?(ctx: CommandContext, args: A | undefined): boolean;
  /** Whether menus and toolbars show it now. Default: always. */
  visible?(ctx: CommandContext): boolean;
  /**
   * For a command that switches something on and off (a panel): whether it
   * is on now, so its toolbar button shows as pressed (docs/adr/0016).
   */
  active?(ctx: CommandContext): boolean;
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
 * A drag, or a continuous control (a slider, a colour being dragged), that
 * ends in one command. While it runs, the editor draws a preview and the
 * document is not changed; `commit` runs the command once, as one undo step;
 * `cancel` changes nothing. Other commands may run meanwhile, each as its own
 * step; undo and redo wait until the gesture ends.
 */
export interface Gesture {
  /** True until commit or cancel. */
  readonly active: boolean;
  /** Replaces the preview (positions, sizes, rotations, data values). */
  preview(changes: PreviewChanges): void;
  /** Ends the gesture by running `command` once, as one undo step. */
  commit<R = unknown>(command: ContributionId, args?: unknown): CommandOutcome<R>;
  /** Ends the gesture without changing anything. */
  cancel(): void;
}

/** A shortcut that two commands claim; the first registered keeps it. */
export interface ShortcutConflict {
  readonly shortcut: Shortcut;
  readonly kept: ContributionId;
  readonly ignored: ContributionId;
}

/** Key of a step's command and label in the meta map of a Yjs stack item. */
const STEP_META = "galatsa:step";

type StackItem = DocumentUndoManager["undoStack"][number];

function stepOf(item: StackItem | undefined): HistoryStep | null {
  if (item === undefined) return null;
  return (item.meta.get(STEP_META) as HistoryStep | undefined) ?? {};
}

/** Undo managers whose steps keep their meta when they move between the stacks. */
const carrying = new WeakSet<DocumentUndoManager>();

/**
 * Yjs makes a new stack item when a step is undone (on the redo stack) or
 * redone (on the undo stack), with empty meta. This copies the meta of the step
 * being undone or redone to the new item, so that a step keeps its name.
 */
function carryMeta(undo: DocumentUndoManager): void {
  if (carrying.has(undo)) return;
  carrying.add(undo);
  undo.on("stack-item-added", (event: { stackItem: StackItem }) => {
    const from = undo.currStackItem;
    if ((!undo.undoing && !undo.redoing) || from === null || from === event.stackItem)
      return;
    for (const [key, value] of from.meta) event.stackItem.meta.set(key, value);
  });
}

/** Restores the redo stack after a failed command was taken back. */
function takeBack(
  undo: DocumentUndoManager,
  redo: DocumentUndoManager["redoStack"],
): void {
  undo.undo();
  undo.redoStack = redo;
}

/**
 * The command registry. The extension host fills it from the extensions'
 * contributions; the editor builds menus, toolbars, the command search and the
 * keyboard map from it, and runs every user action through `execute`.
 */
export class CommandRegistry {
  readonly #commands = new Map<ContributionId, RegisteredCommand>();
  readonly #lookup: ExtensionLookup;
  /** Undo managers whose document has a command step open (inside group()). */
  readonly #open = new Set<DocumentUndoManager>();
  /** The running gesture of each undo manager (each document). */
  readonly #gestures = new WeakMap<DocumentUndoManager, Gesture>();

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

  /** True while a gesture runs on the environment's document. */
  gestureActive(env: CommandEnvironment): boolean {
    return this.#gestures.get(env.undo)?.active === true;
  }

  #historyFree(undo: DocumentUndoManager): boolean {
    return !this.#open.has(undo) && this.#gestures.get(undo)?.active !== true;
  }

  /** Undo and redo for a document, refused while a gesture or a command step is open. */
  history(env: CommandEnvironment): History {
    const undo = env.undo;
    return {
      canUndo: () => this.#historyFree(undo) && undo.canUndo(),
      canRedo: () => this.#historyFree(undo) && undo.canRedo(),
      undo: () => this.#historyFree(undo) && undo.undo() !== null,
      redo: () => this.#historyFree(undo) && undo.redo() !== null,
      undoStep: () => stepOf(undo.undoStack[undo.undoStack.length - 1]),
      redoStep: () => stepOf(undo.redoStack[undo.redoStack.length - 1]),
    };
  }

  /** The context a command sees. */
  context(env: CommandEnvironment): CommandContext {
    return {
      ...env,
      extensions: this.#lookup,
      mode: env.services.mode.get(),
      history: this.history(env),
      run: <R>(command: ContributionId, args?: unknown): R => {
        const entry = this.#commands.get(command);
        if (!entry) throw new CommandError(command, "unknown");
        if (!this.#allowed(entry, this.context(env), args))
          throw new CommandError(command, "disabled");
        return this.#invoke<R>(entry, env, args);
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
    if (!entry || !availableIn(entry.definition.quick, env.services.mode.get()))
      return false;
    try {
      return entry.definition.visible?.(this.context(env)) ?? true;
    } catch {
      return false;
    }
  }

  /** True if a command that switches something on and off says it is on (docs/adr/0016). */
  isActive(id: ContributionId, env: CommandEnvironment): boolean {
    const entry = this.#commands.get(id);
    if (!entry?.definition.active) return false;
    try {
      return entry.definition.active(this.context(env));
    } catch {
      return false;
    }
  }

  /**
   * The commands with a toolbar button in a mode, by group: groups in the
   * order their first command was registered, commands in registration order
   * within a group (docs/adr/0016). `visible` is not asked here; it can
   * change with the selection, and the toolbar asks it when it draws.
   */
  toolbar(
    mode: Mode,
  ): { readonly group: string; readonly commands: RegisteredCommand[] }[] {
    const groups = new Map<string, RegisteredCommand[]>();
    for (const entry of this.#commands.values()) {
      const group = entry.definition.toolbar;
      if (group === undefined || !availableIn(entry.definition.quick, mode)) continue;
      const list = groups.get(group);
      if (list === undefined) groups.set(group, [entry]);
      else list.push(entry);
    }
    return [...groups].map(([group, commands]) => ({ group, commands }));
  }

  /**
   * Runs a command. Throws what the command throws. An undoable command opens
   * an undo step unless one is open on its document already (it is then part
   * of the command that runs it); if it throws, what it changed is taken back
   * and the redo stack is left as it was before.
   */
  #invoke<R>(entry: RegisteredCommand, env: CommandEnvironment, args: unknown): R {
    const execute = (): R => entry.definition.execute(this.context(env), args) as R;
    const undo = env.undo;
    if (entry.definition.undoable === false || this.#open.has(undo)) return execute();
    carryMeta(undo);
    const before = undo.undoStack.length;
    const top = undo.undoStack[before - 1];
    const redo = undo.redoStack.slice();
    this.#open.add(undo);
    try {
      const result = undo.group(execute);
      // group() starts a new step, so a new top item is this command's step. A
      // command that changed nothing tracked made none.
      const made = undo.undoStack[undo.undoStack.length - 1];
      if (made !== undefined && made !== top) {
        const step: HistoryStep = {
          command: entry.id,
          label: entry.definition.undoLabel ?? entry.definition.label,
        };
        made.meta.set(STEP_META, step);
      }
      return result;
    } catch (error) {
      // group() closed the step; take back what the command did before it failed.
      if (undo.undoStack.length > before) takeBack(undo, redo);
      throw error;
    } finally {
      this.#open.delete(undo);
    }
  }

  /**
   * Runs a command as one undo step (none for commands that are not undoable;
   * those that run inside another command join its step). A disabled or
   * unknown command does nothing. A command that throws leaves no trace: what
   * it changed before it failed is undone, and the redo stack is kept.
   */
  execute<R = unknown>(
    id: ContributionId,
    env: CommandEnvironment,
    args?: unknown,
  ): CommandOutcome<R> {
    const entry = this.#commands.get(id);
    if (!entry) return { ok: false, reason: "unknown" };
    if (!this.#allowed(entry, this.context(env), args))
      return { ok: false, reason: "disabled" };
    if (this.#open.has(env.undo))
      return { ok: true, value: this.#invoke<R>(entry, env, args) };
    try {
      return { ok: true, value: this.#invoke<R>(entry, env, args) };
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
  }

  /**
   * Starts a gesture on the environment's document (see Gesture). One gesture
   * runs per document; starting another cancels the first.
   */
  beginGesture(env: CommandEnvironment): Gesture {
    const undo = env.undo;
    this.#gestures.get(undo)?.cancel();
    let active = true;
    const end = (): void => {
      if (!active) return;
      active = false;
      env.services.preview.clear();
      if (this.#gestures.get(undo) === gesture) this.#gestures.delete(undo);
    };
    const gesture: Gesture = {
      get active() {
        return active;
      },
      preview: (changes) => {
        if (active) env.services.preview.show(changes);
      },
      commit: <R>(command: ContributionId, args?: unknown): CommandOutcome<R> => {
        if (!active) return { ok: false, reason: "disabled" };
        end();
        return this.execute<R>(command, env, args);
      },
      cancel: end,
    };
    this.#gestures.set(undo, gesture);
    return gesture;
  }
}
