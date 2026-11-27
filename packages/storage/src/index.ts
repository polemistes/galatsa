// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/storage: the layer between the editor and the files, which keeps the
// user's work safe: autosave, the last good copy and recovery after a crash. See
// docs/adr/0006-storage.md.

export {
  StorageError,
  checkKey,
  errorKind,
  type StorageBackend,
  type StorageErrorKind,
} from "./backend.ts";
export {
  encodeCheckpoint,
  encodeCheckpointFile,
  type CheckpointEncoder,
  type EncodedCheckpoint,
} from "./checkpoint.ts";
export {
  broadcastChannels,
  memoryChannels,
  memoryLiveness,
  systemScheduler,
  webLocksLiveness,
  type Channel,
  type ChannelFactory,
  type ChannelMessage,
  type Liveness,
  type MemoryLiveness,
  type Scheduler,
} from "./environment.ts";
export {
  canSaveInPlace,
  downloadTarget,
  fileHandleTarget,
  memoryFile,
  pickFileToOpen,
  pickFileToSave,
  uploadedFile,
  type FileSource,
  type FileTarget,
  type MemoryFile,
} from "./files.ts";
export {
  indexedDbBackend,
  requestPersistentStorage,
  type IndexedDbOptions,
} from "./indexeddb.ts";
export {
  createMemoryStore,
  memoryBackend,
  type MemoryBackend,
  type MemoryOperation,
  type MemoryStore,
} from "./memory.ts";
export { storageMessages } from "./messages/index.ts";
export {
  fileNotices,
  noticeText,
  openProblem,
  type Notice,
  type NoticeCode,
  type Severity,
} from "./notices.ts";
export {
  DEFAULT_TIMING,
  STORAGE_ORIGIN,
  StorageSession,
  type AutosaveTiming,
  type SaveResult,
  type SessionStatus,
} from "./session.ts";
export {
  DocumentStorage,
  type OpenResult,
  type RecoveryOffer,
  type StorageOptions,
  type StoredDocument,
} from "./storage.ts";
