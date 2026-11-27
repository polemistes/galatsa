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
import { MAX_SHIFTS, Problems, envelopeField, jsonEquals } from "../model/grammar.ts";
import { defaultRandomBytes, newId, type RandomBytes } from "../model/ids.ts";
import {
  Resolver,
  withoutMarks,
  type ElementLookup,
  type Point,
} from "../model/resolve.ts";
import type { Rebase, Shift } from "../model/types.ts";
import { jsonFromY } from "./encode.ts";
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
function isDeleted(
  view: Resolver,
  located: Located,
  ignored: ReadonlySet<string>,
): boolean {
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
  // The writes that finish an undo or redo are part of it; the step itself is
  // judged (below).
  if (tr.origin instanceof SettleOrigin) return;
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
  const noteMark = (located: Located, action: string, removed?: unknown) => {
    const deleted = located.record.get("deleted");
    const mark = deleted instanceof Y.Map ? (deleted.get(action) as unknown) : undefined;
    if (mark instanceof Y.Map) {
      written.set(mark, { located, action });
      ignored.add(markKey(located, action));
      if (located.kind === "elements") ignoredElements.add(`${located.id} ${action}`);
    } else if (wasInEffect(located, removed)) {
      // Taking back a delete that applied is work on the record: a restore.
      work(located);
      if (located.kind === "routes") restoredRoutes.push(located);
    }
  };
  for (const [type, keys] of tr.changed) {
    const located = locate(doc, type as Y.AbstractType<unknown>);
    if (!located) continue;
    const [first, second] = located.path;
    if (first === "rev") continue;
    if (first === "deleted") {
      if (second === undefined) {
        const changes = new Y.YMapEvent(
          type as unknown as Y.Map<unknown>,
          tr,
          keys as Set<string>,
        ).changes.keys;
        for (const [action, change] of changes)
          noteMark(located, action, change.oldValue);
      } else noteMark(located, second);
      continue;
    }
    if (type instanceof Y.Map) {
      // In a map, writing the value that is already there is not work.
      const map = type as Y.Map<unknown>;
      const visits =
        located.kind === "routes" && first === "entries" && second === undefined;
      let changed = false;
      for (const [key, change] of new Y.YMapEvent(map, tr, keys as Set<string>).changes
        .keys) {
        if (first === undefined && (key === "rev" || key === "deleted")) continue;
        const now = map.get(key);
        if (change.action === "update" && sameValue(change.oldValue, now)) continue;
        changed = true;
        // A new visit, or a visit pointed at another stop, is work on the stop.
        if (!visits || change.action === "delete") continue;
        const stop = stopOf(now);
        if (
          stop !== null &&
          (change.action === "add" || stopOf(change.oldValue) !== stop)
        )
          visited.add(stop);
      }
      if (!changed) continue;
    }
    work(located);
  }
  // An undo or redo is finished before its work is judged (section 10).
  if (tr.origin instanceof DocumentUndoManager && tr.origin.currStackItem !== null)
    settleStep(doc, tr, tr.origin, ignoredElements);
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

/** True if two values stored in a shared map are the same plain value. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Y.AbstractType || b instanceof Y.AbstractType) return a === b;
  return jsonEquals(a, b);
}

/**
 * Whether a mark that a transaction took off a record applied to that record
 * until then: it listed the record with the revision it still has. (The mark is
 * deleted, but what it held can still be read while its transaction ends.)
 */
function wasInEffect(located: Located, removed: unknown): boolean {
  if (!(removed instanceof Y.Map)) return false;
  const item = (removed as Y.Map<unknown>)._map.get("seen");
  const seen = item?.content.getContent()[0] as Record<string, unknown> | undefined;
  if (typeof seen !== "object" || seen === null || !Object.hasOwn(seen, located.id)) {
    return false;
  }
  return seen[located.id] === revisionDigest(revisionOf(located.record));
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
 * The origin of the writes that finish an undo or redo (settleStep). The undo
 * manager tracks it, and joins what it writes to the step being undone or
 * redone, so a redo or a later undo takes those writes back with the rest.
 */
class SettleOrigin {
  readonly manager: DocumentUndoManager;

  constructor(manager: DocumentUndoManager) {
    this.manager = manager;
  }
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
function fillHoles(doc: Y.Doc, deletions: unknown, origin: unknown): void {
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
  }, origin);
}

/** Envelope keys that place an element: its container, stacking slot and position. */
const PLACE_KEYS = ["parent", "rebase", "order", "pos"] as const;
type PlaceKey = (typeof PLACE_KEYS)[number];
/** Raw values a transaction replaced: undefined where the key had none. */
type OldPlace = Partial<Record<PlaceKey, unknown>>;

const QUIET = new Problems(0);

type StackItem = DocumentUndoManager["undoStack"][number];

/** A lookup that sees some elements placed as they were before a transaction. */
function placedAsBefore(
  lookup: ElementLookup,
  before: ReadonlyMap<string, OldPlace>,
): ElementLookup {
  return {
    ids: () => lookup.ids(),
    get(id) {
      const element = lookup.get(id);
      const old = before.get(id);
      if (!element || !old) return element;
      const raw = (key: PlaceKey, now: unknown) =>
        Object.hasOwn(old, key) ? jsonFromY(old[key]) : now;
      return {
        type: element.type,
        parent: Object.hasOwn(old, "parent")
          ? envelopeField.parent(jsonFromY(old.parent), QUIET)
          : element.parent,
        order: Object.hasOwn(old, "order")
          ? envelopeField.order(jsonFromY(old.order), QUIET)
          : element.order,
        pos: envelopeField.pos(raw("pos", element.pos), QUIET),
        rebase: envelopeField.rebase(raw("rebase", element.rebase ?? null), QUIET),
        locked: element.locked,
        rev: element.rev ?? {},
        deleted: element.deleted ?? {},
        dissolved: element.dissolved === true,
        purged: element.purged === true,
        size: element.size,
        rot: element.rot,
      };
    },
  };
}

function samePoint(a: Point, b: Point): boolean {
  const close = (u: number, v: number) =>
    Math.abs(u - v) <= 1e-9 * Math.max(1, Math.abs(u), Math.abs(v));
  return close(a.x, b.x) && close(a.y, b.y);
}

/**
 * Finishes an undo or redo transaction before the tracker judges its work
 * (section 10). What it writes joins the step, so a redo, or a later undo,
 * takes it back together with the rest.
 *
 * 1. Holes are filled (see fillHoles). Judging first would see an element whose
 *    parent has no value at the root, outside a delete that hides it, and its
 *    new revision would bring it back for good.
 * 2. A change of container that would take an element (or something in it) out
 *    of a delete that hides it is kept back: the element keeps the place it had
 *    before the undo. An undo or redo made after receiving a delete leaves what
 *    the delete hides deleted, as an undo of a move of the element itself does.
 *    And the other way: a change of container that would put a visible
 *    element (or something in it) under another user's delete is kept back,
 *    so an undo does not hide what the user sees by somebody else's delete
 *    (docs/adr/0014: undoing a frame put around elements whose container was
 *    deleted meanwhile).
 * 3. A change of container that would move something visible on the canvas,
 *    although the step writes no position that its place depends on, is done,
 *    but with a rebase that keeps the element where it was on the canvas. An
 *    undo takes back the user's own change of container, which never moves
 *    anything; it must not take back, in effect, a move another user made since
 *    (undoing a grouping after someone moved the group leaves the members where
 *    that move put them, as an ungrouping would).
 */
function settleStep(
  doc: Y.Doc,
  tr: Y.Transaction,
  manager: DocumentUndoManager,
  ignoredElements: ReadonlySet<string>,
): void {
  const origin = manager.settleOrigin;
  fillHoles(doc, manager.currStackItem!.deletions, origin);
  const elements = roots(doc).elements;
  const before = new Map<string, OldPlace>();
  for (const [type, keys] of tr.changed) {
    const item = type._item;
    if (!(type instanceof Y.Map) || item === null || item.parent !== elements) continue;
    if (item.parentSub === null) continue;
    const changes = new Y.YMapEvent(type as Y.Map<unknown>, tr, keys as Set<string>)
      .changes.keys;
    const old: OldPlace = {};
    for (const key of PLACE_KEYS) {
      const change = changes.get(key);
      if (change) old[key] = change.action === "add" ? undefined : change.oldValue;
    }
    if (Object.keys(old).length > 0) before.set(item.parentSub, old);
  }
  const moved = new Set(
    [...before]
      .filter(([, old]) => Object.hasOwn(old, "parent") || Object.hasOwn(old, "rebase"))
      .map(([id]) => id),
  );
  if (moved.size === 0) return;
  const lookup = withoutMarks(yLookup(doc), ignoredElements);
  const then = new Resolver(placedAsBefore(lookup, before));
  const ids = [...then.ids()];
  const writesPos = (id: string) => Object.hasOwn(before.get(id) ?? {}, "pos");

  // 2. Nothing comes out of a delete. Only what changed its effective parent
  // (the moved elements, and what a cycle made or broke moves with them), and
  // what is inside it, can.
  let now = new Resolver(lookup);
  const candidates = new Set<string>();
  for (const id of ids) {
    if (now.get(id) === undefined || then.parentOf(id) === now.parentOf(id)) continue;
    candidates.add(id);
    for (const inside of then.descendants(id)) candidates.add(inside);
  }
  const revived = [...candidates].filter(
    (at) => then.isDeleted(at) && now.get(at) !== undefined && !now.isDeleted(at),
  );
  if (revived.length > 0) {
    const keep = blame(revived, moved, (at) => [at, ...ancestorsOf(then, at)]);
    doc.transact(() => {
      for (const id of keep) {
        moved.delete(id);
        const map = elements.get(id) as Y.Map<unknown>;
        const old = before.get(id)!;
        for (const key of PLACE_KEYS) {
          if (!Object.hasOwn(old, key)) continue;
          const value = old[key];
          if (value === undefined) map.delete(key);
          else map.set(key, value);
        }
      }
    }, origin);
    now = new Resolver(lookup);
  }

  // 2b. Nothing visible goes into a delete: a change of container that would
  // put an element (or something in it) under another user's delete that
  // hides it is kept back too. Undoing a grouping or a frame put around
  // elements, after another user deleted the container they were in (and
  // they survived in the group or frame, which was worked on), would
  // otherwise hide them for good: the undo's work on them is not recorded,
  // since they are hidden when it is judged. The user's own removals written
  // by this undo (the frame's creation taken back) are not counted
  // (`withoutMarks`): what that hides goes by the user's own undo.
  const hidden = [...candidates].filter(
    (at) =>
      now.get(at) !== undefined &&
      then.get(at) !== undefined &&
      !then.isDeleted(at) &&
      now.isDeleted(at),
  );
  if (hidden.length > 0) {
    const keep = blame(hidden, moved, (at) => [at, ...ancestorsOf(now, at)]);
    doc.transact(() => {
      for (const id of keep) {
        moved.delete(id);
        const map = elements.get(id) as Y.Map<unknown>;
        const old = before.get(id)!;
        for (const key of PLACE_KEYS) {
          if (!Object.hasOwn(old, key)) continue;
          const value = old[key];
          if (value === undefined) map.delete(key);
          else map.set(key, value);
        }
      }
    }, origin);
    now = new Resolver(lookup);
  }

  // 3. Nothing visible moves on the canvas unless the step writes the position
  // of something its place depends on.
  const still = new Set([...moved].filter((id) => !writesPos(id)));
  if (still.size === 0) return;
  const depends = (at: string) => [...placedBy(then, at), ...placedBy(now, at)];
  const shifted = ids.filter(
    (id) =>
      now.get(id) !== undefined &&
      !samePoint(then.worldOrigin(id), now.worldOrigin(id)) &&
      !now.isGone(id) &&
      !depends(id).some(writesPos),
  );
  if (shifted.length === 0) return;
  // A rebase for each moved element the shift depends on. One that did not move
  // itself gets one too: its position may be what others are converted from.
  const rebases = [...blame(shifted, still, depends)]
    .filter((id) => now.get(id) !== undefined)
    .map((id) => [id, placeKeeping(then, now, id)] as const);
  doc.transact(() => {
    for (const [id, rebase] of rebases)
      (elements.get(id) as Y.Map<unknown>).set("rebase", rebase);
  }, origin);
}

/**
 * A rebase that puts an element, in the container it is in now, where it was on
 * the canvas before (`then`), without writing its position (section 5.3). Like
 * a reparent's, it shifts the stored position, and covers a move another user
 * writes in the container they saw the element in before.
 */
function placeKeeping(then: Resolver, now: Resolver, id: string): Rebase {
  const envelope = now.get(id)!;
  const parent = now.parentOf(id);
  const world = then.worldOrigin(id);
  const origin = now.spaceOrigin(parent);
  const target = { x: world.x - origin.x, y: world.y - origin.y };
  const pos = envelope.pos;
  const shifts: Shift[] = [];
  const add = (from: string | null, dx: number, dy: number) => {
    if (from === parent || shifts.some((s) => s.from === from)) return;
    if (shifts.length < MAX_SHIFTS) shifts.push({ from, dx, dy });
  };
  add(pos.space, target.x - pos.x, target.y - pos.y);
  const before = then.parentOf(id);
  const was = then.spaceOrigin(before);
  add(before, was.x - origin.x, was.y - origin.y);
  const restored = envelope.rebase;
  if (restored && restored.to === parent)
    for (const s of restored.shifts) add(s.from, s.dx, s.dy);
  return {
    to: parent,
    base:
      pos.space === parent
        ? { x: pos.x, y: pos.y, dx: target.x - pos.x, dy: target.y - pos.y }
        : null,
    shifts,
  };
}

/** The ancestors of an element in the effective tree, nearest first. */
function ancestorsOf(r: Resolver, id: string): string[] {
  const out: string[] = [];
  for (let at = r.parentOf(id); at !== null; at = r.parentOf(at)) out.push(at);
  return out;
}

/**
 * The elements whose positions an element's place on the canvas depends on: it,
 * the containers it is in, and the containers its position is written in (rule
 * 3 of section 5.3 converts from there), and so on up.
 */
function placedBy(r: Resolver, id: string): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (out.has(at) || r.get(at) === undefined) continue;
    out.add(at);
    const parent = r.parentOf(at);
    if (parent !== null) queue.push(parent);
    const space = r.get(at)!.pos.space;
    if (space !== null) queue.push(space);
  }
  return [...out];
}

/**
 * The suspects to blame for what was found: those in the chain of each finding,
 * or all of them if a finding has none in its chain.
 */
function blame(
  found: readonly string[],
  suspects: ReadonlySet<string>,
  chain: (id: string) => readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const id of found) {
    const guilty = chain(id).filter((at) => suspects.has(at));
    if (guilty.length === 0) return new Set(suspects);
    for (const at of guilty) out.add(at);
  }
  return out;
}

/**
 * The undo manager of a Galatsa document (section 10). It undoes transactions
 * of the local user (ORIGIN.local and the origins given, for example an editor
 * binding), never remote changes, loading, record creation, tidy up or the
 * recording of work.
 */
export class DocumentUndoManager extends Y.UndoManager {
  /** The origin of the writes that finish this manager's undos and redos. */
  readonly settleOrigin: SettleOrigin = new SettleOrigin(this);

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
        if (!(struct instanceof Y.Item) || !struct.deleted || struct.redone !== null)
          return;
        if (struct.parentSub === null) return;
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
  const settle = manager.settleOrigin;
  manager.trackedOrigins.add(settle);
  // What finishes an undo or redo joins its step (on the other stack): Yjs
  // makes a stack item of its own for every tracked transaction while undoing.
  manager.on(
    "stack-item-added",
    (event: { stackItem: StackItem; origin: unknown; type: "undo" | "redo" }) => {
      if (event.origin !== settle) return;
      const stack = event.type === "redo" ? manager.redoStack : manager.undoStack;
      const item = stack[stack.length - 1];
      const step = stack[stack.length - 2];
      if (item !== event.stackItem || step === undefined) return;
      step.insertions = Y.mergeDeleteSets([step.insertions, item.insertions]);
      step.deletions = Y.mergeDeleteSets([step.deletions, item.deletions]);
      stack.pop();
    },
  );
  manager.on("stack-item-popped", (event: { stackItem: StackItem }) =>
    fillHoles(doc, event.stackItem.deletions, settle),
  );
  return manager;
}
