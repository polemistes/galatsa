// SPDX-License-Identifier: GPL-3.0-or-later

// Property tests. For random documents and random sequences of operations
// (including typing through an editor binding, undo and redo, tidy up and
// partial syncs across three replicas), see scenario.ts: the replicas converge,
// every snapshot is valid and survives a round trip, nothing is hidden by a
// delete that had not seen all work on it (section 5.5), and purging changes
// nothing the user sees. For random junk written by a peer: reading stays total
// and the same on every replica.
//
// 40 seeds by default; set GALATSA_FUZZ_SEEDS for a long run.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MAX_DEPTH, nestingDepth, readSnapshot, validateSnapshot } from "../model/grammar.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { tidyUp } from "./document-ops.ts";
import { runScenario, scribbleJunk } from "./scenario.ts";
import { fromSnapshot, inspectDocument, toSnapshot } from "./snapshot.ts";
import { forkDoc } from "./sync.ts";
import { buildSampleDocument } from "./testing.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.GALATSA_FUZZ_SEEDS ?? 40);
const FIRST = Number(env?.GALATSA_FUZZ_FIRST ?? 1);

describe(`random scenarios: ${SEEDS} seeds from ${FIRST}`, () => {
  it(
    "converge, stay valid, and never hide work a delete had not seen",
    () => {
      const failures: string[] = [];
      const steps = new Map<string, number>();
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const result = runScenario(seed);
        failures.push(...result.failures);
        for (const [name, count] of result.steps)
          steps.set(name, (steps.get(name) ?? 0) + count);
        if (failures.length > 20) break;
      }
      expect(failures).toEqual([]);
      // The generator reaches every kind of step.
      for (const name of [
        "move",
        "reparent",
        "group",
        "dissolve",
        "delete",
        "restore",
        "type",
        "duplicate",
        "undo",
        "redo",
        "sync",
        "sync one way",
        "tidy up",
        "remove stop",
        "visit stop",
        "move visit",
      ]) {
        expect(steps.get(name) ?? 0, name).toBeGreaterThan(0);
      }
    },
    Math.max(30_000, SEEDS * 400),
  );
});

describe(`random junk from a peer: ${SEEDS} seeds`, () => {
  it(
    "reading is total, valid, stable, and the same on every replica",
    () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const doc = buildSampleDocument(new Y.Doc(), seed);
        scribbleJunk(doc, seed);
        const where = `seed ${seed}`;
        const { snapshot, problems } = inspectDocument(doc);
        expect(problems.length, where).toBeGreaterThan(0);
        expect(validateSnapshot(snapshot), where).toEqual([]);
        expect(nestingDepth(snapshot, 100_000), where).toBeLessThanOrEqual(MAX_DEPTH);
        // As another replica reads it, and as it reads back from JSON text.
        expect(toSnapshot(forkDoc(doc, 9)), where).toEqual(snapshot);
        const reparsed = readSnapshot(JSON.parse(JSON.stringify(snapshot)));
        expect(reparsed.problems, where).toEqual([]);
        expect(reparsed.snapshot, where).toEqual(snapshot);
        expect(toSnapshot(fromSnapshot(snapshot)), where).toEqual(snapshot);
        // Resolution works on it, and so does tidy up, which removes what the
        // format has no place for.
        const view = new Resolver(lookupFromRecord(snapshot.elements));
        const order = view.drawOrder();
        for (const id of order) view.bounds(id);
        tidyUp(doc);
        const after = inspectDocument(doc);
        expect(validateSnapshot(after.snapshot), where).toEqual([]);
        expect(
          // No record or record key is left that the format has no place for.
          after.problems.filter((p) =>
            /^(elements|stops|routes|assets)\.[^.]*(\.[^.]*)?: (unknown field|not a valid id|not an object|no valid element type)/.test(
              p,
            ),
          ),
          where,
        ).toEqual([]);
        expect(
          new Resolver(lookupFromRecord(after.snapshot.elements)).drawOrder(),
          where,
        ).toEqual(order);
      }
    },
    Math.max(30_000, SEEDS * 400),
  );
});
