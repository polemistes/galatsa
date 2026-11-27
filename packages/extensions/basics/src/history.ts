// SPDX-License-Identifier: GPL-3.0-or-later

// Undo, redo and "select all": commands that change no document content
// themselves, so they make no undo step of their own (docs/adr/0005, 4.2).

import { defineCommand } from "@galatsa/extension-api/editing";
import { label, resolve } from "./common.ts";

/**
 * Takes back the user's last step. Only the local user's own changes are
 * undone, never those of other users (docs/adr/0001, section 10). Refused
 * while a gesture or a command step is open. Returns whether a step was undone.
 */
export const undo = defineCommand<undefined, boolean>({
  name: "undo",
  label: label("undo"),
  shortcuts: ["Mod+Z"],
  quick: true,
  undoable: false,
  enabled: (ctx) => ctx.history.canUndo(),
  execute: (ctx) => ctx.history.undo(),
});

/** Makes the last undone step again. */
export const redo = defineCommand<undefined, boolean>({
  name: "redo",
  label: label("redo"),
  shortcuts: ["Mod+Shift+Z", "Mod+Y"],
  quick: true,
  undoable: false,
  enabled: (ctx) => ctx.history.canRedo(),
  execute: (ctx) => ctx.history.redo(),
});

/**
 * Selects every element the editor offers for selection, except locked ones.
 * The selection is not document content: no undo step.
 */
export const selectAll = defineCommand<undefined, void>({
  name: "select-all",
  label: label("select-all"),
  shortcuts: ["Mod+A"],
  quick: true,
  undoable: false,
  execute(ctx) {
    const everywhere = { x: -1e300, y: -1e300, w: Number.MAX_VALUE, h: Number.MAX_VALUE };
    const r = resolve(ctx);
    ctx.services.selection.set(
      ctx.services.scene.elementsIn(everywhere, "touching").filter((id) => !r.isLocked(id)),
    );
  },
});
