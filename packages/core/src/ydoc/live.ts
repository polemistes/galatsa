// SPDX-License-Identifier: GPL-3.0-or-later

// One live resolver per Y.Doc, kept up to date with every change: local
// changes, updates from other replicas, undo and redo, tidy up, loading.
// Section 11 of docs/adr/0001-document-model-and-file-format.md.
//
// Yjs ends transactions in batches: a transaction, and the transactions that
// its observers start while it ends (the work tracker records work that way),
// are cleaned up one after the other, and then 'afterAllTransactions' is
// emitted with all of them. The live resolver takes in a whole batch there, at
// once: the document is then in the state all of them left, which is the only
// state it can read. (Taking in one transaction of a batch while reading the
// state a later one had already written left parts of its cache out of date.)

import * as Y from "yjs";
import { LiveResolver } from "../model/live.ts";
import { Resolver } from "../model/resolve.ts";
import type { ElementId } from "../model/types.ts";
import { roots } from "./schema.ts";
import { yLookup } from "./snapshot.ts";

type Touched = Map<ElementId, Set<string> | null>;

/**
 * Adds the element records a transaction changed to `touched`, with the record
 * keys that changed, or null where a record as a whole was added, replaced or
 * removed. (What it reads of the changed types, their place in their parents,
 * stays readable after the transaction ended.)
 */
function addTouched(
  elements: Y.AbstractType<unknown>,
  tr: Y.Transaction,
  touched: Touched,
): void {
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
}

/** The live resolver of one Y.Doc. */
class DocumentResolver extends LiveResolver {
  readonly #doc: Y.Doc;
  readonly #elements: Y.AbstractType<unknown>;
  /** Transactions begun and not yet taken in. */
  readonly #pending = new Set<Y.Transaction>();
  #catchingUp = false;
  readonly #onBegin = (tr: Y.Transaction) => {
    this.#pending.add(tr);
  };
  readonly #onBatch = () => this.catchUp();

  constructor(doc: Y.Doc) {
    super(yLookup(doc));
    this.#doc = doc;
    this.#elements = roots(doc).elements as unknown as Y.AbstractType<unknown>;
    // A transaction open now may write after the state just read.
    if (doc._transaction !== null) this.#pending.add(doc._transaction);
    doc.on("beforeTransaction", this.#onBegin);
    doc.on("afterAllTransactions", this.#onBatch);
  }

  /**
   * Takes in every transaction that has ended and is not taken in yet. Nothing
   * happens while a batch is still ending, or while this is running already
   * (a subscriber that writes): the loop below takes those in after it.
   *
   * Normally this runs when a batch has ended. It also runs before an
   * operation reads the live resolver, so a batch whose 'afterAllTransactions'
   * did not reach it (another listener threw first) is taken in then.
   */
  catchUp(): void {
    if (this.#catchingUp || this.#doc._transactionCleanups.length > 0) return;
    this.#catchingUp = true;
    try {
      while (this.#pending.size > 0) {
        const touched: Touched = new Map();
        for (const tr of this.#pending) addTouched(this.#elements, tr, touched);
        this.#pending.clear();
        if (touched.size > 0) this.update(touched);
      }
    } finally {
      this.#catchingUp = false;
    }
  }

  /** True if it shows the document as it is now. */
  isCurrent(): boolean {
    this.catchUp();
    for (const tr of this.#pending) if (tr.changed.size > 0) return false;
    return true;
  }

  detach(): void {
    this.#doc.off("beforeTransaction", this.#onBegin);
    this.#doc.off("afterAllTransactions", this.#onBatch);
    this.#pending.clear();
  }
}

const lives = new WeakMap<Y.Doc, DocumentResolver>();

/**
 * The live resolver of a document: one Resolver (`LiveResolver`) that is kept
 * up to date with every change, whatever made it (an operation, an editor
 * binding, another replica's update, undo or redo, tidy up, loading), and that
 * tells its subscribers which elements were added, changed or removed. The
 * first call creates it; later calls return the same one, until
 * `detachLiveResolver`.
 *
 * When it is updated: when a batch of transactions has ended. A batch is a
 * transaction together with the transactions its observers start while it
 * ends (such as the recording of work that follows every local change, or what
 * an editor binding writes in reaction). The live resolver then shows the
 * document as that whole batch left it, and its subscribers are called once
 * for the batch, with what the batch changed, and see that state. Until then,
 * inside a transaction and in Yjs observers and 'afterTransaction' listeners,
 * it shows the document as the previous batch left it.
 *
 * Errors: a subscriber that throws does not keep the other subscribers, other
 * listeners of the document, or the code that made the change from going on;
 * its error goes to the live resolver's error handlers (`onError`).
 */
export function liveResolver(doc: Y.Doc): LiveResolver {
  let live = lives.get(doc);
  if (!live) {
    live = new DocumentResolver(doc);
    lives.set(doc, live);
  } else live.catchUp();
  return live;
}

/**
 * Stops keeping the document's live resolver up to date and forgets it. The
 * resolver goes on answering for the state it last took in; a later call of
 * `liveResolver` creates a new one.
 */
export function detachLiveResolver(doc: Y.Doc): void {
  const live = lives.get(doc);
  if (!live) return;
  live.detach();
  lives.delete(doc);
}

/**
 * A Resolver of the document as it is now: the live resolver if the document
 * has one and it shows the current state (it has taken in every transaction,
 * and the transaction open now, if any, has not written yet), otherwise a new
 * Resolver. Inside a transaction the live resolver keeps showing the state from
 * before it until the batch ends, so a resolver taken before the first write
 * of a transaction goes on describing the state from before that transaction;
 * a new Resolver reads the document as it is when asked. Do not keep the
 * result across changes.
 */
export function currentResolver(doc: Y.Doc): Resolver {
  const live = lives.get(doc);
  if (live?.isCurrent()) return live;
  return new Resolver(yLookup(doc));
}
