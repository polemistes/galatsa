// SPDX-License-Identifier: GPL-3.0-or-later

// Overlays: what an extension draws over the canvas while the editor runs,
// outside any tool, such as the line of a route through its stops. Not
// document content: an overlay is never exported, never drawn by the player
// and never hit by clicks. See docs/adr/0013-routes-and-stops.md.

import type { CommandContext } from "./command.ts";
import type { DrawContext } from "./draw.ts";

export interface OverlayDefinition {
  /** Overlay name; the overlay id is "<extension id>/<name>". */
  readonly name: string;
  /** Drawn in quick mode too. Every overlay is drawn in advanced mode. */
  readonly quick?: boolean;
  /** Whether it is drawn now (for example only while a panel is open). Default: always. */
  visible?(ctx: CommandContext): boolean;
  /**
   * Draws in root space, above the document and below the selection outline
   * and the tool's preview, in every frame the editor draws. `ctx.scale` is
   * device pixels per root unit, so a line `1 / ctx.scale` wide is one device
   * pixel. The editor draws again when the document changes; for anything
   * else the overlay shows (a choice made in a panel), call
   * `services.overlays.invalidate()`.
   */
  draw(ctx: DrawContext, context: CommandContext): void;
}
