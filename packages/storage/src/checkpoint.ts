// SPDX-License-Identifier: GPL-3.0-or-later

// Checkpoints: the whole document, as a Galatsa file without assets, in a frame
// that says which journal entries it holds. Section 4.2 of
// docs/adr/0006-storage.md.

import { ORIGIN, trackWork } from "@galatsa/core/ydoc";
import { readGalatsaFile, writeGalatsaFile, type FileWarning } from "@galatsa/format";
import * as Y from "yjs";
import { FRAME_KIND, decodeFrame, encodeFrame } from "./frame.ts";

/** What a checkpoint encoder makes of a Yjs state. */
export interface EncodedCheckpoint {
  /** A Galatsa file of the document, without assets. */
  file: Uint8Array;
  /**
   * True if the file could not hold the Yjs state (it is larger than a reader
   * accepts): the state is then stored next to it, so the journal still applies.
   */
  keepState: boolean;
}

/**
 * Turns a Yjs state into a checkpoint file. A pure function of its input, so a
 * program can run it in a worker to keep the work off the editing thread.
 */
export type CheckpointEncoder = (state: Uint8Array) => Promise<EncodedCheckpoint>;

/**
 * Writes the Galatsa file of a Yjs state, without assets. Throws FileFormatError
 * if the document needs a newer format ("newer-version") or does not fit in a
 * file ("too-large").
 */
export function encodeCheckpointFile(
  state: Uint8Array,
  generator = "Galatsa",
): EncodedCheckpoint {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state, ORIGIN.load);
    const written = writeGalatsaFile(doc, () => undefined, { generator });
    return {
      file: written.bytes,
      keepState: written.warnings.some((w) => w.code === "ydoc-not-written"),
    };
  } finally {
    doc.destroy();
  }
}

/** The default encoder: on the calling thread, after yielding once. */
export const encodeCheckpoint: CheckpointEncoder = async (state) => {
  await Promise.resolve();
  return encodeCheckpointFile(state);
};

export interface CheckpointHeader {
  generation: number;
  /** The generation this one was built on (0 for the first). */
  base: number;
  session: string;
  /** Journal entries whose content this checkpoint holds. */
  includes: string[];
  createdAt: number;
}

export function frameCheckpoint(
  header: CheckpointHeader,
  encoded: EncodedCheckpoint,
  state: Uint8Array,
): Uint8Array {
  const kept = encoded.keepState ? state : new Uint8Array(0);
  const payload = new Uint8Array(encoded.file.length + kept.length);
  payload.set(encoded.file, 0);
  payload.set(kept, encoded.file.length);
  return encodeFrame(
    FRAME_KIND.checkpoint,
    { ...header, fileLength: encoded.file.length },
    payload,
  );
}

export interface LoadedCheckpoint {
  header: CheckpointHeader;
  /** The document, with work tracking attached. */
  doc: Y.Doc;
  /** False if the checkpoint's Yjs state was unusable and the document was rebuilt. */
  mergeIdentityKept: boolean;
  warnings: FileWarning[];
}

function readHeader(
  raw: Record<string, unknown>,
): (CheckpointHeader & { fileLength: number }) | null {
  const { generation, base, session, includes, createdAt, fileLength } = raw;
  if (
    typeof generation !== "number" ||
    typeof base !== "number" ||
    typeof session !== "string" ||
    typeof createdAt !== "number" ||
    typeof fileLength !== "number" ||
    !Array.isArray(includes) ||
    !includes.every((key) => typeof key === "string")
  ) {
    return null;
  }
  return {
    generation,
    base,
    session,
    includes: includes as string[],
    createdAt,
    fileLength,
  };
}

/** Reads a stored checkpoint; null if it is damaged in any way. */
export async function loadCheckpoint(
  bytes: Uint8Array,
): Promise<LoadedCheckpoint | null> {
  const frame = decodeFrame(bytes, FRAME_KIND.checkpoint);
  if (!frame) return null;
  const header = readHeader(frame.header);
  if (!header || header.fileLength > frame.payload.length) return null;
  const { fileLength, ...rest } = header;
  const file = frame.payload.subarray(0, fileLength);
  const state = frame.payload.subarray(fileLength);
  try {
    if (state.length > 0) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state, ORIGIN.load);
      if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null;
      trackWork(doc);
      return { header: rest, doc, mergeIdentityKept: true, warnings: [] };
    }
    const read = await readGalatsaFile(file);
    return {
      header: rest,
      doc: read.doc,
      mergeIdentityKept: read.mergeIdentityKept,
      // Assets are stored apart from checkpoints.
      warnings: read.warnings.filter(
        (w) =>
          w.code !== "asset-missing" &&
          w.code !== "asset-undescribed" &&
          w.code !== "thumbnail-missing",
      ),
    };
  } catch {
    return null;
  }
}
