// SPDX-License-Identifier: GPL-3.0-or-later

// Undo with two users. Two replicas run random commands (the basic commands,
// insertions, undo and redo) and sync at random moments; at the end each user
// undoes everything, syncing after every step. Every undo and redo is checked
// against what "each user undoes only their own changes, and none of the other
// user's changes is lost" means under the rules of docs/adr/0001, sections 5
// and 10:
//
// 1. Values and places. No value the other user wrote that is current when the
//    undo starts is replaced or removed by it: envelope keys (position, size,
//    rotation, stacking key, container, rebase, lock, name, dissolved flag,
//    layout version), data and ext keys, and what is inside shared types there.
//    And no element moves on the canvas unless the undo takes back a move of
//    it, or of something it is in: an undo never takes back, in effect, a move
//    the other user made (moving a group, or the frame an element was put in).
// 2. Deletes. Nothing the other user's delete hides comes back.
// 3. What disappears. An element that the user saw and that is gone after the
//    undo is gone through a delete mark or a dissolve of this user's own: the
//    undo of their own creation, grouping or ungrouping, or a redo of their own
//    delete. Such a removal hides only what the user saw, keeps what the other
//    user did without knowing of it, and can be taken back (section 5.5); it is
//    not a loss.
//
// And after every sync the two replicas hold the same document.

import { roots, syncDocs, toSnapshot, forkDoc } from "@galatsa/core/ydoc";
import { seededRandom } from "@galatsa/core/testing";
import type { ElementId, Point, Resolver } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASICS } from "./index.ts";
import {
  randomCommands,
  runRandom,
  setupBasics,
  withSeed,
  type BasicsSetup,
  type RandomMemory,
} from "./testing.ts";

const STEPS = 400;
// Seeds 1 to 40 with 600 steps passed when this was written; these run by default.
const SEEDS = [1, 2, 3, 4];

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

function writtenBy(doc: Y.Doc, client: number): Written[] {
  const out: Written[] = [];
  for (const [id, record] of roots(doc).elements.entries())
    if (record instanceof Y.Map)
      collect(
        record as unknown as Y.AbstractType<unknown>,
        id,
        client,
        out,
        TRACKER_KEYS,
      );
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
 * The elements whose positions an element's place on the canvas depends on: it,
 * the containers it is in, and the containers its position is written in
 * (after conflicting container changes, a position is converted from the space
 * it was written in, docs/adr/0001 section 5.3, rule 3), and so on up.
 */
function placedBy(r: Resolver, id: ElementId): ElementId[] {
  const out = new Set<ElementId>();
  const queue: ElementId[] = [id];
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

/** Runs undo or redo for `me`, checking rules 1 to 3 against `other`. */
function checkedHistory(me: BasicsSetup, other: BasicsSetup, command: string): boolean {
  const mine = me.doc.clientID;
  const theirs = other.doc.clientID;
  const elements = roots(me.doc).elements;
  const posEntry = (id: ElementId) => entry(elements.get(id) as Y.Map<unknown>, "pos");
  const values = writtenBy(me.doc, theirs);
  const deleted = deletedBy(me, theirs);
  const r0 = me.resolver();
  const seen = r0.drawOrder();
  const places = new Map(
    seen.map((id) => [id, { at: r0.worldOrigin(id), up: placedBy(r0, id) }]),
  );
  const positions = new Map([...elements.keys()].map((id) => [id, posEntry(id)]));
  const outcome = me.run<boolean>(command);
  if (!outcome.ok || !outcome.value) return false;
  const r = me.resolver();
  // 1. Values the other user wrote stay, and nothing moves on the canvas unless
  // the undo moved it or something it is in.
  for (const w of values) expect(w.kept(), `value of the other: ${w.label}`).toBe(true);
  for (const [id, { at, up }] of places) {
    if (r.isGone(id) || samePoint(at, r.worldOrigin(id))) continue;
    const movers = [...up, ...placedBy(r, id)];
    const moved = movers.some((m) => posEntry(m) !== positions.get(m));
    expect(moved, `${id} moved on the canvas by a step that did not move it`).toBe(true);
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
    }, 60_000);
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
    it(`a half-done undo does not bring back what the other user deleted (clients ${clients.join("/")})`, () => {
      const { a, b, sync } = pair(clients);
      const f = a.frame(0, 0, 400, 400);
      const l = a.frame(10, 10, 300, 300, f);
      const x = a.shape(20, 20, 10, 10, l);
      const y = a.shape(60, 20, 10, 10, l);
      sync();
      // Concurrently: A moves X out to the root, B groups X and Y.
      a.must(BASICS.reparent, { ids: [x], target: null });
      b.must<ElementId>(BASICS.group, { ids: [x, y] });
      sync();
      a.must(BASICS.delete, { ids: [f] });
      sync();
      const hiddenBefore = b.resolver().isGone(x);
      b.must(BASICS.undo);
      sync();
      for (const user of [a, b]) {
        const r = user.resolver();
        expect(r.isGone(y)).toBe(true);
        if (hiddenBefore) expect(r.isGone(x)).toBe(true);
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
