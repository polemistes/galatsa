// SPDX-License-Identifier: GPL-3.0-or-later

// Renaming a frame, as an extension built into the editor
// (docs/adr/0014-stacking-and-frames.md): a command (F2, and the context
// menu) opens a small panel with the name of the selected frame; saving it
// runs the basics' "rename", one undo step. The panel is a Svelte component
// of the editor's own; the command and the panel use nothing but the
// extension interface and the editor's Svelte binding.

import { messageKey, EXTENSION_API_VERSION, type Label } from "@galatsa/extension-api";
import {
  defineCommand,
  defineEditExtension,
  defineViewExtension,
  type EditExtension,
} from "@galatsa/extension-api/editing";
import type { BundleKey } from "@galatsa/i18n";
import type { Component } from "svelte";
import { editorMessages } from "./messages/index.ts";
import { FRAMES_EXTENSION, RENAME_PANEL, frameToRename } from "./rename-target.ts";
import type { PanelProps } from "./ui/panels.ts";
import RenamePanel from "./ui/RenamePanel.svelte";

export {
  FRAMES_EXTENSION,
  RENAME_FRAME,
  RENAME_PANEL,
  frameToRename,
} from "./rename-target.ts";

function label(key: BundleKey<typeof editorMessages>): Label {
  return messageKey(editorMessages, key);
}

const renameFrame = defineCommand<unknown, void>({
  name: "rename-frame",
  label: label("frames.rename"),
  shortcuts: ["F2"],
  quick: true,
  undoable: false,
  enabled: (ctx, args) => frameToRename(ctx, args) !== null,
  execute(ctx, args) {
    const id = frameToRename(ctx, args);
    if (id === null) return;
    const selection = ctx.services.selection.get();
    if (selection.length !== 1 || selection[0] !== id) ctx.services.selection.set([id]);
    ctx.services.panels.open(RENAME_PANEL);
  },
});

const panelView: Component<PanelProps> = RenamePanel;

export const framesViewExtension = defineViewExtension({
  id: FRAMES_EXTENSION,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [editorMessages],
});

export const framesExtension: EditExtension = defineEditExtension({
  view: framesViewExtension,
  contributes: {
    commands: [renameFrame],
    panels: [
      {
        name: "rename",
        label: label("frames.panel"),
        quick: true,
        location: "side",
        content: { kind: "custom", binding: "svelte", view: panelView },
      },
    ],
  },
});
