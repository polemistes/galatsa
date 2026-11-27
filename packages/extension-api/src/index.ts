// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-api: the extension interface of Galatsa and the host that
// loads extensions. See docs/adr/0005-extension-interface.md.
//
// The definitions (element types, tools, commands, import, export, transitions,
// panels) are types. The runtime parts are the host, the command registry, the
// placeholder drawing and the comfort guard, which need no Yjs at run time,
// and the helpers in element-ops.ts and transfer-ops.ts, which use the
// document model's Yjs operations and are only for the editor.

export * from "./ids.ts";
export * from "./draw.ts";
export * from "./fields.ts";
export * from "./element-type.ts";
export * from "./command.ts";
export * from "./tool.ts";
export * from "./transfer.ts";
export * from "./transition.ts";
export * from "./panel.ts";
export * from "./extension.ts";
export * from "./placeholder.ts";
export * from "./host.ts";
export * from "./element-ops.ts";
export * from "./transfer-ops.ts";
export { extensionMessages } from "./messages/index.ts";
