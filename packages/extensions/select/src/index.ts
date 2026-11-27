// SPDX-License-Identifier: GPL-3.0-or-later

// The built-in selection extension: the selection tool with handles to move,
// scale, resize and rotate (docs/adr/0008-selection.md), and frames while
// editing: their outlines and names on the canvas, dragging into and out of
// them, and the frame tool (docs/adr/0014-stacking-and-frames.md). It is
// written against the extension interface and runs the basics' commands, like
// any other extension; the editor loads it right after the basics and makes
// its selection tool the default.

import { EXTENSION_API_VERSION, messageKey, type Label } from "@galatsa/extension-api";
import {
  defineEditExtension,
  defineViewExtension,
  type EditExtension,
} from "@galatsa/extension-api/editing";
import { BASICS_EXTENSION } from "@galatsa/extension-basics";
import type { BundleKey } from "@galatsa/i18n";
import { startFrameTool } from "./frame-tool.ts";
import { frameOverlay } from "./frames.ts";
import { selectMessages } from "./messages/index.ts";
import { startSelectTool } from "./tool.ts";

export { selectMessages } from "./messages/index.ts";
export {
  CLICK_SLOP,
  HANDLE_FRAME_MIN,
  HANDLE_REACH,
  HANDLE_SIZE,
  ROTATE_LIFT,
  ROTATE_STEP,
  startSelectTool,
} from "./tool.ts";
export * from "./geometry.ts";
export { CLICK_FRAME, startFrameTool } from "./frame-tool.ts";
export {
  LABEL_HEIGHT,
  LABEL_MAX_WIDTH,
  LABEL_MIN_FRAME,
  UNNAMED_FRAME,
  dropBox,
  dropInto,
  frameOverlay,
  labelAt,
  labelRect,
  planDrop,
  shownFrames,
  type DropPlan,
  type ShownFrame,
} from "./frames.ts";

/** The extension's id. */
export const SELECT_EXTENSION = "galatsa.select";
/** The selection tool's id. */
export const SELECT_TOOL = `${SELECT_EXTENSION}/select`;
/** The frame tool's id. */
export const FRAME_TOOL = `${SELECT_EXTENSION}/frame`;

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
      {
        name: "frame",
        label: label("frame-tool"),
        shortcuts: ["f"],
        quick: true,
        group: "frame",
        cursor: "crosshair",
        start: startFrameTool,
      },
    ],
    overlays: [frameOverlay],
  },
});
