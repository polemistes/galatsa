// SPDX-License-Identifier: GPL-3.0-or-later

// What the toolbar shows (docs/adr/0016), built from the extension host and
// the command registry in the current mode, so that tools and commands other
// extensions add appear without a change here:
//
// - the tools, grouped by their `group`, in activation order;
// - undo and redo: the basics' commands, whose buttons belong to the editor
//   (docs/adr/0005, section 12.1);
// - every command with a `toolbar` group, by group.
//
// Plain TypeScript over the editor, so it is tested in Node; Toolbar.svelte
// draws it.

import type { ContributionId, Label, Shortcut } from "@galatsa/extension-api";
import { BASICS } from "@galatsa/extension-basics";
import type { Editor } from "../editor.ts";
import type { Platform } from "../keymap.ts";
import { iconPath } from "./icons.ts";

export interface ToolbarButton {
  readonly kind: "tool" | "command";
  readonly id: ContributionId;
  readonly label: Label;
  /** The longer text of a command, for its tooltip. */
  readonly description: Label | null;
  /** The icon's SVG path. */
  readonly icon: string;
  /** The shortcut that reaches it in the current mode, if any. */
  readonly shortcut: Shortcut | null;
  readonly enabled: boolean;
  /** For a tool: whether it is the current one; for a toggle: whether it is on. */
  readonly pressed: boolean | null;
}

export interface ToolbarGroup {
  readonly key: string;
  readonly buttons: readonly ToolbarButton[];
}

export interface ToolbarModel {
  readonly tools: readonly ToolbarGroup[];
  readonly history: ToolbarGroup | null;
  readonly commands: readonly ToolbarGroup[];
}

/** The shortcut of each command and tool in the current keyboard map: the first one it kept. */
function shortcutsOf(editor: Editor): Map<ContributionId, Shortcut> {
  const out = new Map<ContributionId, Shortcut>();
  for (const [shortcut, target] of editor.keymap())
    if (!out.has(target.id)) out.set(target.id, shortcut);
  return out;
}

/** The toolbar of the editor now. */
export function toolbarModel(editor: Editor): ToolbarModel {
  const shortcuts = shortcutsOf(editor);
  const current = editor.tools.current;

  const tools = new Map<string, ToolbarButton[]>();
  for (const tool of editor.tools.available()) {
    const group = tool.definition.group ?? `tool:${tool.id}`;
    const button: ToolbarButton = {
      kind: "tool",
      id: tool.id,
      label: tool.definition.label,
      description: null,
      icon: iconPath(tool.definition.icon, tool.id),
      shortcut: shortcuts.get(tool.id) ?? null,
      enabled: true,
      pressed: tool.id === current,
    };
    const list = tools.get(group);
    if (list === undefined) tools.set(group, [button]);
    else list.push(button);
  }

  const env = editor.environment();
  const registry = editor.host.commands;
  const args = commandArgs(editor);
  const commandButton = (id: ContributionId): ToolbarButton | null => {
    const entry = registry.get(id);
    if (entry === undefined || !registry.isVisible(id, env)) return null;
    const definition = entry.definition;
    return {
      kind: "command",
      id,
      label: definition.label,
      description: definition.description ?? null,
      icon: iconPath(definition.icon, id),
      shortcut: shortcuts.get(id) ?? null,
      enabled: editor.isEnabled(id, args),
      pressed: definition.active === undefined ? null : registry.isActive(id, env),
    };
  };

  const historyButtons = [BASICS.undo, BASICS.redo]
    .map(commandButton)
    .filter((b): b is ToolbarButton => b !== null);

  const commands: ToolbarGroup[] = [];
  for (const { group, commands: list } of registry.toolbar(editor.mode)) {
    const buttons = list
      .map((entry) => commandButton(entry.id))
      .filter((b): b is ToolbarButton => b !== null);
    if (buttons.length > 0) commands.push({ key: `commands:${group}`, buttons });
  }

  return {
    tools: [...tools].map(([key, buttons]) => ({ key: `tools:${key}`, buttons })),
    history: historyButtons.length > 0 ? { key: "history", buttons: historyButtons } : null,
    commands,
  };
}

/** The arguments a toolbar button runs its command with: the selection, as a shortcut does. */
function commandArgs(editor: Editor): { ids: string[] } | undefined {
  const ids = editor.selection;
  return ids.length > 0 ? { ids: [...ids] } : undefined;
}

/** What a press on a toolbar button does: picks the tool, or runs the command. */
export function pressButton(editor: Editor, button: ToolbarButton): void {
  if (button.kind === "tool") editor.tools.select(button.id);
  else editor.runFromShortcut(button.id);
}

/** Message keys of the key names shown in tooltips. */
const KEY_NAMES: { readonly [key: string]: string } = {
  Delete: "editor:key.delete",
  Backspace: "editor:key.backspace",
  Enter: "editor:key.enter",
  Escape: "editor:key.escape",
  " ": "editor:key.space",
  ArrowLeft: "editor:key.left",
  ArrowRight: "editor:key.right",
  ArrowUp: "editor:key.up",
  ArrowDown: "editor:key.down",
};

const MAC_MODIFIERS: { readonly [mod: string]: string } = {
  Mod: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

const MODIFIER_NAMES: { readonly [mod: string]: string } = {
  Mod: "editor:key.ctrl",
  Ctrl: "editor:key.ctrl",
  Alt: "editor:key.alt",
  Shift: "editor:key.shift",
  Meta: "editor:key.meta",
};

/**
 * A shortcut as the keys are marked: "Ctrl+Shift+Z" on Windows and Linux,
 * "⇧⌘Z" on macOS. `t` looks up the names of keys.
 */
export function shortcutText(
  shortcut: Shortcut,
  platform: Platform,
  t: (key: string) => string,
): string {
  const parts = shortcut.split("+");
  if (shortcut.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop() ?? "";
  const named = KEY_NAMES[key];
  const keyText = named !== undefined ? t(named) : key.toUpperCase();
  if (platform.mac)
    return parts.map((m) => MAC_MODIFIERS[m] ?? m).join("") + keyText;
  return [...parts.map((m) => t(MODIFIER_NAMES[m] ?? m)), keyText].join("+");
}
