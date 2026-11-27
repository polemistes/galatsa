// SPDX-License-Identifier: GPL-3.0-or-later

// The built-in basics extension: the commands every element has, whatever its
// type (docs/adr/0005-extension-interface.md, section 12). Move, resize,
// scale, rotate, move into another container, z-order, frames (around
// elements, removed keeping what is in them, moving into and out of them),
// naming (docs/adr/0014-stacking-and-frames.md), group and ungroup, lock
// and unlock, delete, duplicate, copy and paste as fragments, undo, redo and
// select all. Only commands: the tools, buttons and keys that run them are the
// editor's. Each command checks what the element's type allows; elements of a
// missing extension can be moved, stacked, grouped, locked, deleted and
// copied, but not resized or rotated.

import {
  defineEditExtension,
  defineViewExtension,
  type EditExtension,
} from "@galatsa/extension-api/editing";
import { copy, duplicate, paste } from "./clipboard.ts";
import { API, BASICS_EXTENSION } from "./common.ts";
import { frame, moveIntoFrame, moveOutOfFrame, removeFrame, rename } from "./frames.ts";
import { redo, selectAll, undo } from "./history.ts";
import { basicsMessages } from "./messages/index.ts";
import {
  bringForwardCommand,
  bringToFrontCommand,
  deleteCommand,
  group,
  lock,
  reparent,
  sendBackwardCommand,
  sendToBackCommand,
  ungroup,
  unlock,
} from "./structure.ts";
import { move, resize, rotate, scale } from "./transform.ts";

export {
  BASICS_EXTENSION,
  // The rules of which elements a command may act on, for other extensions' commands.
  canTarget,
  canTargetAll,
  isOpenContainer,
  type Need,
} from "./common.ts";
export { basicsMessages } from "./messages/index.ts";
export {
  FRAME_PADDING,
  MAX_NAME_LENGTH,
  elementName,
  drawingPath,
  frameAt,
  frameIds,
  openFrames,
  topFrameAt,
  type OpenFrame,
  isFrame,
  type FrameArgs,
  type MoveIntoFrameArgs,
  type RenameArgs,
} from "./frames.ts";
export {
  DUPLICATE_OFFSET,
  readFragment,
  type ReadFragmentResult,
  type PasteOutcome,
} from "./clipboard.ts";
export type { DuplicateArgs, PasteArgs } from "./clipboard.ts";
export type { IdsArgs, ReparentArgs } from "./structure.ts";
export type { MoveArgs, ResizeArgs, RotateArgs, ScaleArgs } from "./transform.ts";

/** Command ids. */
export const BASICS = {
  move: `${BASICS_EXTENSION}/move`,
  resize: `${BASICS_EXTENSION}/resize`,
  scale: `${BASICS_EXTENSION}/scale`,
  rotate: `${BASICS_EXTENSION}/rotate`,
  reparent: `${BASICS_EXTENSION}/reparent`,
  bringToFront: `${BASICS_EXTENSION}/bring-to-front`,
  sendToBack: `${BASICS_EXTENSION}/send-to-back`,
  bringForward: `${BASICS_EXTENSION}/bring-forward`,
  sendBackward: `${BASICS_EXTENSION}/send-backward`,
  frame: `${BASICS_EXTENSION}/frame`,
  removeFrame: `${BASICS_EXTENSION}/remove-frame`,
  moveIntoFrame: `${BASICS_EXTENSION}/move-into-frame`,
  moveOutOfFrame: `${BASICS_EXTENSION}/move-out-of-frame`,
  rename: `${BASICS_EXTENSION}/rename`,
  group: `${BASICS_EXTENSION}/group`,
  ungroup: `${BASICS_EXTENSION}/ungroup`,
  lock: `${BASICS_EXTENSION}/lock`,
  unlock: `${BASICS_EXTENSION}/unlock`,
  delete: `${BASICS_EXTENSION}/delete`,
  duplicate: `${BASICS_EXTENSION}/duplicate`,
  copy: `${BASICS_EXTENSION}/copy`,
  paste: `${BASICS_EXTENSION}/paste`,
  undo: `${BASICS_EXTENSION}/undo`,
  redo: `${BASICS_EXTENSION}/redo`,
  selectAll: `${BASICS_EXTENSION}/select-all`,
} as const;

export const basicsViewExtension = defineViewExtension({
  id: BASICS_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [basicsMessages],
});

export const basicsExtension: EditExtension = defineEditExtension({
  view: basicsViewExtension,
  contributes: {
    commands: [
      move,
      resize,
      scale,
      rotate,
      reparent,
      bringToFrontCommand,
      sendToBackCommand,
      bringForwardCommand,
      sendBackwardCommand,
      frame,
      removeFrame,
      moveIntoFrame,
      moveOutOfFrame,
      rename,
      group,
      ungroup,
      lock,
      unlock,
      deleteCommand,
      duplicate,
      copy,
      paste,
      undo,
      redo,
      selectAll,
    ],
  },
});
