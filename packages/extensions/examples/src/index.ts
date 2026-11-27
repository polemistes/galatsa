// SPDX-License-Identifier: GPL-3.0-or-later

// Sketches of the text, shape and image extensions and of a selection tool,
// written against @galatsa/extension-api to show that the interface covers
// them. They draw through the drawing context but are not the real extensions;
// those are built on these sketches. This entry has both parts of each; a
// viewer imports "@galatsa/extension-examples/view", which has only the viewing
// parts. See docs/adr/0005-extension-interface.md, section 11.

import type { EditExtension } from "@galatsa/extension-api/editing";
import { imageExtension } from "./image.ts";
import { selectExtension } from "./select.ts";
import { shapeExtension } from "./shape.ts";
import { textExtension } from "./text.ts";

export * from "./text.ts";
export * from "./shape.ts";
export * from "./image.ts";
export * from "./select.ts";
export { exampleMessages } from "./messages/index.ts";

/** The example extensions, with their editing parts. */
export const exampleExtensions: readonly EditExtension[] = [
  textExtension,
  shapeExtension,
  imageExtension,
  selectExtension,
];
