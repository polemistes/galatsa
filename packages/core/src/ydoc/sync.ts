// SPDX-License-Identifier: GPL-3.0-or-later

// Exchanging state between two Y.Docs in memory. The sync server will do the same
// over the network; tests use these to simulate replicas. Merging is refused when
// the two documents have different lineages (section 9.3).

import * as Y from "yjs";
import { lineageOf } from "./snapshot.ts";

/** Raised when two documents do not share merge identity. */
export class MergeIdentityError extends Error {
  constructor(a: string, b: string) {
    super(
      `Documents have different lineages (${a || "none"} and ${b || "none"}) and cannot be merged`,
    );
    this.name = "MergeIdentityError";
  }
}

/** True if the two documents may exchange updates. */
export function canMerge(a: Y.Doc, b: Y.Doc): boolean {
  return lineageOf(a) === lineageOf(b);
}

/** A replica of `doc` that shares its CRDT identity, as a peer would receive it. */
export function forkDoc(doc: Y.Doc, clientID?: number): Y.Doc {
  const copy = new Y.Doc();
  if (clientID !== undefined) copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Sends each replica what the other is missing, in both directions. */
export function syncDocs(a: Y.Doc, b: Y.Doc): void {
  if (!canMerge(a, b)) throw new MergeIdentityError(lineageOf(a), lineageOf(b));
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
}
