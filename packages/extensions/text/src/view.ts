// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-text/view: the viewing part of the text extension, what
// the renderer and the player need to draw text boxes. Nothing reachable from
// here imports editing code, Yjs or the document's operations.

import {
  EXTENSION_API_VERSION,
  defineElementView,
  defineViewExtension,
  messageKey,
  type Label,
  type TextStyle,
} from "@galatsa/extension-api";
import type { BundleKey } from "@galatsa/i18n";
import { textMessages } from "./messages/index.ts";
import { LINE_HEIGHT, drawnAlign, readText, type TextModel } from "./model.ts";

export * from "./model.ts";
export { textMessages } from "./messages/index.ts";

export function textLabel(key: BundleKey<typeof textMessages>): Label {
  return messageKey(textMessages, key);
}

/** The style the renderer lays a text box out with. */
export function styleOf(model: TextModel): TextStyle {
  return {
    fontFamily: model.fontFamily,
    fontSize: model.fontSize,
    color: model.color,
    align: drawnAlign(model),
    lineHeight: LINE_HEIGHT,
  };
}

export const textView = defineElementView<TextModel>({
  name: "text",
  label: textLabel("name"),
  typeVersion: 1,
  read: (data, _typeVersion, report) => readText(data, report),
  draw(model, ctx, box) {
    if (ctx.detail === "box") {
      // A few pixels tall: a faint bar in the text colour stands in for the text.
      const bar = ctx.createPath();
      bar.rect(0, 0, box.w, Math.min(box.h, model.fontSize * LINE_HEIGHT));
      ctx.withOpacity(0.3, () => ctx.fill(bar, model.color));
      return;
    }
    ctx.drawText(ctx.layoutText(model.text, styleOf(model), box.w), 0, 0);
  },
});

export const textViewExtension = defineViewExtension({
  id: "galatsa.text",
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [textMessages],
  elementTypes: [textView],
});
