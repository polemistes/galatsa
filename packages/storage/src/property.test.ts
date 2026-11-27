// SPDX-License-Identifier: GPL-3.0-or-later

// Round trips through the storage layer on the random scenarios of
// @galatsa/core/testing: whatever a session holds when its program stops is
// what the next start opens, through journal entries, checkpoints, crashes and
// reopenings, as for the file format's own property test.
//
// 15 seeds by default; set GALATSA_FUZZ_SEEDS for a long run.

import { addElement, deleteElements, syncInto, toSnapshot } from "@galatsa/core/ydoc";
import { runScenario, seededRandom } from "@galatsa/core/testing";
import { writeGalatsaFile } from "@galatsa/format";
import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { StorageSession } from "./session.ts";
import type { OpenResult } from "./storage.ts";
import { machine, program } from "./test-helpers.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.["GALATSA_FUZZ_SEEDS"] ?? 15);
const FIRST = Number(env?.["GALATSA_FUZZ_FIRST"] ?? 1);

function opened(result: OpenResult): StorageSession {
  if (!result.ok) throw new Error(`open failed: ${result.problem.code}`);
  return result.session;
}

describe(`documents stored during random scenarios: ${SEEDS} seeds from ${FIRST}`, () => {
  it(
    "reopen as the same document after every crash",
    async () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const random = seededRandom(seed * 31 + 7);
        const states: Y.Doc[] = [];
        const result = runScenario(seed, { checkpoint: (doc) => states.push(doc) });
        expect(result.failures).toEqual([]);
        // The scenario's replicas at its checkpoints (live objects: they keep
        // changing, which only makes each sync bring more).
        const m = machine();
        let p = program(m);
        const first = await p.storage.importFile(
          writeGalatsaFile(states[0]!, () => undefined).bytes,
        );
        let session = opened(first);
        const slot = session.slot;
        for (const [i, replica] of states.entries()) {
          const where = `seed ${seed}, step ${i}`;
          syncInto(session.doc, replica);
          // A local edit too, so the journal holds work of this session.
          if (random() < 0.3) {
            const id = addElement(session.doc, {
              type: "test.shapes/box",
              x: i,
              y: seed,
              size: { w: 1, h: 1 },
            });
            if (random() < 0.5) deleteElements(session.doc, [id]);
          }
          const action = random();
          if (action < 0.4) await session.flush();
          else if (action < 0.7) await session.checkpoint();
          else await p.scheduler.advance(1500);
          if (random() < 0.4) {
            // Stop without closing, after everything was journaled, and start again.
            await session.flush();
            const expected = toSnapshot(session.doc);
            p.crash(session);
            p = program(m);
            const offers = await p.storage.recoverable();
            if (offers.length > 0)
              expect(
                offers.map((o) => o.slot),
                where,
              ).toEqual([slot]);
            session = opened(await p.storage.open(slot));
            expect(toSnapshot(session.doc), where).toEqual(expected);
          }
        }
        // Finally a clean close, and the same again.
        const expected = toSnapshot(session.doc);
        await session.close();
        const last = opened(await program(m).storage.open(slot));
        expect(toSnapshot(last.doc), `seed ${seed}`).toEqual(expected);
        // Never more than the newest checkpoint and the last good one.
        const checkpoints = [...m.store.data.keys()].filter((k) => k.includes("/cp/"));
        expect(checkpoints.length, `seed ${seed}`).toBeLessThanOrEqual(2);
      }
    },
    Math.max(60_000, SEEDS * 4000),
  );
});
