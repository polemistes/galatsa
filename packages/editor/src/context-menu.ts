// SPDX-License-Identifier: GPL-3.0-or-later

// The canvas's context menu (a right click): the selection's actions with the
// mouse until the editor shell has toolbars (docs/adr/0008-selection.md).
// Cut, copy and paste, duplicate and delete, the stacking order, group and
// ungroup, frames (docs/adr/0014-stacking-and-frames.md), lock and unlock,
// select all: the basics' commands, shown when the mode offers them
// and greyed out when they would be refused. A right click on an element that
// is not selected selects it first, a locked one too, so that it can be
// unlocked: clicks with the selection tool pass over locked elements.
//
// The menu's state is a store here; the interface draws it, and the page
// supplies the clipboard actions, which need the browser (dom.ts).

import { FRAME_TYPE, type ElementId, type Point } from "@galatsa/core";
import type { ContributionId, Label } from "@galatsa/extension-api";
import { BASICS } from "@galatsa/extension-basics";
import { labelAt, shownFrames } from "@galatsa/extension-select";
import type { Editor } from "./editor.ts";
import { RENAME_FRAME } from "./rename-target.ts";
import { selectableFor } from "./services.ts";

/** How far from an element a right click still hits it, in CSS pixels. */
const PICK = 4;

export interface MenuEntry {
  /** Stable key: the command id, or the editor's own action. */
  readonly key: string;
  readonly label: Label;
  readonly enabled: boolean;
  /** Entries of one group stand together; groups are separated. */
  readonly group: number;
  run(): void;
}

export interface MenuState {
  /** Where the menu opens, in CSS pixels of the canvas. */
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MenuEntry[];
}

/** The menu: open or closed, and what it offers. Listeners hear every change. */
export class ContextMenu {
  #state: MenuState | null = null;
  readonly #listeners = new Set<() => void>();

  get state(): MenuState | null {
    return this.#state;
  }

  open(x: number, y: number, entries: readonly MenuEntry[]): void {
    this.#state = { x, y, entries };
    this.#emit();
  }

  close(): void {
    if (this.#state === null) return;
    this.#state = null;
    this.#emit();
  }

  /** Closes the menu and runs the entry, if it is enabled. */
  choose(entry: MenuEntry): void {
    if (!entry.enabled) return;
    this.close();
    entry.run();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/** The clipboard actions, as the page performs them (through the browser's clipboard). */
export interface MenuClipboard {
  copy(): void;
  cut(): void;
  paste(): void;
  /** Picks files to import ("Insert a file"); absent where files cannot be imported. */
  chooseFiles?(): void;
}

/** The entries for the current selection. */
export function menuEntries(editor: Editor, clipboard: MenuClipboard): MenuEntry[] {
  const selection = editor.selection;
  const args = selection.length > 0 ? { ids: [...selection] } : undefined;
  const env = editor.environment();
  const offered = (id: ContributionId): boolean =>
    editor.host.commands.get(id) !== undefined && editor.host.commands.isVisible(id, env);
  const label = (id: ContributionId): Label =>
    editor.host.commands.get(id)!.definition.label;
  const out: MenuEntry[] = [];
  const command = (id: ContributionId, group: number): void => {
    if (!offered(id)) return;
    out.push({
      key: id,
      label: label(id),
      enabled: editor.isEnabled(id, id === BASICS.selectAll ? undefined : args),
      group,
      run: () => {
        editor.runFromShortcut(id);
      },
    });
  };
  const canCopy = offered(BASICS.copy) && editor.isEnabled(BASICS.copy, args);
  if (offered(BASICS.copy)) {
    out.push({
      key: "cut",
      label: "editor:menu.cut",
      enabled: canCopy && offered(BASICS.delete) && editor.isEnabled(BASICS.delete, args),
      group: 0,
      run: () => clipboard.cut(),
    });
    out.push({
      key: BASICS.copy,
      label: label(BASICS.copy),
      enabled: canCopy,
      group: 0,
      run: () => clipboard.copy(),
    });
  }
  if (offered(BASICS.paste)) {
    // Whether the clipboard holds something to paste is not known without
    // reading it, which the browser may ask the user about.
    out.push({
      key: BASICS.paste,
      label: label(BASICS.paste),
      enabled: !editor.host.commands.gestureActive(env),
      group: 0,
      run: () => clipboard.paste(),
    });
  }
  if (clipboard.chooseFiles !== undefined) {
    const choose = clipboard.chooseFiles;
    out.push({
      key: "import",
      label: "editor:import.choose",
      enabled: !editor.host.commands.gestureActive(env) && !editor.importing,
      group: 0,
      run: () => choose(),
    });
  }
  command(BASICS.duplicate, 1);
  command(BASICS.delete, 1);
  command(BASICS.bringToFront, 2);
  command(BASICS.bringForward, 2);
  command(BASICS.sendBackward, 2);
  command(BASICS.sendToBack, 2);
  command(BASICS.group, 3);
  command(BASICS.ungroup, 3);
  // Frames (docs/adr/0014): around the selection, removed keeping their
  // contents, into and out of frames, and the name.
  command(BASICS.frame, 4);
  command(BASICS.removeFrame, 4);
  command(BASICS.moveIntoFrame, 4);
  command(BASICS.moveOutOfFrame, 4);
  command(RENAME_FRAME, 4);
  command(BASICS.lock, 5);
  command(BASICS.unlock, 5);
  command(BASICS.selectAll, 6);
  return out;
}

/**
 * The element a right click at a point on screen is on, locked ones
 * included; a frame's name above it counts as the frame, as it does for the
 * selection tool (docs/adr/0014), where no element is hit there.
 */
export function elementForMenu(editor: Editor, point: Point): ElementId | null {
  const found = editor.renderer.hitTest(point.x, point.y, { tolerance: PICK });
  const hit = found === null ? null : selectableFor(editor.live, found);
  if (hit !== null && editor.live.get(hit)?.type !== FRAME_TYPE) return hit;
  const name = labelAt(
    shownFrames(editor.services, editor.doc),
    editor.screenToWorld(point),
    editor.services.camera.get().zoom,
  );
  return name ?? hit;
}

/**
 * Opens the menu at a point on screen (CSS pixels of the canvas). An element
 * there that is not selected is selected first; on empty canvas the selection
 * stays, so the menu acts on it.
 */
export function openContextMenu(
  editor: Editor,
  point: Point,
  clipboard: MenuClipboard,
): void {
  if (!editor.inputEnabled) return;
  const hit = elementForMenu(editor, point);
  if (hit !== null && !editor.selection.includes(hit))
    editor.services.selection.set([hit]);
  editor.contextMenu.open(point.x, point.y, menuEntries(editor, clipboard));
}
