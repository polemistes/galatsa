// SPDX-License-Identifier: GPL-3.0-or-later

// One live resolver per Y.Doc, kept up to date after every transaction: local
// changes, updates from other replicas, undo and redo, tidy up, loading.
// Section 11 of docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import { LiveResolver } from "../model/live.ts";
import { Resolver } from "../model/resolve.ts";
import type { ElementId } from "../model/types.ts";
import { roots } from "./schema.ts";
import { yLookup } from "./snapshot.ts";

interface Live {
  readonly resolver: LiveResolver;
  /** Transactions begun and not yet taken in. */
  readonly pending: Set<Y.Transaction>;
}

const lives = new WeakMap<Y.Doc, Live>();

/**
 * The element records a transaction changed, with the record keys that changed,
 * or null where a record as a whole was added, replaced or removed.
 */
function touchedBy(
  elements: Y.AbstractType<unknown>,
  tr: Y.Transaction,
): Map<ElementId, Set<string> | null> {
  const touched = new Map<ElementId, Set<string> | null>();
  const touch = (id: string, key: string | null) => {
    if (key === null) {
      touched.set(id, null);
      return;
    }
    if (touched.has(id) && touched.get(id) === null) return;
    let keys = touched.get(id);
    if (!keys) touched.set(id, (keys = new Set()));
    keys.add(key);
  };
  for (const [type, keys] of tr.changed) {
    if (type === elements) {
      for (const id of keys) if (id !== null) touch(id, null);
      continue;
    }
    // Up to the record: the key of the record under which the change lies.
    let key: string | null = null;
    for (let at = type as Y.AbstractType<unknown>; ;) {
      const item = at._item;
      if (item === null || !(item.parent instanceof Y.AbstractType)) break;
      if (item.parent === elements) {
        if (item.parentSub === null) break;
        if ((at as unknown) === type)
          for (const k of keys) touch(item.parentSub, k ?? "");
        else touch(item.parentSub, key ?? "");
        break;
      }
      key = item.parentSub;
      at = item.parent as Y.AbstractType<unknown>;
    }
  }
  return touched;
}

/**
 * The live resolver of a document: one Resolver (`LiveResolver`) that is kept up
 * to date after every transaction, whatever made it (an operation, an editor
 * binding, another replica's update, undo or redo, tidy up, loading), and that
 * tells its subscribers which elements each transaction added, changed or
 * removed. The first call creates it; later calls return the same one.
 *
 * It shows the document as of the last transaction that has ended: inside a
 * transaction, and in observers that Yjs calls before the transaction is over,
 * it does not show that transaction's changes yet. Subscribers are called
 * right after each transaction, before the next one begins.
 */
export function liveResolver(doc: Y.Doc): LiveResolver {
  const known = lives.get(doc);
  if (known) return known.resolver;
  const elements = roots(doc).elements as unknown as Y.AbstractType<unknown>;
  const live: Live = { resolver: new LiveResolver(yLookup(doc)), pending: new Set() };
  if (doc._transaction !== null) live.pending.add(doc._transaction);
  lives.set(doc, live);
  doc.on("beforeTransaction", (tr: Y.Transaction) => live.pending.add(tr));
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    live.pending.delete(tr);
    const touched = touchedBy(elements, tr);
    if (touched.size === 0) return;
    try {
      live.resolver.update(touched);
    } catch (error) {
      // Never left out of date: resolve everything anew, then let the error be
      // seen.
      live.resolver.rebuild();
      throw error;
    }
  });
  return live.resolver;
}

/**
 * A Resolver of the document as it is now: the live resolver if the document
 * has one and it has taken in every change made so far (no transaction with
 * changes is open or waiting for its observers), otherwise a new Resolver. The
 * result describes the state at the time of the call; do not keep it across
 * changes of the document.
 */
export function currentResolver(doc: Y.Doc): Resolver {
  const live = lives.get(doc);
  if (live && [...live.pending].every((tr) => tr.changed.size === 0)) {
    return live.resolver;
  }
  return new Resolver(yLookup(doc));
}
