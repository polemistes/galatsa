// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Why a file could not be opened. The editor maps each code to a translated
 * message; `message` is an English description for logs.
 */
export type FileErrorCode =
  /** Not a zip archive at all. */
  | "not-zip"
  /** A zip archive, but not a Galatsa file. */
  | "not-galatsa"
  /** A Galatsa file with a broken archive, checksum or JSON. */
  | "damaged"
  /** Made by a newer Galatsa with a higher format version. */
  | "newer-version"
  /** The document does not have the required structure. */
  | "invalid-document"
  /** Larger than the configured limits. */
  | "too-large"
  /** Uses an archive feature this version does not support (zip64, encryption). */
  | "unsupported";

export class FileFormatError extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileFormatError";
    this.code = code;
  }
}

/** Something worth telling the user about a file that did open. */
export type FileWarningCode =
  /** ydoc.bin did not match document.json or could not be decoded; merge identity was lost. */
  | "ydoc-discarded"
  /** The file was upgraded from an older format version; merge identity was lost. */
  | "migrated"
  /** An asset's bytes did not match its id and were ignored. */
  | "asset-damaged"
  /** An element that is not deleted refers to an asset whose bytes are not in the file. */
  | "asset-missing"
  /** The thumbnail is missing although the manifest lists it. */
  | "thumbnail-missing";

export interface FileWarning {
  code: FileWarningCode;
  message: string;
}
