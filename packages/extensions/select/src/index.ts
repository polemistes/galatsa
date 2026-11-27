// SPDX-License-Identifier: GPL-3.0-or-later

// The built-in selection extension: the selection tool with handles to move,
// scale, resize and rotate (docs/adr/0008-selection.md). It is written
// against the extension interface and runs the basics' commands, like any
// other extension; the editor loads it right after the basics and makes its
// tool the default.

import { EXTENSION_API_VERSION, messageKey, type Label } from "@galatsa/extension-api";
import {
  defineEditExtension,
  defineViewExtension,
  type EditExtension,
} from "@galatsa/extension-api/editing";
import { BASICS_EXTENSION } from "@galatsa/extension-basics";
import type { BundleKey } from "@galatsa/i18n";
import { selectMessages } from "./messages/index.ts";
import { startSelectTool } from "./tool.ts";

export { selectMessages } from "./messages/index.ts";
export {
  CLICK_SLOP,
  HANDLE_REACH,
  HANDLE_SIZE,
  ROTATE_LIFT,
  ROTATE_STEP,
  startSelectTool,
} from "./tool.ts";
export * from "./geometry.ts";

/** The extension's id. */
export const SELECT_EXTENSION = "galatsa.select";
/** The selection tool's id. */
export const SELECT_TOOL = `${SELECT_EXTENSION}/select`;

function label(key: BundleKey<typeof selectMessages>): Label {
  return messageKey(selectMessages, key);
}

export const selectViewExtension = defineViewExtension({
  id: SELECT_EXTENSION,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  dependencies: [{ id: BASICS_EXTENSION }],
  messages: [selectMessages],
});

export const selectExtension: EditExtension = defineEditExtension({
  view: selectViewExtension,
  contributes: {
    tools: [
      {
        name: "select",
        label: label("tool"),
        shortcuts: ["v"],
        quick: true,
        group: "select",
        cursor: "default",
        start: startSelectTool,
      },
    ],
  },
});
