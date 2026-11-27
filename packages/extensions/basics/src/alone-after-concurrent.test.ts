// SPDX-License-Identifier: GPL-3.0-or-later

// One user alone, on a document that two users edited concurrently before, so
// that it holds positions converted from other spaces, broken cycles,
// survivors of deletes and dissolved groups (docs/adr/0001, sections 5.3 and
// 5.5). Every undo and redo must give exactly the state its step started from
// (or ended in), and the undo manager never has to finish an undo: nobody else
// changed anything since.

import type { DocumentSnapshot } from "@galatsa/core";
import { seededRandom } from "@galatsa/core/testing";
import { forkDoc, syncDocs } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASICS } from "./index.ts";
import {
  envList,
  envNumber,
  randomCommands,
  runRandom,
  setupBasics,
  visibleState,
  watchSettle,
  withSeed,
  type RandomMemory,
} from "./testing.ts";

// ALONE_SEEDS ("1-30"), ALONE_MERGE_STEPS and ALONE_SOLO_STEPS change these.
const SEEDS = envList("ALONE_SEEDS", [1, 2]);
const MERGE_STEPS = envNumber("ALONE_MERGE_STEPS", 300);
const SOLO_STEPS = envNumber("ALONE_SOLO_STEPS", 200);

function scenario(seed: number): void {
  withSeed(seed, () => {
    const docA = new Y.Doc();
    docA.clientID = 1000 + seed;
    const a = setupBasics({ doc: docA });
    const b = setupBasics({ doc: forkDoc(docA, 2000 + seed) });
    const random = seededRandom(seed);
    const memories: [RandomMemory, RandomMemory] = [{}, {}];
    for (let step = 0; step < MERGE_STEPS; step++) {
      if (random() < 0.15) {
        syncDocs(a.doc, b.doc);
        continue;
      }
      const turn = random() < 0.5 ? 0 : 1;
      const me = [a, b][turn]!;
      runRandom(me, randomCommands(me, random, memories[turn]), memories[turn]);
    }
    syncDocs(a.doc, b.doc);
    // A alone from here on.
    a.undo.clear();
    const stats = watchSettle(a);
    const undoStates: DocumentSnapshot[] = [];
    const redoStates: DocumentSnapshot[] = [];
    const mismatches: string[] = [];
    const check = (label: string, expected: DocumentSnapshot | undefined) => {
      if (expected && JSON.stringify(expected) !== JSON.stringify(visibleState(a.doc)))
        mismatches.push(label);
    };
    for (let step = 0; step < SOLO_STEPS; step++) {
      const commands = randomCommands(a, random, memories[0]);
      const before = visibleState(a.doc);
      const [u0, r0] = [a.undo.undoStack.length, a.undo.redoStack.length];
      const id = commands[0]!.id;
      if (id === BASICS.undo || id === BASICS.redo) {
        const done = a.run<boolean>(id);
        if (!done.ok || !done.value) continue;
        if (id === BASICS.undo) {
          const removed = u0 - a.undo.undoStack.length;
          const expected = undoStates.splice(undoStates.length - removed, removed)[0];
          redoStates.push(before);
          check(`step ${step}: undo`, expected);
        } else {
          const removed = r0 - a.undo.redoStack.length;
          const expected = redoStates.splice(redoStates.length - removed, removed)[0];
          undoStates.push(before);
          check(`step ${step}: redo`, expected);
        }
        continue;
      }
      runRandom(a, commands, memories[0]);
      if (a.undo.undoStack.length > u0) {
        undoStates.push(before);
        redoStates.length = 0;
      }
    }
    // And all the way back.
    while (a.undo.undoStack.length > 0) {
      const before = visibleState(a.doc);
      const u0 = a.undo.undoStack.length;
      if (!a.must<boolean>(BASICS.undo)) break;
      const removed = u0 - a.undo.undoStack.length;
      const expected = undoStates.splice(undoStates.length - removed, removed)[0];
      redoStates.push(before);
      check("final undo", expected);
    }
    expect(mismatches).toEqual([]);
    expect(stats).toEqual({ holes: 0, settled: 0 });
  });
}

describe("one user alone after concurrent editing", () => {
  for (const seed of SEEDS)
    it(`undo and redo are exact, and no undo has to be finished (seed ${seed})`, () => {
      scenario(seed);
    }, 600_000);
});
