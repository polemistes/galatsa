// SPDX-License-Identifier: GPL-3.0-or-later

// Undo with two users. Two replicas run random commands (the basic commands,
// insertions, undo and redo) and sync at random moments; at the end each user
// undoes everything, syncing after every step. Every undo and redo is checked
// against what "each user undoes only their own changes, and none of the other
// user's changes is lost" means under the rules of docs/adr/0001, sections 5
// and 10:
//
// 1. Values. No value the other user wrote (position, size, rotation, stacking
//    key, container, rebase, lock, name, dissolved flag, layout version, or a
//    data key) and that is current when the undo starts is replaced or removed
//    by it. An undo only takes back writes of its own user.
// 2. Deletes. Nothing the other user's delete hides is brought back by it.
// 3. What disappears. An element that the user saw and that is gone after the
//    undo is gone through a delete mark or a dissolve of this user's own: the
//    undo of their own creation, grouping or ungrouping, or a redo of their own
//    delete. Such a removal hides only what the user saw, keeps what the other
//    user did without knowing of it, and can be taken back (section 5.5); it is
//    not a loss.
//
// And after every sync the two replicas hold the same document.

import { ELEMENT_KEYS, roots, syncDocs, toSnapshot, forkDoc } from "@galatsa/core/ydoc";
import { seededRandom } from "@galatsa/core/testing";
import type { ElementId } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASICS } from "./index.ts";
import {
  randomCommands,
  runRandom,
  setupBasics,
  withSeed,
  type BasicsSetup,
} from "./testing.ts";

const STEPS = 400;
const SEEDS = [1, 2, 3];

/** Envelope keys whose values a user writes (rev and deleted are the work tracker's). */
const VALUE_KEYS = ELEMENT_KEYS.filter(
  (key) => key !== "rev" && key !== "deleted" && key !== "data" && key !== "ext",
);

interface Written {
  readonly id: ElementId;
  readonly key: string;
  readonly map: Y.Map<unknown>;
  readonly item: unknown;
}

/** The map entry that holds a key's current value (Yjs keeps one per key). */
function entry(map: Y.Map<unknown>, key: string) {
  return map._map.get(key);
}

/** Current values in the document that `client` wrote. */
function writtenBy(doc: Y.Doc, client: number): Written[] {
  const out: Written[] = [];
  for (const [id, record] of roots(doc).elements.entries()) {
    if (!(record instanceof Y.Map)) continue;
    const look = (map: Y.Map<unknown>, keys: Iterable<string>, prefix: string) => {
      for (const key of keys) {
        const item = entry(map, key);
        if (item && !item.deleted && item.id.client === client)
          out.push({ id, key: prefix + key, map, item });
      }
    };
    look(record, VALUE_KEYS, "");
    const data = record.get("data");
    if (data instanceof Y.Map) look(data, [...data._map.keys()], "data.");
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

/** Elements hidden by a delete of `client`, with the deleted elements that hide them. */
function deletedBy(t: BasicsSetup, client: number): Map<ElementId, ElementId[]> {
  const r = t.resolver();
  const elements = roots(t.doc).elements;
  const out = new Map<ElementId, ElementId[]>();
  for (const id of elements.keys()) {
    if (!r.get(id) || !r.isDeleted(id)) continue;
    const by = r.deleters(id).filter(({ root, action }) => {
      const marks = (elements.get(root) as Y.Map<unknown>).get(
        "deleted",
      ) as Y.Map<unknown>;
      return entry(marks, action)?.id.client === client;
    });
    if (by.length > 0)
      out.set(
        id,
        by.map((d) => d.root),
      );
  }
  return out;
}

/** What the checks found that the rules allow but that is worth knowing. */
interface Findings {
  /** Elements deleted by the other user that an undo moved out of the deleted container. */
  movedOut: number;
}

/** Runs undo or redo for `me`, checking rules 1 to 3 against `other`. */
function checkedHistory(
  me: BasicsSetup,
  other: BasicsSetup,
  command: string,
  findings: Findings,
): boolean {
  const mine = me.doc.clientID;
  const theirs = other.doc.clientID;
  const values = writtenBy(me.doc, theirs);
  const deleted = deletedBy(me, theirs);
  const seen = me.resolver().drawOrder();
  const outcome = me.run<boolean>(command);
  if (!outcome.ok || !outcome.value) return false;
  // 1. Values the other user wrote stay.
  for (const w of values)
    expect(entry(w.map, w.key.replace(/^data\./, "")), `${w.id} ${w.key}`).toBe(w.item);
  // 2. What the other user deleted stays deleted, unless the undo took the
  // element out of the deleted container (see the test of that case below).
  const r = me.resolver();
  for (const [id, containers] of deleted) {
    if (r.isGone(id)) continue;
    const stillInside = containers.some((c) => c === id || r.isWithin(id, c));
    expect(stillInside, `deleted by the other and back: ${id}`).toBe(false);
    findings.movedOut += 1;
  }
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

describe("two users undoing concurrently", () => {
  for (const seed of SEEDS) {
    it(`each undoes only their own changes, and none of the other's is lost (seed ${seed})`, () => {
      withSeed(seed, () => {
        const docA = new Y.Doc();
        docA.clientID = 1000 + seed;
        const a = setupBasics({ doc: docA });
        const b = setupBasics({ doc: forkDoc(docA, 2000 + seed) });
        const users = [a, b] as const;
        const random = seededRandom(seed);
        const findings: Findings = { movedOut: 0 };
        let historySteps = 0;
        let syncs = 0;
        for (let step = 0; step < STEPS; step++) {
          if (random() < 0.12) {
            converged(a, b);
            syncs += 1;
            continue;
          }
          const turn = random() < 0.5 ? 0 : 1;
          const me = users[turn];
          const other = users[1 - turn]!;
          const commands = randomCommands(me, random);
          if (commands[0]!.id === BASICS.undo || commands[0]!.id === BASICS.redo) {
            if (checkedHistory(me, other, commands[0]!.id, findings)) historySteps += 1;
          } else runRandom(me, commands);
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
            if (checkedHistory(me, other, BASICS.undo, findings)) undone += 1;
            syncDocs(a.doc, b.doc);
          }
        }
        converged(a, b);
        expect(undone).toBeGreaterThan(30);
      });
    }, 60_000);
  }

  function pair() {
    const a = setupBasics();
    const b = setupBasics({ doc: forkDoc(a.doc) });
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

  // Known limitation (docs/adr/0005, section 13). An element deleted with its
  // container comes back when the other user undoes having moved it into that
  // container: the undo takes it out of the deleted container, and a delete
  // hides only what is inside the deleted element (docs/adr/0001, section 5.5).
  // Nothing is lost, but the delete no longer covers it.
  it("an undo that takes an element out of a container the other user deleted brings it back", () => {
    const { a, b, sync } = pair();
    const f = a.frame(100, 0);
    const x = a.shape(0, 0);
    sync();
    b.must(BASICS.reparent, { ids: [x], target: f });
    sync();
    a.must(BASICS.delete, { ids: [f] });
    sync();
    expect(b.resolver().isGone(x)).toBe(true);
    b.must(BASICS.undo);
    sync();
    for (const user of [a, b]) {
      const r = user.resolver();
      expect(r.isGone(f)).toBe(true);
      expect(r.isGone(x)).toBe(false);
      expect(r.parentOf(x)).toBeNull();
      expect(r.worldOrigin(x)).toEqual({ x: 0, y: 0 });
    }
  });
});
