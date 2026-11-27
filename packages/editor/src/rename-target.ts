// SPDX-License-Identifier: GPL-3.0-or-later

// Which frame the rename panel names (docs/adr/0014-stacking-and-frames.md),
// apart from the extension so that the panel component can use it too.

import { Resolver, type ElementId } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import type { CommandContext } from "@galatsa/extension-api/editing";
import { isFrame } from "@galatsa/extension-basics";

/** The id: its labels are in the editor's message namespace ("editor"), a prefix of it. */
export const FRAMES_EXTENSION = "editor.frames";
/** The command that opens the panel. */
export const RENAME_FRAME = `${FRAMES_EXTENSION}/rename-frame`;
/** The panel. */
export const RENAME_PANEL = `${FRAMES_EXTENSION}/rename`;

/**
 * The frame to rename: the one given (`{ ids: [id] }`), else the one
 * selected, if it is a single frame that the basics' "rename" may name (seen,
 * not locked).
 */
export function frameToRename(
  ctx: Pick<CommandContext, "doc" | "services">,
  args?: unknown,
): ElementId | null {
  const given = (args as { ids?: unknown } | undefined)?.ids;
  const ids: readonly unknown[] = Array.isArray(given)
    ? given
    : ctx.services.selection.get();
  if (ids.length !== 1 || typeof ids[0] !== "string") return null;
  const id = ids[0] as ElementId;
  const r = new Resolver(yLookup(ctx.doc));
  return isFrame(r, id) && !r.isGone(id) && !r.isLocked(id) ? id : null;
}
