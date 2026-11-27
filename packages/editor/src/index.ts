// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/editor: the editor. See docs/adr/0007-editor-foundation.md.

export {
  Editor,
  type EditorChange,
  type EditorOptions,
  type FrameScheduler,
  type KeyResult,
  type PointerInput,
  type ShortcutResult,
  type ShortcutTarget,
} from "./editor.ts";
export { EditorScene } from "./scene-source.ts";
export { createServices, selectableFor, topLevel, type EditorState } from "./services.ts";
export { ToolController } from "./tools.ts";
export {
  detectPlatform,
  keyInput,
  matchShortcut,
  platformShortcut,
  shortcutCandidates,
  type KeyInput,
  type Platform,
} from "./keymap.ts";
export {
  fitCamera,
  panBy,
  screenToCamera,
  screenToWorld,
  visibleWorld,
  worldToScreen,
  zoomAbout,
  type Placement,
  type ScreenSize,
} from "./camera.ts";
export {
  NAVIGATION,
  NAVIGATION_EXTENSION,
  navigationExtension,
  PAN_STEP,
  ZOOM_STEP,
} from "./navigation.ts";
export { assetImages, documentAssets, type AssetReader } from "./images.ts";
export {
  loadExtensions,
  registerEditorMessages,
  type LoadedExtensions,
} from "./extensions.ts";
export { mountEditor, wheelZoomFactor } from "./dom.ts";
export {
  EditorDocument,
  type DocumentOptions,
  type DocumentPhase,
  type DocumentState,
} from "./document.ts";
export { EditorApp, type AppPhase, type AppState, type EditorAppOptions } from "./app.ts";
export { renderEditorUi } from "./ui/mount.ts";
export { svelteView, type PanelProps } from "./ui/panels.ts";
export { Watched, translator, type Store } from "./ui/reactive.ts";
export { default as EditorUi } from "./ui/EditorUi.svelte";
export { editorMessages } from "./messages/index.ts";
