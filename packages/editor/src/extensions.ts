// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's extension host: the built-in basics extension first (the
// commands every element has, docs/adr/0005, section 12.1), then the built-in
// selection tool (docs/adr/0008; its tool is the first, so the default when the
// program names none), then the program's other extensions. The basics come first so that they keep their shortcuts
// when another extension claims the same one ("select all" in the selection
// sketch, say): the first registered keeps a shortcut.

import type { Mode } from "@galatsa/extension-api";
import {
  EditorHost,
  type EditExtension,
  type LoadProblem,
  type ShortcutConflict,
  type ViewExtension,
} from "@galatsa/extension-api/editing";
import { basicsExtension } from "@galatsa/extension-basics";
import { selectExtension } from "@galatsa/extension-select";
import type { I18n } from "@galatsa/i18n";
import { storageMessages } from "@galatsa/storage";
import { editorMessages } from "./messages/index.ts";

export interface LoadedExtensions {
  readonly host: EditorHost;
  /** Extensions left out, with why. */
  readonly problems: readonly LoadProblem[];
  /** Shortcuts two commands claim, per mode. */
  readonly conflicts: { readonly [mode in Mode]: readonly ShortcutConflict[] };
}

/** Registers the editor's own texts (and the storage layer's, which it shows). */
export function registerEditorMessages(i18n: I18n): void {
  i18n.register(editorMessages);
  i18n.register(storageMessages);
}

/** An editor host with the basics extension and `extensions` loaded. */
export function loadExtensions(
  i18n: I18n,
  extensions: readonly (ViewExtension | EditExtension)[],
): LoadedExtensions {
  registerEditorMessages(i18n);
  const host = new EditorHost({ i18n });
  const problems = host.load([basicsExtension, selectExtension, ...extensions]);
  return {
    host,
    problems,
    conflicts: {
      quick: host.commands.shortcuts("quick").conflicts,
      advanced: host.commands.shortcuts("advanced").conflicts,
    },
  };
}
