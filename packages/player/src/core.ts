// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/player/core: the presentation without the browser. The state of a
// presentation (route, stop, pause, roaming), the camera that plays the
// transitions, and what the player reads of a document. No DOM, no renderer
// and no Yjs. See docs/adr/0015-presentation.md.

export * from "./model.ts";
export * from "./roam.ts";
export * from "./playback.ts";
export * from "./presentation.ts";
