// SPDX-License-Identifier: GPL-3.0-or-later

// Sketches of the text, shape and image extensions, written against
// @galatsa/extension-api to show that the interface covers them. They draw
// through the drawing context but are not the real extensions; those are built
// on these sketches. See docs/adr/0005-extension-interface.md, section 11.

import type { Extension } from "@galatsa/extension-api";
import { imageExtension } from "./image.ts";
import { shapeExtension } from "./shape.ts";
import { textExtension } from "./text.ts";

export * from "./text.ts";
export * from "./shape.ts";
export * from "./image.ts";
export { exampleMessages } from "./messages/index.ts";

/** The three example extensions. */
export const exampleExtensions: readonly Extension[] = [
  textExtension,
  shapeExtension,
  imageExtension,
];
