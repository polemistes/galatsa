// SPDX-License-Identifier: GPL-3.0-or-later

// How an element is drawn when its type cannot draw it: the extension is
// missing, is older than the element, or failed. See
// docs/adr/0005-extension-interface.md, section 3.7.

import type { DrawContext } from "./draw.ts";
import type { ElementBox } from "./element-type.ts";
import type { Label } from "./ids.ts";
import { messageKey } from "./ids.ts";
import { extensionMessages } from "./messages/index.ts";

/** Why an element is drawn as a placeholder. */
export type PlaceholderReason = "missing" | "newer" | "failed";

const LABELS: Readonly<Record<PlaceholderReason, Label>> = {
  missing: messageKey(extensionMessages, "placeholder.missing"),
  newer: messageKey(extensionMessages, "placeholder.newer"),
  failed: messageKey(extensionMessages, "placeholder.failed"),
};

/** The label a placeholder shows, with its values. */
export function placeholderLabel(
  reason: PlaceholderReason,
  type: string,
): { readonly label: Label; readonly values: { readonly type: string } } {
  return { label: LABELS[reason], values: { type } };
}

/** Neutral colours, readable on light and dark canvases. */
const FILL = "rgb(148 163 184 / 0.15)";
const LINE = "rgb(100 116 139)";

/**
 * Draws a placeholder: the element's box, dashed, with the localized reason and
 * the type id. Used by the renderer and the player alike.
 */
export function drawPlaceholder(
  ctx: DrawContext,
  box: ElementBox,
  reason: PlaceholderReason,
  type: string,
): void {
  const outline = ctx.createPath();
  outline.rect(0, 0, box.w, box.h);
  ctx.fill(outline, FILL);
  const pixel = 1 / Math.max(ctx.scale, Number.MIN_VALUE);
  ctx.stroke(outline, { color: LINE, width: pixel, dash: [4 * pixel, 4 * pixel] });
  if (ctx.detail !== "full") return;
  const { label, values } = placeholderLabel(reason, type);
  // Text of 12 device pixels, but never larger than a quarter of the box.
  const fontSize = Math.min(12 * pixel, box.h / 4);
  const margin = fontSize / 2;
  if (fontSize <= 0 || box.w <= 2 * margin) return;
  const layout = ctx.layoutText(
    ctx.t(label, values),
    { fontFamily: "sans-serif", fontSize, color: LINE, align: "center" },
    box.w - 2 * margin,
  );
  ctx.withClip(outline, () =>
    ctx.drawText(layout, margin, Math.max(margin, (box.h - layout.height) / 2)),
  );
}
