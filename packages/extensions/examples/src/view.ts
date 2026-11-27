// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing parts of the example extensions: what a player needs to draw
// their elements. Nothing reachable from here imports editing code, Yjs or the
// document's operations.

import type { ViewExtension } from "@galatsa/extension-api";
import { imageViewExtension } from "./image-view.ts";
import { shapeViewExtension } from "./shape-view.ts";
import { textViewExtension } from "./text-view.ts";

export * from "./text-view.ts";
export * from "./shape-view.ts";
export * from "./image-view.ts";

/** The viewing parts of the example extensions that define element types. */
export const exampleViewExtensions: readonly ViewExtension[] = [
  textViewExtension,
  shapeViewExtension,
  imageViewExtension,
];
