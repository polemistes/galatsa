// SPDX-License-Identifier: GPL-3.0-or-later

// Exchanging state between Y.Docs, and the checks that must pass first. The sync
// server will do the same over the network; tests use these to simulate
// replicas. Sections 9.3 and 9.4 of
// docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import { SCHEMA_VERSION } from "../model/types.ts";
import { NewerVersionError, roots } from "./schema.ts";
import { isBlank, lineageOf } from "./snapshot.ts";
import { trackWork } from "./track.ts";

/** Origin of transactions that apply another replica's updates. */
export const SYNC_ORIGIN = "galatsa:sync";

/** Raised when two documents do not share merge identity. */
export class MergeIdentityError extends Error {
  constructor(a: string, b: string) {
    super(
      `Documents have different lineages (${a || "none"} and ${b || "none"}) and cannot be merged`,
    );
    this.name = "MergeIdentityError";
  }
}

/** What a replica tells another before they exchange updates. */
export interface SyncHello {
  /** Merge identity; empty for a blank replica. */
  lineage: string;
  /** The oldest reader version that can read the replica's content. */
  minReaderVersion: number;
  /** True if the replica holds nothing yet. */
  blank: boolean;
}

/** The format version a document needs its readers to have. */
export function neededVersion(doc: Y.Doc): number {
  const needed = roots(doc).meta.get("minReaderVersion");
  return typeof needed === "number" && Number.isInteger(needed) && needed >= 1
    ? needed
    : 1;
}

export function syncHello(doc: Y.Doc): SyncHello {
  return {
    lineage: lineageOf(doc),
    minReaderVersion: neededVersion(doc),
    blank: isBlank(doc),
  };
}

export type SyncVerdict = "ok" | "different-lineage" | "needs-newer-version";

/**
 * Whether this replica may exchange updates with one that sent `remote`.
 * - A replica whose content needs a newer format version than this code reads is
 *   refused: this code would not understand, and could not keep, what it holds.
 * - A blank replica may join any document.
 * - Otherwise both must have the same lineage.
 */
export function checkSync(
  local: Y.Doc,
  remote: SyncHello,
  readerVersion: number = SCHEMA_VERSION,
): SyncVerdict {
  if (remote.minReaderVersion > readerVersion) return "needs-newer-version";
  if (remote.blank || isBlank(local)) return "ok";
  const lineage = lineageOf(local);
  return lineage !== "" && lineage === remote.lineage ? "ok" : "different-lineage";
}

/** True if the two documents may exchange updates. */
export function canMerge(a: Y.Doc, b: Y.Doc): boolean {
  return checkSync(a, syncHello(b)) === "ok" && checkSync(b, syncHello(a)) === "ok";
}

/** A replica of `doc` that shares its CRDT identity, as a peer would receive it. */
export function forkDoc(doc: Y.Doc, clientID?: number): Y.Doc {
  const copy = new Y.Doc();
  if (clientID !== undefined) copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), SYNC_ORIGIN);
  trackWork(copy);
  return copy;
}

function assertSync(local: Y.Doc, remote: Y.Doc): void {
  const verdict = checkSync(local, syncHello(remote));
  if (verdict === "needs-newer-version") {
    throw new NewerVersionError(neededVersion(remote), SCHEMA_VERSION);
  }
  if (verdict === "different-lineage") {
    throw new MergeIdentityError(lineageOf(local), lineageOf(remote));
  }
}

/** Sends `from` what it has that `to` is missing. */
export function syncInto(to: Y.Doc, from: Y.Doc): void {
  assertSync(to, from);
  assertSync(from, to);
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), SYNC_ORIGIN);
}

/** Sends each replica what the other is missing, in both directions. */
export function syncDocs(a: Y.Doc, b: Y.Doc): void {
  assertSync(a, b);
  assertSync(b, a);
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB, SYNC_ORIGIN);
  Y.applyUpdate(a, toA, SYNC_ORIGIN);
}

/**
 * Calls `onNewer` when the document starts to need a newer format version than
 * this code reads, which can happen while co-editing with a newer client. From
 * then on this replica must stop editing and saving the document: operations
 * throw NewerVersionError, and the file writer refuses. Returns a function that
 * stops watching.
 */
export function watchVersion(
  doc: Y.Doc,
  onNewer: (needed: number) => void,
  readerVersion: number = SCHEMA_VERSION,
): () => void {
  const meta = roots(doc).meta;
  let told = false;
  const check = () => {
    const needed = neededVersion(doc);
    if (needed > readerVersion && !told) {
      told = true;
      onNewer(needed);
    }
  };
  meta.observe(check);
  check();
  return () => meta.unobserve(check);
}
