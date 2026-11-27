// SPDX-License-Identifier: GPL-3.0-or-later

// Undo with two users. Two replicas run random commands (the basic commands,
// insertions, undo and redo) and sync at random moments; at the end each user
// undoes everything, syncing after every step. Every undo and redo is checked
// against what "each user undoes only their own changes, the undo is done, and
// none of the other user's changes is lost" means under the rules of
// docs/adr/0001, sections 5 and 10:
//
// 1. Values and places. No value the other user wrote that is current when the
//    undo starts is replaced or removed by it: envelope keys (position, size,
//    rotation, stacking key, container, rebase, lock, name, dissolved flag,
//    layout version), data and ext keys, and what is inside shared types there.
//    And nothing moves on the canvas except by positions the undo writes: put
//    back every position the undo changed, and every element is where it was
//    before. So an undo never takes back, in effect, a move the other user made
//    (moving a group, or the frame an element was put in).
// 2. Deletes. Nothing the other user's delete hides comes back.
// 3. What disappears. An element that the user saw and that is gone after the
//    undo is gone through a delete mark or a dissolve of this user's own: the
//    undo of their own creation, grouping or ungrouping, or a redo of their own
//    delete. Such a removal hides only what the user saw, keeps what the other
//    user did without knowing of it, and can be taken back (section 5.5); it is
//    not a loss.
// 4. The undo is done. Every value the step wrote that is still there when the
//    undo starts is taken back: afterwards the key holds the value from before
//    the step, or at least no longer the step's value (a container change done
//    with a rebase that keeps the place). Only a change that would bring back
//    something the other user deleted is held back (rule 2).
//
// And after every sync the two replicas hold the same document.
//
// CONCURRENT_SEEDS ("1-40" or "1,5,9") and CONCURRENT_STEPS change the run.

import {
  Resolver,
  lookupFromRecord,
  type DocumentSnapshot,
  type ElementId,
  type Point,
} from "@galatsa/core";
import { seededRandom } from "@galatsa/core/testing";
import { forkDoc, roots, syncDocs, toSnapshot } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASICS } from "./index.ts";
import {
  envList,
  envNumber,
  randomCommands,
  runRandom,
  setupBasics,
  withSeed,
  type BasicsSetup,
  type RandomMemory,
} from "./testing.ts";

/** A Yjs delete set, as stack items hold them. */
type DeleteSet = Parameters<typeof Y.isDeleted>[0];

const STEPS = envNumber("CONCURRENT_STEPS", 400);
// Seeds 1 to 40 with 600 steps passed when this was written; these run by default.
const SEEDS = envList("CONCURRENT_SEEDS", [1, 2, 3, 4]);

/** The map entry that holds a key's current value (Yjs keeps one per key). */
function entry(map: Y.Map<unknown>, key: string) {
  return map._map.get(key);
}

interface Written {
  readonly label: string;
  /** True while the value is still there, unchanged. */
  readonly kept: () => boolean;
}

/**
 * Current values in a shared type that `client` wrote: map entries, and items of
 * texts, arrays and XML, with what is inside them. `skip` leaves out top-level
 * keys (the work tracker's).
 */
function collect(
  type: Y.AbstractType<unknown>,
  label: string,
  client: number,
  out: Written[],
  skip: ReadonlySet<string> = new Set(),
): void {
  for (const [key, item] of type._map) {
    if (item.deleted || skip.has(key)) continue;
    if (item.id.client === client) {
      const map = type as Y.Map<unknown>;
      out.push({
        label: `${label}.${key}`,
        kept: () => entry(map, key) === item && !item.deleted,
      });
    }
    if (item.content instanceof Y.ContentType)
      collect(item.content.type, `${label}.${key}`, client, out);
  }
  for (let item = type._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    if (item.id.client === client) {
      const it = item;
      out.push({ label: `${label}[]`, kept: () => !it.deleted });
    }
    if (item.content instanceof Y.ContentType)
      collect(item.content.type, `${label}[]`, client, out);
  }
}

const TRACKER_KEYS = new Set(["rev", "deleted"]);

function records(doc: Y.Doc): Array<[ElementId, Y.Map<unknown>]> {
  return [...roots(doc).elements.entries()].filter(
    (e): e is [ElementId, Y.Map<unknown>] => e[1] instanceof Y.Map,
  );
}

function writtenBy(doc: Y.Doc, client: number): Written[] {
  const out: Written[] = [];
  for (const [id, record] of records(doc))
    collect(record as unknown as Y.AbstractType<unknown>, id, client, out, TRACKER_KEYS);
  return out;
}

interface StepValue {
  readonly label: string;
  readonly id: ElementId;
  readonly map: Y.Map<unknown>;
  readonly key: string;
  /** What the step wrote. */
  readonly value: string;
  /** What the key held before the step, if the step replaced a value. */
  readonly old: string | undefined;
}

const json = (item: { content: { getContent(): unknown[] } }): string =>
  JSON.stringify(item.content.getContent()[0] ?? null);

/**
 * The plain values in element records and their data that a step (a Yjs stack
 * item) wrote and that are still current, with what they replaced.
 */
function stepValues(
  doc: Y.Doc,
  step: { insertions: DeleteSet; deletions: DeleteSet },
): StepValue[] {
  const out: StepValue[] = [];
  const look = (id: ElementId, map: Y.Map<unknown>, prefix: string) => {
    for (const [key, item] of map._map) {
      if (item.deleted || TRACKER_KEYS.has(key) || item.content instanceof Y.ContentType)
        continue;
      if (!Y.isDeleted(step.insertions, item.id)) continue;
      let old: string | undefined;
      for (let left = item.left; left !== null; left = left.left)
        if (
          Y.isDeleted(step.deletions, left.id) &&
          !Y.isDeleted(step.insertions, left.id)
        ) {
          old = json(left);
          break;
        }
      out.push({ label: `${id}.${prefix}${key}`, id, map, key, value: json(item), old });
    }
  };
  for (const [id, record] of records(doc)) {
    look(id, record, "");
    const data = record.get("data");
    if (data instanceof Y.Map) look(id, data, "data.");
  }
  return out;
}

/** The clients whose delete marks or dissolve make an element gone. */
function removers(t: BasicsSetup, id: ElementId): Set<number> {
  const r = t.resolver();
  const elements = roots(t.doc).elements;
  const out = new Set<number>();
  for (const { root, action } of r.deleters(id)) {
    const marks = (elements.get(root) as Y.Map<unknown>).get("deleted") as Y.Map<unknown>;
    const item = entry(marks, action);
    if (item) out.add(item.id.client);
  }
  if (r.isDissolved(id)) {
    const item = entry(elements.get(id) as Y.Map<unknown>, "dissolved");
    if (item) out.add(item.id.client);
  }
  return out;
}

/** Elements hidden by a delete of `client`. */
function deletedBy(t: BasicsSetup, client: number): ElementId[] {
  const r = t.resolver();
  const elements = roots(t.doc).elements;
  return [...elements.keys()].filter(
    (id) =>
      r.get(id) !== undefined &&
      r.isDeleted(id) &&
      r.deleters(id).some(({ root, action }) => {
        const marks = (elements.get(root) as Y.Map<unknown>).get(
          "deleted",
        ) as Y.Map<unknown>;
        return entry(marks, action)?.id.client === client;
      }),
  );
}

function samePoint(a: Point, b: Point): boolean {
  const close = (u: number, v: number) =>
    Math.abs(u - v) <= 1e-9 * Math.max(1, Math.abs(u), Math.abs(v));
  return close(a.x, b.x) && close(a.y, b.y);
}

/**
 * Whether an element's position is converted from another space (rule 3 of
 * docs/adr/0001 section 5.3): written in a space that is neither its container
 * nor covered by its rebase, which happens only after conflicting concurrent
 * changes of container. Such a position is converted through container offsets
 * computed by rules 1 and 2 alone, so any change of container along the way
 * can shift it, also one that keeps every container where it is (0001 section
 * 13, "mixed double conflicts"). Rule 1 leaves
 * such elements out.
 */
function converted(snapshot: DocumentSnapshot, r: Resolver, id: ElementId): boolean {
  const element = snapshot.elements[id];
  if (!element) return false;
  const parent = r.parentOf(id);
  if (element.pos.space === parent) return false;
  const rebase = element.rebase;
  return !(
    rebase?.to === parent && rebase.shifts.some((s) => s.from === element.pos.space)
  );
}

/**
 * The state after, with every position put back that changed since the state
 * before. Where the step wrote an element's container as well as its position
 * (a move into another container, which a drag makes as one step,
 * docs/adr/0014), its container and rebase are put back with the position:
 * the old position read under the new container would be converted from
 * another space, which says nothing about the step.
 */
function withPositionsOf(after: DocumentSnapshot, before: DocumentSnapshot): Resolver {
  const elements = { ...after.elements };
  for (const [id, element] of Object.entries(after.elements)) {
    const old = Object.hasOwn(before.elements, id) ? before.elements[id] : undefined;
    if (!old || JSON.stringify(old.pos) === JSON.stringify(element.pos)) continue;
    const placed =
      old.parent !== element.parent ||
      JSON.stringify(old.rebase ?? null) !== JSON.stringify(element.rebase ?? null);
    elements[id] = placed
      ? { ...element, pos: old.pos, parent: old.parent, rebase: old.rebase }
      : { ...element, pos: old.pos };
  }
  return new Resolver(lookupFromRecord(elements));
}

/**
 * Why an element may move on the canvas by more than the positions an undo
 * wrote, where that is a known limitation of the model (docs/adr/0001
 * section 13), or null. Rule 1 leaves such elements out, by name; every
 * other move fails the test.
 *
 * - "cycle" (section 5.1, section 13 item 27): a container on the element's
 *   way up is in a parent cycle, before or after the undo (an undo that
 *   closes or ends one), which the resolver breaks at its smallest id; what
 *   is under the break is placed through another chain of containers.
 * - "converted" (section 13 item 16): the element, or a container on its way
 *   up, has a position converted from another space by rule 3 of section 5.3,
 *   before or after the undo: such positions are converted through offsets
 *   that any change of container along the way can alter.
 * - "nested" (section 13 item 26): the step changed the container of the
 *   element and of a container above it.
 */
type Exemption = "cycle" | "converted" | "nested";

function inCycle(snapshot: DocumentSnapshot, r: Resolver, id: ElementId): boolean {
  // Up the stored parents: a stored parent that is a container and that the
  // resolver does not take as the parent, because it lies inside the child.
  const seen = new Set<ElementId>();
  for (let at: ElementId | null = id; at !== null && !seen.has(at);) {
    seen.add(at);
    const stored: ElementId | null = snapshot.elements[at]?.parent ?? null;
    if (stored === null) return false;
    if (r.isContainer(stored) && r.parentOf(at) !== stored && r.isWithin(stored, at))
      return true;
    at = stored;
  }
  return false;
}

function chainOf(r: Resolver, id: ElementId): ElementId[] {
  const out: ElementId[] = [];
  for (
    let at: ElementId | null = id;
    at !== null && out.length < 4096;
    at = r.parentOf(at)
  )
    out.push(at);
  return out;
}

function exemption(
  id: ElementId,
  states: readonly { snapshot: DocumentSnapshot; r: Resolver }[],
): Exemption | null {
  if (states.some(({ snapshot, r }) => inCycle(snapshot, r, id))) return "cycle";
  for (const { snapshot, r } of states)
    if (chainOf(r, id).some((at) => converted(snapshot, r, at))) return "converted";
  const [before, after] = states;
  const changed = chainOf(after!.r, id).filter(
    (at) =>
      before!.snapshot.elements[at]?.parent !== after!.snapshot.elements[at]?.parent,
  );
  return changed.length > 1 ? "nested" : null;
}

/** How often rule 1 left an element out, and why (for a debugger or a print while investigating). */
const exemptions: Record<Exemption, number> = { cycle: 0, converted: 0, nested: 0 };

/** The keys that place an element, in a container and on the canvas. */
const PLACE_KEYS = new Set(["pos", "parent", "rebase", "order"]);

/** For each element, the place keys a step wrote, with their values before it. */
function placeKeysOf(
  own: readonly StepValue[],
): Map<ElementId, Map<string, string | undefined>> {
  const out = new Map<ElementId, Map<string, string | undefined>>();
  for (const v of own) {
    if (!PLACE_KEYS.has(v.key)) continue;
    const keys = out.get(v.id) ?? new Map<string, string | undefined>();
    keys.set(v.key, v.old);
    out.set(v.id, keys);
  }
  return out;
}

/** Runs undo or redo for `me`, checking rules 1 to 4 against `other`. */
function checkedHistory(me: BasicsSetup, other: BasicsSetup, command: string): boolean {
  const mine = me.doc.clientID;
  const theirs = other.doc.clientID;
  const values = writtenBy(me.doc, theirs);
  const deleted = deletedBy(me, theirs);
  // A resolver over the live document reads it when asked: keep the state before.
  const snap0 = toSnapshot(me.doc);
  const r0 = new Resolver(lookupFromRecord(snap0.elements));
  const seen = r0.drawOrder();
  const stack = command === BASICS.undo ? me.undo.undoStack : me.undo.redoStack;
  const size = stack.length;
  const step = stack[size - 1];
  const own = step ? stepValues(me.doc, step) : [];
  const outcome = me.run<boolean>(command);
  if (!outcome.ok || !outcome.value) return false;
  const r = me.resolver();
  // 1. Values the other user wrote stay, and nothing moves on the canvas except
  // by the positions the undo writes.
  for (const w of values) expect(w.kept(), `value of the other: ${w.label}`).toBe(true);
  const snap1 = toSnapshot(me.doc);
  const r1 = new Resolver(lookupFromRecord(snap1.elements));
  const back = withPositionsOf(snap1, snap0);
  const states = [
    { snapshot: snap0, r: r0 },
    { snapshot: snap1, r: r1 },
  ];
  for (const id of seen) {
    if (r.isGone(id)) continue;
    if (samePoint(r0.worldOrigin(id), back.worldOrigin(id))) continue;
    const why = exemption(id, states);
    if (why !== null) {
      exemptions[why] += 1;
      continue;
    }
    expect.fail(
      `${id} moved on the canvas by something other than a position the step wrote`,
    );
  }
  // 1b. An element whose container and position the step wrote ends where
  // the step found it (its keys as they were before the step, the rest as
  // now), or stays where it is (an undo finished with a rebase that keeps its
  // place, docs/adr/0001 section 10). withPositionsOf says nothing about it.
  for (const [id, keys] of placeKeysOf(own)) {
    if (!keys.has("pos") || !keys.has("parent") || r.isGone(id) || !seen.includes(id))
      continue;
    const element = snap1.elements[id];
    if (element === undefined) continue;
    const restored = { ...element } as Record<string, unknown>;
    for (const [key, old] of keys)
      restored[key] = old === undefined ? null : JSON.parse(old);
    const expected = new Resolver(
      lookupFromRecord({
        ...snap1.elements,
        [id]: restored as unknown as typeof element,
      }),
    );
    const now = r1.worldOrigin(id);
    if (samePoint(now, expected.worldOrigin(id)) || samePoint(now, r0.worldOrigin(id)))
      continue;
    const why = exemption(id, [...states, { snapshot: snap1, r: expected }]);
    if (why !== null) {
      exemptions[why] += 1;
      continue;
    }
    expect.fail(
      `${id}, moved into or out of a container by the step, is not back in place`,
    );
  }
  // 2. What the other user deleted stays deleted.
  for (const id of deleted)
    expect(r.isGone(id), `deleted by the other and back: ${id}`).toBe(true);
  // 3. What disappears, disappears by this user's own delete or dissolve.
  for (const id of seen) {
    if (!r.isGone(id)) continue;
    const by = removers(me, id);
    expect(by.has(mine), `${id} gone by ${[...by].join(",")}`).toBe(true);
  }
  // 4. The undo is done (when Yjs undid this very step and did not skip it),
  // except what would bring back something deleted by someone else, or hide
  // what the user sees under someone else's delete: the undo manager keeps
  // such a change of container back (docs/adr/0001 section 10; the second
  // since docs/adr/0014).
  // Judged on the state before the undo (its revisions), with the element
  // placed as it was before the step.
  const heldBack = new Set<ElementId>();
  for (const [id, keys] of placeKeysOf(own)) {
    const element = snap0.elements[id];
    if (element === undefined) continue;
    const restored = { ...element } as Record<string, unknown>;
    for (const [key, old] of keys)
      restored[key] = old === undefined ? null : JSON.parse(old);
    const hypothetical = new Resolver(
      lookupFromRecord({
        ...snap0.elements,
        [id]: restored as unknown as typeof element,
      }),
    );
    const inside = [id, ...r0.descendants(id)].filter((at) => r0.get(at) !== undefined);
    const revives = inside.some((at) => r0.isDeleted(at) && !hypothetical.isDeleted(at));
    const hides = inside.some((at) => !r0.isDeleted(at) && hypothetical.isDeleted(at));
    if (revives || hides) heldBack.add(id);
  }
  if (stack.length === size - 1)
    for (const v of own) {
      if (r0.isDeleted(v.id) && r.isDeleted(v.id)) continue;
      if (heldBack.has(v.id) && PLACE_KEYS.has(v.key)) continue;
      const item = entry(v.map, v.key);
      const now = item && !item.deleted ? json(item) : undefined;
      expect(now !== v.value || now === v.old, `${v.label} not taken back`).toBe(true);
    }
  return true;
}

function converged(a: BasicsSetup, b: BasicsSetup): void {
  syncDocs(a.doc, b.doc);
  expect(toSnapshot(b.doc)).toEqual(toSnapshot(a.doc));
}

/** The random two-user scenario of a seed, every undo and redo checked. */
function concurrentScenario(seed: number, steps: number): void {
  withSeed(seed, () => {
    const docA = new Y.Doc();
    docA.clientID = 1000 + seed;
    const a = setupBasics({ doc: docA });
    const b = setupBasics({ doc: forkDoc(docA, 2000 + seed) });
    const users = [a, b] as const;
    const memories: [RandomMemory, RandomMemory] = [{}, {}];
    const random = seededRandom(seed);
    let historySteps = 0;
    let syncs = 0;
    for (let step = 0; step < steps; step++) {
      if (random() < 0.12) {
        converged(a, b);
        syncs += 1;
        continue;
      }
      const turn = random() < 0.5 ? 0 : 1;
      const me = users[turn];
      const other = users[1 - turn]!;
      const commands = randomCommands(me, random, memories[turn]);
      if (commands[0]!.id === BASICS.undo || commands[0]!.id === BASICS.redo) {
        if (checkedHistory(me, other, commands[0]!.id)) historySteps += 1;
      } else runRandom(me, commands, memories[turn]);
    }
    converged(a, b);
    expect(syncs).toBeGreaterThan(10);
    expect(historySteps).toBeGreaterThan(10);

    // Each undoes everything, syncing after every step.
    let undone = 0;
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      while (me.host.commands.isEnabled(BASICS.undo, me.env())) {
        if (checkedHistory(me, other, BASICS.undo)) undone += 1;
        syncDocs(a.doc, b.doc);
      }
    }
    converged(a, b);
    expect(undone).toBeGreaterThan(30);
  });
}

describe("two users undoing concurrently", () => {
  for (const seed of SEEDS) {
    it(`each undoes only their own changes, and none of the other's is lost (seed ${seed})`, () => {
      concurrentScenario(seed, STEPS);
    }, 600_000);
  }

  function pair(clients?: readonly [number, number]) {
    const docA = new Y.Doc();
    if (clients) docA.clientID = clients[0];
    const a = setupBasics({ doc: docA });
    const b = setupBasics({ doc: forkDoc(docA, clients?.[1]) });
    return { a, b, sync: () => syncDocs(a.doc, b.doc) };
  }

  it("an undo does not overwrite a value the other user wrote after it", () => {
    const { a, b, sync } = pair();
    const x = a.shape(0, 0);
    sync();
    a.must(BASICS.move, { ids: [x], dx: 10, dy: 0 });
    sync();
    b.must(BASICS.move, { ids: [x], dx: 0, dy: 50 });
    sync();
    // A's undo would put x back at (0, 0), but B moved it since: B's move stays.
    a.must(BASICS.undo);
    sync();
    expect(a.resolver().worldOrigin(x)).toEqual({ x: 10, y: 50 });
    expect(b.resolver().worldOrigin(x)).toEqual({ x: 10, y: 50 });
  });

  it("an undo after receiving the other user's delete of the element leaves it deleted", () => {
    const { a, b, sync } = pair();
    const x = a.shape(0, 0);
    sync();
    b.must(BASICS.move, { ids: [x], dx: 10, dy: 0 });
    sync();
    a.must(BASICS.delete, { ids: [x] });
    sync();
    b.must(BASICS.undo);
    sync();
    expect(b.resolver().isGone(x)).toBe(true);
  });

  it("undoing a move into a frame the other user deleted leaves the element deleted, and so does redoing it", () => {
    const { a, b, sync } = pair();
    const f = a.frame(100, 0);
    const x = a.shape(0, 0);
    sync();
    b.must(BASICS.reparent, { ids: [x], target: f });
    sync();
    a.must(BASICS.delete, { ids: [f] });
    sync();
    b.must(BASICS.undo);
    sync();
    for (const user of [a, b]) expect(user.resolver().isGone(x)).toBe(true);
    b.must(BASICS.redo);
    sync();
    for (const user of [a, b]) expect(user.resolver().isGone(x)).toBe(true);
    // A takes its delete back: X is in F, where it was.
    a.must(BASICS.undo);
    sync();
    for (const user of [a, b]) {
      const r = user.resolver();
      expect([r.isGone(f), r.isGone(x), r.parentOf(x)]).toEqual([false, false, f]);
    }
  });

  it("redoing a move out of a frame the other user deleted leaves the element deleted", () => {
    const { a, b, sync } = pair();
    const f = a.frame(0, 0, 200, 200);
    const x = a.shape(10, 10, 10, 10, f);
    sync();
    b.must(BASICS.reparent, { ids: [x], target: null });
    b.must(BASICS.undo);
    sync();
    a.must(BASICS.delete, { ids: [f] });
    sync();
    expect(b.resolver().isGone(x)).toBe(true);
    b.must(BASICS.redo);
    sync();
    for (const user of [a, b]) expect(user.resolver().isGone(x)).toBe(true);
  });

  for (const nested of [false, true])
    it(`undoing a grouping inside a frame the other user deleted leaves the members deleted${nested ? " (nested frames)" : ""}`, () => {
      const { a, b, sync } = pair();
      const f = a.frame(0, 0, 400, 400);
      const l = nested ? a.frame(10, 10, 300, 300, f) : f;
      const x = a.shape(20, 20, 10, 10, l);
      const y = a.shape(60, 20, 10, 10, l);
      sync();
      b.must<ElementId>(BASICS.group, { ids: [x, y] });
      sync();
      a.must(BASICS.delete, { ids: [f] });
      sync();
      b.must(BASICS.undo);
      sync();
      for (const user of [a, b]) {
        const r = user.resolver();
        expect([r.isGone(x), r.isGone(y)]).toEqual([true, true]);
      }
    });

  it("undoing a grouping after the other user deleted the group leaves the members deleted", () => {
    const { a, b, sync } = pair();
    const x = a.shape(0, 0);
    const y = a.shape(50, 0);
    sync();
    const g = b.must<ElementId>(BASICS.group, { ids: [x, y] });
    sync();
    a.must(BASICS.delete, { ids: [g] });
    sync();
    b.must(BASICS.undo);
    sync();
    for (const user of [a, b]) {
      const r = user.resolver();
      expect([r.isGone(x), r.isGone(y)]).toEqual([true, true]);
    }
  });

  // An undo that Yjs can only half do leaves a key without a value (a hole),
  // which the undo manager fills. The work tracker must judge the undo after
  // that, or it sees X at the root, outside the deleted frame, and keeps it.
  for (const clients of [
    [1, 2],
    [2, 1],
  ] as const)
    it(`a half-done undo is finished (the hole filled) before it is judged, and brings back nothing the other user deleted (clients ${clients.join("/")})`, () => {
      const { a, b, sync } = pair(clients);
      const f = a.frame(0, 0, 400, 400);
      const l = a.frame(10, 10, 300, 300, f);
      const x = a.shape(20, 20, 10, 10, l);
      const y = a.shape(60, 20, 10, 10, l);
      sync();
      // Concurrently: A moves X out to the root, B groups X and Y.
      a.must(BASICS.reparent, { ids: [x], target: null });
      const g = b.must<ElementId>(BASICS.group, { ids: [x, y] });
      sync();
      a.must(BASICS.delete, { ids: [f] });
      sync();
      // If B's grouping won X's parent, the undo cannot put the parent back (A's
      // write is on record): a hole, filled with L.
      const grouped = b.resolver().parentOf(x) === g;
      expect(b.resolver().isGone(x)).toBe(grouped);
      b.must(BASICS.undo);
      sync();
      for (const user of [a, b]) {
        const r = user.resolver();
        expect(r.isGone(y)).toBe(true);
        if (grouped) expect([r.parentOf(x), r.isGone(x)]).toEqual([l, true]);
      }
    });

  it("undoing a grouping after the other user moved the group leaves the members where that move put them", () => {
    const { a, b, sync } = pair();
    const x = a.shape(0, 0);
    const y = a.shape(50, 0);
    sync();
    const g = a.must<ElementId>(BASICS.group, { ids: [x, y] });
    sync();
    b.must(BASICS.move, { ids: [g], dx: 100, dy: 0 });
    sync();
    a.must(BASICS.undo);
    sync();
    for (const user of [a, b]) {
      const r = user.resolver();
      expect(r.isGone(g)).toBe(true);
      expect([r.worldOrigin(x), r.worldOrigin(y)]).toEqual([
        { x: 100, y: 0 },
        { x: 150, y: 0 },
      ]);
    }
    // Redo groups them again, where they are.
    a.must(BASICS.redo);
    sync();
    const r = b.resolver();
    expect([r.isGone(g), r.parentOf(x), r.worldOrigin(x)]).toEqual([
      false,
      g,
      { x: 100, y: 0 },
    ]);
  });

  it("undoing a move into a frame after the other user moved the frame leaves the element where that move put it", () => {
    const { a, b, sync } = pair();
    const f = a.frame(100, 0);
    const x = a.shape(120, 20);
    sync();
    b.must(BASICS.reparent, { ids: [x], target: f });
    sync();
    a.must(BASICS.move, { ids: [f], dx: 0, dy: 300 });
    sync();
    b.must(BASICS.undo);
    sync();
    for (const user of [a, b])
      expect(user.resolver().worldOrigin(x)).toEqual({ x: 120, y: 320 });
  });

  it("work the other user did without knowing of an undo survives it", () => {
    const { a, b, sync } = pair();
    const x = a.shape(300, 300);
    sync();
    const f = a.frame(0, 0, 200, 200);
    sync();
    const z = b.shape(10, 10, 10, 10, f);
    b.must(BASICS.reparent, { ids: [x], target: f });
    a.must(BASICS.undo); // takes back creating F, before receiving B's work
    sync();
    for (const user of [a, b]) {
      const r = user.resolver();
      expect([r.isGone(f), r.isGone(z), r.isGone(x)]).toEqual([true, false, false]);
    }
  });
});
