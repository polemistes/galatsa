// SPDX-License-Identifier: GPL-3.0-or-later

// "Discard the changes" (docs/adr/0006, section 7.1) replaces the stored copy
// of a document, with the work recovered in it, by the file it was last saved
// to. The user picks that file, because no file handle is kept yet, and could
// pick any file: so before anything is discarded, the picked file must be the
// same presentation. Copies of one presentation share a document id
// (docs/adr/0001); where the stored copy has none, the file must at least have
// the name the presentation was saved under.

import { UNKNOWN_DOCUMENT_ID } from "@galatsa/core";
import { readGalatsaFile } from "@galatsa/format";
import type { FileSource, StoredDocument } from "@galatsa/storage";

export type DiscardFileCheck =
  /** The file to discard to (its bytes, read once). */
  | { readonly ok: true; readonly file: FileSource }
  /** The file is another presentation: nothing may be discarded. */
  | { readonly ok: false; readonly reason: "other-document"; readonly name: string };

/**
 * Checks that `file` is the presentation `offer` describes. A file that cannot
 * be read is passed on: discarding then fails when it opens the file, and the
 * stored copy stays.
 */
export async function checkDiscardFile(
  offer: Pick<StoredDocument, "documentId" | "fileName">,
  file: FileSource,
): Promise<DiscardFileCheck> {
  let bytes: Uint8Array;
  try {
    bytes = await file.read();
  } catch {
    return { ok: true, file };
  }
  const source: FileSource = { name: file.name, read: async () => bytes };
  let id: string;
  try {
    const read = await readGalatsaFile(bytes);
    id = read.snapshot.id;
    read.doc.destroy();
  } catch {
    return { ok: true, file: source };
  }
  const known = offer.documentId !== UNKNOWN_DOCUMENT_ID && offer.documentId !== "";
  const same = known ? id === offer.documentId : file.name === offer.fileName;
  return same
    ? { ok: true, file: source }
    : { ok: false, reason: "other-document", name: file.name };
}
