// SPDX-License-Identifier: GPL-3.0-or-later

// Reading a Galatsa file into the JSON form, without Yjs (the player needs only
// this). Section 9 of docs/adr/0001-document-model-and-file-format.md.

export { readGalatsaSnapshot } from "./parts.ts";
export type { ReadOptions, SnapshotReadResult } from "./parts.ts";
