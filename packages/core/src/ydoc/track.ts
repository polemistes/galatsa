// SPDX-License-Identifier: GPL-3.0-or-later

// Recording work (section 5.5 of
// docs/adr/0001-document-model-and-file-format.md).
//
// A delete hides only what the deleting user saw. For that, every record has a
// revision that changes with every unit of work on it, and a delete lists the
// revisions it saw. This module keeps both up to date without any help from the
// code that makes the changes: after every local transaction (an operation, an
// editor binding typing into a shared text, an undo or redo), it looks at what
// the transaction changed and, in a follow-up transaction that undo never
// touches,
//
// 1. changes the revision of every record that was worked on, unless the record
//    is deleted as the local user sees it (work done knowingly on a deleted
//    thing, such as undoing an old edit, does not bring it back);
// 2. removes, from each record whose revision it changed, the delete marks that
//    did not apply: they never can again; and
// 3. rewrites every delete mark the transaction wrote, so that it lists what
//    the user sees now. This matters when undo or redo puts an old mark back.
//
// Work is: a change of a record's content; taking a delete mark off a record
// (restoring it); and, for a stop, a new visit to it in a route, however the
// visit comes about (an operation, an undo or redo, a pasted or restored route).
//
// A revision is one counter per writer. A writer's counter is the length of a
// shared array that only it shortens; shortening creates no new CRDT items, so
// typing still merges into runs as usual.

import * as Y from "yjs";
import { revisionDigest } from "../model/digest.ts";
import { jsonEquals } from "../model/grammar.ts";
import { defaultRandomBytes, newId, type RandomBytes } from "../model/ids.ts";
import { Resolver, withoutMarks } from "../model/resolve.ts";
import { INTERNAL_ORIGINS, ORIGIN, roots } from "./schema.ts";
import { marksOf, revisionOf, yLookup } from "./snapshot.ts";

/**
 * Units of work a writer's counter lasts before it is replaced by a new one: few
 * for the first counter in a record (most records a session touches, it touches
 * once or twice), more once the session keeps working on the record.
 */
const FIRST_POOL = 8;
const POOL = 64;

type RecordMap = Y.Map<unknown>;
type RecordKind = "elements" | "stops" | "routes";

interface Tracker {
  /** This replica's writer key prefix: unique per Y.Doc instance. */
  readonly session: string;
  seq: number;
  /** Records an operation declared as worked on (value: even if deleted). */
  readonly noted: Map<RecordMap, boolean>;
}

const trackers = new WeakMap<Y.Doc, Tracker>();

interface Located {
  kind: RecordKind;
  id: string;
  record: RecordMap;
  /** Keys from the record down to the changed type; empty if it is the record. */
  path: string[];
}

function kindOf(doc: Y.Doc, parent: unknown): RecordKind | null {
  const r = roots(doc);
  if (parent === r.elements) return "elements";
  if (parent === r.stops) return "stops";
  return parent === r.routes ? "routes" : null;
}

/** Finds the record a changed shared type belongs to. */
function locate(doc: Y.Doc, type: Y.AbstractType<unknown>): Located | null {
  const path: string[] = [];
  let at = type;
  for (;;) {
    const item = at._item;
    if (item === null) return null;
    const parent = item.parent as Y.AbstractType<unknown>;
    const kind = kindOf(doc, parent);
    if (kind !== null) {
      if (item.deleted || item.parentSub === null || !(at instanceof Y.Map)) return null;
      return { kind, id: item.parentSub, record: at as RecordMap, path: path.reverse() };
    }
    path.push(item.parentSub ?? "");
    at = parent;
  }
}

/** Locates a record map itself. */
function locateRecord(doc: Y.Doc, record: RecordMap): Located | null {
  const item = record._item;
  if (!item || item.deleted || item.parentSub === null) return null;
  const kind = kindOf(doc, item.parent);
  return kind === null ? null : { kind, id: item.parentSub, record, path: [] };
}

/**
 * Whether a record is hidden by a delete, the marks in `ignored` aside (those
 * the transaction at hand wrote itself).
 */
function isDeleted(view: Resolver, located: Located, ignored: ReadonlySet<string>): boolean {
  if (located.kind === "elements") return view.isDeleted(located.id);
  const marks = marksOf(located.record);
  let digest: string | undefined;
  for (const action of Object.keys(marks)) {
    if (ignored.has(markKey(located, action))) continue;
    const seen = marks[action]!.seen;
    if (!Object.hasOwn(seen, located.id)) continue;
    digest ??= revisionDigest(revisionOf(located.record));
    if (seen[located.id] === digest) return true;
  }
  return false;
}

/**
 * Changes this writer's entry in the record's revision. The entry is a counter
 * that only goes down, under a key that is never used twice, so a revision never
 * repeats.
 */
function bump(tracker: Tracker, record: RecordMap): void {
  let rev = record.get("rev");
  if (!(rev instanceof Y.Map)) {
    rev = new Y.Map<unknown>();
    record.set("rev", rev);
  }
  const map = rev as Y.Map<unknown>;
  const prefix = `${tracker.session}.`;
  let done = false;
  let returning = false;
  for (const [key, pool] of [...map.entries()]) {
    if (!key.startsWith(prefix)) continue;
    returning = true;
    if (!done && pool instanceof Y.Array && pool.length > 1) {
      pool.delete(0, 1);
      done = true;
    } else map.delete(key);
  }
  if (!done) {
    const pool = new Y.Array<boolean>();
    map.set(prefix + (tracker.seq++).toString(36), pool);
    pool.push(new Array<boolean>(returning ? POOL : FIRST_POOL).fill(true));
  }
}

interface Work {
  located: Located;
  force: boolean;
}

function markKey(located: Located, action: string): string {
  return `${located.kind} ${located.id} ${action}`;
}

function afterTransaction(doc: Y.Doc, tracker: Tracker, tr: Y.Transaction): void {
  if (!tr.local || INTERNAL_ORIGINS.has(tr.origin)) return;
  const worked = new Map<RecordMap, Work>();
  const work = (located: Located | null, force = false) => {
    if (!located) return;
    const known = worked.get(located.record);
    if (known) known.force ||= force;
    else worked.set(located.record, { located, force });
  };
  /** Marks this transaction wrote: they are not what hides a record from it. */
  const written = new Map<Y.Map<unknown>, { located: Located; action: string }>();
  const ignored = new Set<string>();
  /** The same, for elements, in the form the resolver takes. */
  const ignoredElements = new Set<string>();
  /** Routes that this transaction took a mark off, or whose visits it changed. */
  const restoredRoutes: Located[] = [];
  const visited = new Set<string>();
  const noteMark = (located: Located, action: string) => {
    const deleted = located.record.get("deleted");
    const mark = deleted instanceof Y.Map ? (deleted.get(action) as unknown) : undefined;
    if (mark instanceof Y.Map) {
      written.set(mark, { located, action });
      ignored.add(markKey(located, action));
      if (located.kind === "elements") ignoredElements.add(`${located.id} ${action}`);
    } else {
      // The mark is gone: taking a delete back is work on the record.
      work(located);
      if (located.kind === "routes") restoredRoutes.push(located);
    }
  };
  for (const [type, keys] of tr.changed) {
    const located = locate(doc, type as Y.AbstractType<unknown>);
    if (!located) continue;
    const [first, second] = located.path;
    if (first === undefined) {
      // The record map itself: every key except the bookkeeping is work.
      for (const key of keys) if (key !== "rev" && key !== "deleted") work(located);
    } else if (first === "rev") continue;
    else if (first === "deleted") {
      if (second === undefined) {
        for (const action of keys) if (action !== null) noteMark(located, action);
      } else noteMark(located, second);
    } else {
      work(located);
      if (located.kind === "routes" && first === "entries" && second === undefined) {
        // A new visit, or a visit pointed at another stop, is work on the stop.
        const entries = type as unknown as Y.Map<unknown>;
        const changes = new Y.YMapEvent(entries, tr, keys as Set<string>).changes.keys;
        for (const [entry, change] of changes) {
          if (change.action === "delete") continue;
          const stop = stopOf(entries.get(entry));
          if (stop !== null && (change.action === "add" || stopOf(change.oldValue) !== stop))
            visited.add(stop);
        }
      }
    }
  }
  for (const [record, force] of tracker.noted) work(locateRecord(doc, record), force);
  tracker.noted.clear();
  if (worked.size === 0 && written.size === 0) return;

  const view = new Resolver(withoutMarks(yLookup(doc), ignoredElements));
  // A route that came back brings its visits back.
  for (const route of restoredRoutes) {
    if (isDeleted(view, route, ignored)) continue;
    const entries = route.record.get("entries");
    if (!(entries instanceof Y.Map)) continue;
    for (const entry of (entries as Y.Map<unknown>).values()) {
      const stop = stopOf(entry);
      if (stop !== null) visited.add(stop);
    }
  }
  for (const stop of visited) {
    const record = roots(doc).stops.get(stop) as unknown;
    if (record instanceof Y.Map) work(locateRecord(doc, record as RecordMap));
  }
  const toBump = [...worked.values()].filter(
    ({ located, force }) => force || !isDeleted(view, located, ignored),
  );
  if (toBump.length === 0 && written.size === 0) return;
  doc.transact(() => {
    for (const { located } of toBump) {
      bump(tracker, located.record);
      // No other mark on this record applied, and after this work none ever can.
      const marks = located.record.get("deleted");
      if (!(marks instanceof Y.Map)) continue;
      for (const action of [...(marks as Y.Map<unknown>).keys()]) {
        if (!ignored.has(markKey(located, action))) marks.delete(action);
      }
    }
    if (written.size === 0) return;
    // Each mark written is refreshed to what its user sees now.
    const fresh = new Resolver(withoutMarks(yLookup(doc), ignoredElements));
    for (const [mark, { located }] of written) {
      const seen =
        located.kind === "elements"
          ? fresh.coverage(located.id)
          : { [located.id]: revisionDigest(revisionOf(located.record)) };
      if (!jsonEquals(mark.get("seen"), seen)) mark.set("seen", seen);
    }
  }, ORIGIN.track);
}

/** The stop a route entry visits, or null if the value is not an entry. */
function stopOf(entry: unknown): string | null {
  const stop = (entry as { stop?: unknown } | null | undefined)?.stop;
  return typeof stop === "string" ? stop : null;
}

/**
 * Starts recording work on a document. Every Y.Doc that a user edits must have
 * this before the first edit. The reference operations, `fromSnapshot`,
 * `forkDoc`, the undo manager and the file reader call it; code that gets a
 * Y.Doc in another way (from a sync provider, for example) calls it itself.
 * Calling it again does nothing.
 */
export function trackWork(
  doc: Y.Doc,
  randomBytes: RandomBytes = defaultRandomBytes,
): void {
  if (trackers.has(doc)) return;
  // 66 random bits: unique among the writers of one record.
  const tracker: Tracker = {
    session: newId(randomBytes).slice(0, 11),
    seq: 0,
    noted: new Map(),
  };
  trackers.set(doc, tracker);
  doc.on("afterTransaction", (tr: Y.Transaction) => afterTransaction(doc, tracker, tr));
}

/**
 * Declares, inside a local transaction, that a record was worked on although the
 * transaction does not change it. With `evenIfDeleted`, the work counts although
 * the record is deleted as the user sees it, which brings it back (and what is
 * inside it).
 */
export function noteWork(
  doc: Y.Doc,
  record: Y.Map<unknown>,
  evenIfDeleted = false,
): void {
  trackWork(doc);
  const tracker = trackers.get(doc)!;
  tracker.noted.set(record, evenIfDeleted || tracker.noted.get(record) === true);
}

/**
 * Finishes an undo or redo step that Yjs left half done. When the step has to
 * bring back a map entry (the value a key had before the change being undone),
 * Yjs refuses if a concurrent change by someone else to the same key is on
 * record, even when that change lost and is long gone. The key is then left with
 * no value at all: a position or a parent would silently read as its default.
 * This puts the value back, but only where the key has no value, so nothing
 * anyone wrote is overwritten.
 */
function fillHoles(doc: Y.Doc, deletions: unknown): void {
  doc.transact((tr) => {
    Y.iterateDeletedStructs(
      tr,
      deletions as Parameters<typeof Y.iterateDeletedStructs>[1],
      (struct) => {
        if (!(struct instanceof Y.Item) || struct.parentSub === null) return;
        const parent = struct.parent;
        if (!(parent instanceof Y.Map) || parent.has(struct.parentSub)) return;
        if (parent._item !== null && parent._item.deleted) return;
        // A shared type cannot be brought back this way; plain values can.
        if (struct.content instanceof Y.ContentType) return;
        const values = struct.content.getContent() as unknown[];
        if (values.length === 1)
          (parent as Y.Map<unknown>).set(struct.parentSub, values[0]);
      },
    );
  }, ORIGIN.track);
}

/**
 * The undo manager of a Galatsa document (section 10). It undoes transactions
 * of the local user (ORIGIN.local and the origins given, for example an editor
 * binding), never remote changes, loading, record creation, tidy up or the
 * recording of work.
 */
export class DocumentUndoManager extends Y.UndoManager {
  /**
   * Runs several operations as one undo step, whatever the capture timeout. This
   * is how a command composes operations. (Wrapping them in one Yjs transaction
   * is not: records must be created in transactions of their own, and the
   * operations refuse to create inside another transaction.)
   */
  group<T>(fn: () => T): T {
    const timeout = this.captureTimeout;
    this.stopCapturing();
    this.captureTimeout = Number.POSITIVE_INFINITY;
    try {
      return fn();
    } finally {
      this.captureTimeout = timeout;
      this.stopCapturing();
    }
  }

  override undo(): ReturnType<Y.UndoManager["undo"]> {
    this.#adoptMarks();
    return super.undo();
  }

  /**
   * Undoing a delete takes the user's mark off. If another user restored the
   * element and undid that, the mark is there again, but as a new entry under
   * the same action id, which Yjs does not connect with the one this manager
   * wrote: the undo would do nothing. This connects them, the way Yjs itself
   * does on the replica that put the mark back.
   */
  #adoptMarks(): void {
    const step = this.undoStack[this.undoStack.length - 1];
    if (!step) return;
    this.doc.transact((tr) => {
      Y.iterateDeletedStructs(tr, step.insertions, (struct) => {
        if (!(struct instanceof Y.Item) || !struct.deleted || struct.redone !== null) return;
        if (struct.parentSub === null || !(struct.content instanceof Y.ContentType)) return;
        const parent = struct.parent;
        if (!(parent instanceof Y.Map) || parent._item?.parentSub !== "deleted") return;
        const current = parent._map.get(struct.parentSub);
        if (current && !current.deleted && current !== struct) struct.redone = current.id;
      });
    }, ORIGIN.track);
  }
}

/**
 * Creates the undo manager of a document, with the guarantees of section 10; in
 * particular, an undo never leaves a key without a value (see fillHoles).
 */
export function createUndoManager(
  doc: Y.Doc,
  options: { captureTimeout?: number; origins?: Iterable<unknown> } = {},
): DocumentUndoManager {
  trackWork(doc);
  const r = roots(doc);
  const manager = new DocumentUndoManager(
    [r.elements, r.stops, r.routes, r.settings, r.meta],
    {
      trackedOrigins: new Set<unknown>([ORIGIN.local, ...(options.origins ?? [])]),
      captureTimeout: options.captureTimeout ?? 500,
    },
  );
  manager.on("stack-item-popped", (event: { stackItem: { deletions: unknown } }) =>
    fillHoles(doc, event.stackItem.deletions),
  );
  return manager;
}
