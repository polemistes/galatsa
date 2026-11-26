// SPDX-License-Identifier: GPL-3.0-or-later

// Exchanging state between two Y.Docs in memory. The sync server will do the same
// over the network; tests use these to simulate two replicas.

import * as Y from "yjs";

/** A replica of `doc` that shares its CRDT identity, as a peer would receive it. */
export function forkDoc(doc: Y.Doc, clientID?: number): Y.Doc {
  const copy = new Y.Doc();
  if (clientID !== undefined) copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Sends each replica what the other is missing, in both directions. */
export function syncDocs(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
}
