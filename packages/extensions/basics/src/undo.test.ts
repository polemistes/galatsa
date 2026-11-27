// SPDX-License-Identifier: GPL-3.0-or-later

// The undo test: a seeded random sequence of a thousand commands through the
// registry (the basic commands, insertions, undo and redo, with valid and
// refused arguments) can be undone all the way back to the empty document and
// redone to the same result. "The same" is compared on what the user sees: the
// document purged as for sharing (positions resolved, no revisions, delete
// marks or removed records), which undo and redo must restore exactly.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASICS } from "./index.ts";
import {
  randomCommands,
  runRandom,
  setupBasics,
  visibleState,
  withSeed,
  type BasicsSetup,
} from "./testing.ts";
import { seededRandom } from "@galatsa/core/testing";

const COMMANDS = 1000;
// Each seed takes a few seconds. Seeds 1 to 42 all passed when this was written;
// three are run by default.
const SEEDS = [1, 2, 3];

/** Undoes until nothing is left to undo; returns how many undos changed something. */
function undoAll(t: BasicsSetup): number {
  let count = 0;
  while (t.host.commands.isEnabled(BASICS.undo, t.env())) {
    if (t.must<boolean>(BASICS.undo)) count += 1;
    if (count > 10 * COMMANDS) throw new Error("undo does not end");
  }
  return count;
}

/**
 * Redoes `count` steps, each of which must change something. (The scenario may
 * end with steps it undid itself and did not redo; those stay on the redo
 * stack, below the ones undoAll put there.)
 */
function redoSteps(t: BasicsSetup, count: number): void {
  for (let i = 0; i < count; i++) expect(t.must<boolean>(BASICS.redo)).toBe(true);
}

/** Runs the scenario of a seed; returns the setup, the empty state and a log of what ran. */
function scenario(seed: number, count = COMMANDS) {
  return withSeed(seed, () => {
    const doc = new Y.Doc();
    doc.clientID = seed;
    const t = setupBasics({ doc });
    const empty = visibleState(doc);
    const random = seededRandom(seed);
    const log: string[] = [];
    const succeeded = new Map<string, number>();
    let ran = 0;
    let updates = 0;
    doc.on("update", () => (updates += 1));
    while (ran < count) {
      const commands = randomCommands(t, random);
      const before = t.undo.undoStack.length;
      const updatesBefore = updates;
      const outcomes = runRandom(t, commands);
      commands.forEach((command, i) => {
        const outcome = outcomes[i]!;
        log.push(`${command.id} ${outcome.ok ? "ok" : outcome.reason}`);
        if (outcome.ok) succeeded.set(command.id, (succeeded.get(command.id) ?? 0) + 1);
        // Nothing fails half-way: a command is either refused or runs.
        if (!outcome.ok) expect(outcome.reason).toBe("disabled");
      });
      ran += commands.length;
      const added = t.undo.undoStack.length - before;
      const isHistory = commands.some(
        (c) => c.id === BASICS.undo || c.id === BASICS.redo,
      );
      if (!isHistory) {
        // A command makes at most one undo step (copy and paste, two commands, one).
        expect(added).toBeLessThanOrEqual(1);
        // A refused command writes nothing.
        if (outcomes.every((o) => !o.ok)) expect(updates).toBe(updatesBefore);
      }
    }
    return { t, empty, log, succeeded };
  });
}

describe("a thousand random commands", () => {
  for (const seed of SEEDS) {
    it(`undo back to the empty document and redo to the same result (seed ${seed})`, () => {
      const { t, empty, succeeded } = scenario(seed);
      const final = visibleState(t.doc);
      expect(Object.keys(final.elements).length).toBeGreaterThan(10);
      // The scenario exercised the commands it is about.
      for (const id of [
        BASICS.move,
        BASICS.reparent,
        BASICS.group,
        BASICS.delete,
        BASICS.duplicate,
        BASICS.paste,
        BASICS.undo,
      ])
        expect(succeeded.get(id) ?? 0, id).toBeGreaterThan(0);

      withSeed(seed + 1000, () => {
        const undone = undoAll(t);
        expect(undone).toBeGreaterThan(50);
        expect(t.resolver().drawOrder()).toEqual([]);
        expect(visibleState(t.doc)).toEqual(empty);

        redoSteps(t, undone);
        expect(visibleState(t.doc)).toEqual(final);

        // And once more, both ways.
        expect(undoAll(t)).toBe(undone);
        expect(visibleState(t.doc)).toEqual(empty);
        redoSteps(t, undone);
        expect(visibleState(t.doc)).toEqual(final);
      });
    }, 60_000);
  }

  it("is reproducible from its seed", () => {
    const a = scenario(SEEDS[0]!, 300);
    const b = scenario(SEEDS[0]!, 300);
    expect(b.log).toEqual(a.log);
    expect(visibleState(b.t.doc)).toEqual(visibleState(a.t.doc));
  }, 60_000);
});
