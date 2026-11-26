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
//    thing, such as undoing an old edit, does not bring it back); and
// 2. rewrites every delete mark the transaction wrote, so that it lists what
//    the user sees now. This matters when undo or redo puts an old mark back.
//
// A revision is one counter per writer. A writer's counter is the length of a
// shared array that only it shortens; shortening creates no new CRDT items, so
// typing still merges into runs as usual.

import * as Y from "yjs";
import { jsonEquals } from "../model/grammar.ts";
import { defaultRandomBytes, newId, type RandomBytes } from "../model/ids.ts";
import { Resolver, withoutMarks } from "../model/resolve.ts";
import { isRemoved } from "../model/route.ts";
import { INTERNAL_ORIGINS, ORIGIN, roots } from "./schema.ts";
import { marksOf, revisionOf, yLookup } from "./snapshot.ts";

/** Units of work a writer's counter lasts before it is replaced by a new one. */
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

/** Finds the record a changed shared type belongs to. */
function locate(doc: Y.Doc, type: Y.AbstractType<unknown>): Located | null {
  const r = roots(doc);
  const path: string[] = [];
  let at = type;
  for (;;) {
    const item = at._item;
    if (item === null) return null;
    const parent = item.parent as Y.AbstractType<unknown>;
    const kind: RecordKind | null =
      parent === r.elements
        ? "elements"
        : parent === r.stops
          ? "stops"
          : parent === r.routes
            ? "routes"
            : null;
    if (kind !== null) {
      if (item.deleted || item.parentSub === null || !(at instanceof Y.Map)) return null;
      return { kind, id: item.parentSub, record: at as RecordMap, path: path.reverse() };
    }
    path.push(item.parentSub ?? "");
    at = parent;
  }
}

function isDeletedNow(view: Resolver, located: Located): boolean {
  if (located.kind === "elements") return view.isDeleted(located.id);
  return isRemoved(located.id, {
    rev: revisionOf(located.record),
    deleted: marksOf(located.record),
  });
}

/** Changes this writer's entry in the record's revision. */
function bump(tracker: Tracker, record: RecordMap): void {
  let rev = record.get("rev");
  if (!(rev instanceof Y.Map)) {
    rev = new Y.Map<unknown>();
    record.set("rev", rev);
  }
  const map = rev as Y.Map<unknown>;
  const prefix = `${tracker.session}.`;
  let fresh = true;
  for (const [key, pool] of [...map.entries()]) {
    if (!key.startsWith(prefix)) continue;
    if (fresh && pool instanceof Y.Array && pool.length > 1) {
      pool.delete(0, 1);
      fresh = false;
    } else map.delete(key);
  }
  if (fresh) {
    const pool = new Y.Array<boolean>();
    map.set(prefix + (tracker.seq++).toString(36), pool);
    pool.push(new Array<boolean>(POOL).fill(true));
  }
}

function afterTransaction(doc: Y.Doc, tracker: Tracker, tr: Y.Transaction): void {
  if (!tr.local || INTERNAL_ORIGINS.has(tr.origin)) return;
  const worked = new Map<RecordMap, { located: Located; force: boolean }>();
  const marks = new Map<Y.Map<unknown>, { located: Located; action: string }>();
  const noteMark = (located: Located, action: string) => {
    const deleted = located.record.get("deleted");
    const mark = deleted instanceof Y.Map ? (deleted.get(action) as unknown) : undefined;
    if (mark instanceof Y.Map) marks.set(mark, { located, action });
  };
  for (const [type, keys] of tr.changed) {
    const located = locate(doc, type as Y.AbstractType<unknown>);
    if (!located) continue;
    const [first, second] = located.path;
    if (first === undefined) {
      // The record map itself: every key except the bookkeeping is work.
      let work = false;
      for (const key of keys) if (key !== "rev" && key !== "deleted") work = true;
      if (work && !worked.has(located.record))
        worked.set(located.record, { located, force: false });
    } else if (first === "rev") continue;
    else if (first === "deleted") {
      if (second === undefined) {
        for (const action of keys) if (action !== null) noteMark(located, action);
      } else noteMark(located, second);
    } else if (!worked.has(located.record)) {
      worked.set(located.record, { located, force: false });
    }
  }
  const r = roots(doc);
  for (const [record, force] of tracker.noted) {
    const item = record._item;
    if (!item || item.deleted || item.parentSub === null) continue;
    const parent = item.parent as Y.AbstractType<unknown>;
    const kind: RecordKind | null =
      parent === r.elements
        ? "elements"
        : parent === r.stops
          ? "stops"
          : parent === r.routes
            ? "routes"
            : null;
    if (kind === null) continue;
    const located: Located = { kind, id: item.parentSub, record, path: [] };
    worked.set(record, { located, force: force || worked.get(record)?.force === true });
  }
  tracker.noted.clear();
  if (worked.size === 0 && marks.size === 0) return;

  const view = new Resolver(yLookup(doc));
  const toBump = [...worked.values()].filter(
    ({ located, force }) => force || !isDeletedNow(view, located),
  );
  if (toBump.length === 0 && marks.size === 0) return;
  doc.transact(() => {
    for (const { located } of toBump) bump(tracker, located.record);
    if (marks.size === 0) return;
    // Each mark is refreshed to what its user sees now, the marks being
    // refreshed aside.
    const ignored = new Set<string>();
    for (const { located, action } of marks.values()) {
      if (located.kind === "elements") ignored.add(`${located.id} ${action}`);
    }
    const fresh = new Resolver(withoutMarks(yLookup(doc), ignored));
    for (const [mark, { located }] of marks) {
      const seen =
        located.kind === "elements"
          ? fresh.coverage(located.id)
          : { [located.id]: revisionOf(located.record) };
      if (!jsonEquals(mark.get("seen"), seen)) mark.set("seen", seen);
    }
  }, ORIGIN.track);
}

/**
 * Starts recording work on a document. Every Y.Doc that a user edits must have
 * this; the reference operations, `fromSnapshot`, `forkDoc`, the undo manager
 * and the file reader all call it. Calling it again does nothing.
 */
export function trackWork(doc: Y.Doc, randomBytes: RandomBytes = defaultRandomBytes): void {
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
 * transaction does not change it (adding a visit to a stop is work on the stop).
 * With `evenIfDeleted`, the work counts although the record is deleted as the
 * user sees it, which brings it back.
 */
export function noteWork(doc: Y.Doc, record: Y.Map<unknown>, evenIfDeleted = false): void {
  trackWork(doc);
  const tracker = trackers.get(doc)!;
  tracker.noted.set(record, evenIfDeleted || tracker.noted.get(record) === true);
}

/**
 * The undo manager configuration that keeps the guarantees of section 10: it
 * undoes transactions of the local user (ORIGIN.local and the origins given, for
 * example an editor binding), never remote changes, loading, record creation,
 * tidy up or the recording of work.
 */
export function createUndoManager(
  doc: Y.Doc,
  options: { captureTimeout?: number; origins?: Iterable<unknown> } = {},
): Y.UndoManager {
  trackWork(doc);
  const r = roots(doc);
  return new Y.UndoManager([r.elements, r.stops, r.routes, r.settings, r.meta], {
    trackedOrigins: new Set<unknown>([ORIGIN.local, ...(options.origins ?? [])]),
    captureTimeout: options.captureTimeout ?? 500,
  });
}
