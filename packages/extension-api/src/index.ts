// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-api: the viewing part of the extension interface, which the
// renderer, the player and the editor share: element type views, transitions,
// the drawing context, placeholders, the comfort guard and the viewing host.
// Nothing reachable from this entry needs Yjs or the document's operations, so a
// viewer that imports it carries neither. The editing part is the entry
// "@galatsa/extension-api/editing". See docs/adr/0005-extension-interface.md.

export * from "./ids.ts";
export * from "./draw.ts";
export * from "./element-type.ts";
export * from "./transition.ts";
export * from "./extension.ts";
export * from "./placeholder.ts";
export * from "./host.ts";
export { extensionMessages } from "./messages/index.ts";
