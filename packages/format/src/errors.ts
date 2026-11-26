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
  /** Needs a newer Galatsa: a higher minimum reader version, or zip64. */
  | "newer-version"
  /** Larger than the configured limits. */
  | "too-large"
  /** Uses an archive feature this format does not use (encryption, split archives). */
  | "unsupported";

export class FileFormatError extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileFormatError";
    this.code = code;
  }
}

/** Something worth telling the user about a file that did open, or was written. */
export type FileWarningCode =
  /** ydoc.bin did not match document.json or could not be decoded; merge identity was lost. */
  | "ydoc-discarded"
  /** document.json was unreadable; the document was recovered from ydoc.bin. */
  | "document-recovered"
  /**
   * Parts of the document did not fit the format and were read as defaults, left
   * out, or kept as unsupported values. `details` lists them.
   */
  | "content-quarantined"
  /** The Yjs state could not be written; the file has no merge identity. */
  | "ydoc-not-written"
  /** The file was upgraded from an older format version; merge identity was lost. */
  | "migrated"
  /** An asset's bytes did not match its id and were ignored. */
  | "asset-damaged"
  /** An element that is not deleted refers to an asset whose bytes are not in the file. */
  | "asset-missing"
  /** Visible content refers to an asset the document has no description of. */
  | "asset-undescribed"
  /** The thumbnail is missing although the manifest lists it. */
  | "thumbnail-missing";

export interface FileWarning {
  code: FileWarningCode;
  message: string;
  /** For "content-quarantined": what was changed, at most the first 1000. */
  details?: string[];
}
