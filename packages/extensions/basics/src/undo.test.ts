// SPDX-License-Identifier: GPL-3.0-or-later

// The undo test: a seeded random sequence of a thousand commands through the
// registry (the basic commands, insertions, undo and redo, with valid and
// refused arguments) can be undone all the way back to the empty document and
// redone to the same result, and every undo and redo along the way gives the
// state the step it takes back started from (or the one it makes again ended
// in). States are compared as the user sees them: the document purged as for
// sharing (positions resolved, no revisions, delete marks or removed records),
// which undo and redo must restore exactly.

import type { DocumentSnapshot, ElementId } from "@galatsa/core";
import { seededRandom } from "@galatsa/core/testing";
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
  type RandomMemory,
} from "./testing.ts";

const COMMANDS = 1000;
// Each seed takes a few seconds. Seeds 1 to 42 all passed when this was written;
// three run by default.
const SEEDS = [1, 2, 3];

/** Where two states differ, briefly. */
function diff(a: DocumentSnapshot, b: DocumentSnapshot): string {
  const ids = new Set([...Object.keys(a.elements), ...Object.keys(b.elements)]);
  const out: string[] = [];
  for (const id of ids) {
    const x = a.elements[id as ElementId];
    const y = b.elements[id as ElementId];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (!x || !y) {
      out.push(`${id}: only in the ${x ? "expected" : "actual"} state`);
      continue;
    }
    for (const key of Object.keys({ ...x, ...y }) as (keyof typeof x)[])
      if (JSON.stringify(x[key]) !== JSON.stringify(y[key]))
        out.push(`${id}.${key}: ${JSON.stringify(x[key])} -> ${JSON.stringify(y[key])}`);
  }
  if (out.length === 0) out.push("outside the elements");
  return out.slice(0, 8).join("; ");
}

/**
 * Keeps, for every step on the undo and redo stacks, the state it should give
 * back, and checks each undo and redo against it.
 */
class History {
  readonly undo: DocumentSnapshot[] = [];
  readonly redo: DocumentSnapshot[] = [];
  readonly mismatches: string[] = [];
  readonly t: BasicsSetup;

  constructor(t: BasicsSetup) {
    this.t = t;
  }

  /** Records what a command did, given the state and stack sizes before it. */
  after(
    command: string,
    ok: boolean,
    value: unknown,
    before: DocumentSnapshot,
    u0: number,
    r0: number,
  ): void {
    const t = this.t;
    const now = visibleState(t.doc);
    const u1 = t.undo.undoStack.length;
    const r1 = t.undo.redoStack.length;
    if ((command === BASICS.undo || command === BASICS.redo) && ok && value === true) {
      const [from, to, removed] =
        command === BASICS.undo
          ? [this.undo, this.redo, u0 - u1]
          : [this.redo, this.undo, r0 - r1];
      const expected = from[from.length - removed]!;
      from.length -= removed;
      to.push(before);
      if (JSON.stringify(expected) !== JSON.stringify(now))
        this.mismatches.push(`${command}: ${diff(expected, now)}`);
    } else if (u1 - u0 === 1) {
      this.undo.push(before);
      this.redo.length = 0;
    } else if (u1 === u0 && JSON.stringify(before) !== JSON.stringify(now)) {
      this.mismatches.push(
        `${command} changed the document without a step: ${diff(before, now)}`,
      );
    }
    expect(this.undo.length).toBe(u1);
    expect(this.redo.length).toBe(t.undo.redoStack.length);
  }

  /** Runs undo or redo, checked. Returns whether it changed something. */
  step(command: string): boolean {
    const t = this.t;
    const before = visibleState(t.doc);
    const [u0, r0] = [t.undo.undoStack.length, t.undo.redoStack.length];
    const done = t.must<boolean>(command);
    this.after(command, true, done, before, u0, r0);
    return done;
  }
}

/** Runs the scenario of a seed, checking every step. */
function scenario(seed: number, count = COMMANDS) {
  return withSeed(seed, () => {
    const doc = new Y.Doc();
    doc.clientID = seed;
    const t = setupBasics({ doc });
    const empty = visibleState(doc);
    const random = seededRandom(seed);
    const memory: RandomMemory = {};
    const history = new History(t);
    const log: string[] = [];
    const succeeded = new Map<string, number>();
    let ran = 0;
    let updates = 0;
    doc.on("update", () => (updates += 1));
    while (ran < count) {
      const commands = randomCommands(t, random, memory);
      const before = visibleState(doc);
      const [u0, r0] = [t.undo.undoStack.length, t.undo.redoStack.length];
      const updatesBefore = updates;
      const outcomes = runRandom(t, commands, memory);
      commands.forEach((command, i) => {
        const outcome = outcomes[i]!;
        log.push(`${command.id} ${outcome.ok ? "ok" : outcome.reason}`);
        if (outcome.ok) succeeded.set(command.id, (succeeded.get(command.id) ?? 0) + 1);
        // Nothing fails half-way: a command is either refused or runs.
        if (!outcome.ok) expect(outcome.reason).toBe("disabled");
      });
      ran += commands.length;
      const last = outcomes[outcomes.length - 1]!;
      const id = commands[commands.length - 1]!.id;
      // A command makes at most one undo step (copy and paste, two commands, one).
      if (id !== BASICS.undo && id !== BASICS.redo)
        expect(t.undo.undoStack.length - u0).toBeLessThanOrEqual(1);
      // A refused command writes nothing.
      if (outcomes.every((o) => !o.ok)) expect(updates).toBe(updatesBefore);
      history.after(id, last.ok, last.ok ? last.value : undefined, before, u0, r0);
    }
    return { t, empty, log, succeeded, history };
  });
}

/** Undoes until nothing is left to undo, each step checked; returns how many changed something. */
function undoAll(history: History, t: BasicsSetup): number {
  let count = 0;
  while (t.host.commands.isEnabled(BASICS.undo, t.env())) {
    if (history.step(BASICS.undo)) count += 1;
    if (count > 10 * COMMANDS) throw new Error("undo does not end");
  }
  return count;
}

/**
 * Redoes `count` steps, each checked. (The scenario may end with steps it undid
 * itself and did not redo; those stay on the redo stack, below the ones undoAll
 * put there.)
 */
function redoSteps(history: History, count: number): void {
  for (let i = 0; i < count; i++) expect(history.step(BASICS.redo)).toBe(true);
}

describe("a thousand random commands", () => {
  for (const seed of SEEDS) {
    it(`undo back to the empty document and redo to the same result, every step checked (seed ${seed})`, () => {
      const { t, empty, succeeded, history } = scenario(seed);
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
        const undone = undoAll(history, t);
        expect(undone).toBeGreaterThan(50);
        expect(t.resolver().drawOrder()).toEqual([]);
        expect(visibleState(t.doc)).toEqual(empty);

        redoSteps(history, undone);
        expect(visibleState(t.doc)).toEqual(final);

        // And once more, both ways.
        expect(undoAll(history, t)).toBe(undone);
        expect(visibleState(t.doc)).toEqual(empty);
        redoSteps(history, undone);
        expect(visibleState(t.doc)).toEqual(final);
      });
      expect(history.mismatches).toEqual([]);
    }, 120_000);
  }

  it("is reproducible from its seed", () => {
    const a = scenario(SEEDS[0]!, 300);
    const b = scenario(SEEDS[0]!, 300);
    expect(b.log).toEqual(a.log);
    expect(visibleState(b.t.doc)).toEqual(visibleState(a.t.doc));
  }, 60_000);
});
