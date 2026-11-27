// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/player: presentation mode. The presentation and its camera
// ("@galatsa/player/core", no DOM), and the player in a page: stage, input,
// laser pointer and presenter notes. It uses the viewing parts of the
// extensions only, and nothing here imports Yjs, the document's operations or
// the editor: the editor presents with this package, and the player of a
// file is the same code. See docs/adr/0015-presentation.md.

export * from "./core.ts";
export { keyAction, type KeyAction, type PlayerKey } from "./keys.ts";
export { Stage, type StageOptions } from "./stage.ts";
export { mountPlayer, type MountedPlayer, type PlayerOptions } from "./player.ts";
export { playerMessages } from "./messages/index.ts";
