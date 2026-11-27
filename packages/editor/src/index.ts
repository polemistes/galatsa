// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/editor: the editor. See docs/adr/0007-editor-foundation.md.

export {
  Editor,
  type EditorChange,
  type EditorNotice,
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
export {
  assetImages,
  documentAssets,
  type AssetImagesOptions,
  type AssetReader,
} from "./images.ts";
export {
  ensurePreviews,
  isImageType,
  sessionAssetStore,
  type AssetAccess,
  type PreviewMaker,
} from "./assets.ts";
export {
  chooseImporter,
  importSource,
  IMPORT_CASCADE,
  IMPORT_NOTICES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  mergeFragments,
  placeFragments,
  readFiles,
  type ImportFile,
  type ImportReport,
  type PlacedFragment,
} from "./import.ts";
export {
  loadExtensions,
  registerEditorMessages,
  type LoadedExtensions,
} from "./extensions.ts";
export { mountEditor, wheelZoomFactor } from "./dom.ts";
export {
  FRAGMENT_MIME,
  MAX_CLIPBOARD_TEXT,
  MAX_PASTE_DEPTH,
  MAX_PASTE_ELEMENTS,
  decodeEnvelope,
  decodeFragment,
  encodeFragment,
  readClipboard,
  readClipboardText,
  withinLimits,
  writeFragment,
  type ClipboardContent,
  type ClipboardFile,
  type ClipboardOrigin,
  type ClipboardProblem,
  type ClipboardSource,
  type ClipboardTarget,
} from "./clipboard.ts";
export {
  ContextMenu,
  menuEntries,
  openContextMenu,
  type MenuClipboard,
  type MenuEntry,
  type MenuState,
} from "./context-menu.ts";
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
