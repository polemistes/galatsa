// SPDX-License-Identifier: GPL-3.0-or-later

// Property tests. For random documents and random sequences of operations
// (including typing through an editor binding, undo and redo, tidy up and
// partial syncs across three replicas), see scenario.ts: the replicas converge,
// every snapshot is valid and survives a round trip, nothing is hidden by a
// delete that had not seen all work on it (section 5.5), and purging changes
// nothing the user sees. For random junk written by a peer: reading stays total
// and the same on every replica.
//
// 40 seeds of 80 steps by default; set GALATSA_FUZZ_SEEDS (and GALATSA_FUZZ_FIRST,
// GALATSA_FUZZ_STEPS) for a long run.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_DEPTH,
  nestingDepth,
  readSnapshot,
  validateSnapshot,
} from "../model/grammar.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { tidyUp } from "./document-ops.ts";
import { runScenario, scribbleJunk } from "./scenario.ts";
import { fromSnapshot, inspectDocument, toSnapshot } from "./snapshot.ts";
import { forkDoc } from "./sync.ts";
import { buildSampleDocument, seededRandom } from "./testing.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.GALATSA_FUZZ_SEEDS ?? 40);
const FIRST = Number(env?.GALATSA_FUZZ_FIRST ?? 1);
const STEPS = Number(env?.GALATSA_FUZZ_STEPS ?? 80);

describe(`random scenarios: ${SEEDS} seeds from ${FIRST}`, () => {
  it(
    "converge, stay valid, and never hide work a delete had not seen",
    () => {
      const failures: string[] = [];
      const steps = new Map<string, number>();
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const result = runScenario(seed, { steps: STEPS });
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
        "command",
      ]) {
        expect(steps.get(name) ?? 0, name).toBeGreaterThan(0);
      }
    },
    Math.max(30_000, SEEDS * STEPS * 5),
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
            /^((elements|stops|routes)\.[^.]*(\.[^.]*)?|assets\.[^.]*): (unknown field|not a valid id|not an object|no valid element type)/.test(
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

/** JSON a damaged or hostile file might hold in place of anything. */
function jsonJunk(rnd: () => number, depth = 0): unknown {
  const simple = [
    null,
    true,
    0,
    -3,
    2.5,
    1e300,
    "",
    "a0",
    "a b",
    "__proto__",
    "x\uD800",
    "sha256-" + "e".repeat(64),
    "core/frame",
  ];
  const roll = Math.floor(rnd() * 20);
  if (depth > 4 || roll < 7) return simple[Math.floor(rnd() * simple.length)];
  const inner = () => jsonJunk(rnd, depth + 1);
  switch (roll) {
    case 7:
      return [inner(), inner()];
    case 8:
      return { [String(inner())]: inner(), k: inner() };
    case 9:
      return {
        $y: "text",
        delta: [
          { insert: inner() },
          { insert: "a" },
          { insert: "b", attributes: inner() },
          inner(),
        ],
        attributes: inner(),
      };
    case 10:
      return { $y: "map", entries: { a: inner(), __proto__: inner() } };
    case 11:
      return { $y: "array", items: [inner(), { $y: "any", value: { u: 1 } }, inner()] };
    case 12:
      return {
        $y: "any",
        value: [
          { u: 1 },
          { b: "QQ==" },
          { i: "12" },
          { n: "NaN" },
          { a: [1, { u: 1 }] },
          { o: { k: { i: "-5" } } },
          { i: "99999999999999999999" },
          { b: "QR==" },
          inner(),
        ][Math.floor(rnd() * 9)],
      };
    case 13:
      return { $y: "json", value: inner() };
    case 14:
      return { $y: "unsupported", note: "n", raw: inner() };
    case 15:
      return {
        $y: "xmlFragment",
        children: [
          {
            $y: "xmlElement",
            name: "",
            attributes: { a: inner() },
            children: [inner(), { $y: "xmlText", delta: [{ insert: inner() }] }],
          },
          { $y: "xmlHook", hookName: "h", entries: { e: inner() } },
        ],
      };
    case 16:
      return { $y: ["hologram", 5, null, "text"][Math.floor(rnd() * 4)], extra: inner() };
    case 17:
      return {
        x: inner(),
        y: 2,
        w: inner(),
        h: 3,
        space: inner(),
        kind: ["rect", "frame", "orbit"][Math.floor(rnd() * 3)],
        frame: inner(),
        action: ["show", "spin"][Math.floor(rnd() * 2)],
        stop: inner(),
        seen: inner(),
        ext: inner(),
      };
    default:
      return { deep: { deeper: inner() } };
  }
}

describe(`random junk in a document's JSON: ${SEEDS} seeds`, () => {
  it(
    "reads as a valid document that every part of the code agrees on",
    () => {
      const base = toSnapshot(buildSampleDocument(new Y.Doc(), 1));
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const rnd = seededRandom(seed * 53);
        const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
        const document = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        for (let step = 0; step < 30; step++) {
          // Walk down a random path and replace or add something there.
          let at: Record<string, unknown> = document;
          for (let level = 0; level < 1 + Math.floor(rnd() * 5); level++) {
            const keys = Object.keys(at).filter(
              (k) => typeof at[k] === "object" && at[k] !== null,
            );
            if (keys.length === 0) break;
            at = at[pick(keys)] as Record<string, unknown>;
          }
          const keys = Object.keys(at);
          const key = rnd() < 0.3 || keys.length === 0 ? pick(KEY_NAMES) : pick(keys);
          if (rnd() < 0.1) delete at[key];
          else
            Object.defineProperty(at, key, {
              value: jsonJunk(rnd),
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
        const where = `seed ${seed}`;
        const text = JSON.stringify(document);
        const first = readSnapshot(JSON.parse(text));
        if (first.snapshot === null) continue;
        const snapshot = first.snapshot;
        expect(nestingDepth(snapshot, 100_000), where).toBeLessThanOrEqual(MAX_DEPTH);
        const second = readSnapshot(JSON.parse(JSON.stringify(snapshot)));
        expect(second.problems, where).toEqual([]);
        expect(second.snapshot, where).toEqual(snapshot);
        // Through Yjs and back, also as another replica gets it.
        const doc = fromSnapshot(snapshot);
        expect(toSnapshot(doc), where).toEqual(snapshot);
        expect(toSnapshot(forkDoc(doc, 4)), where).toEqual(snapshot);
        expect(inspectDocument(doc).problems, where).toEqual([]);
        const view = new Resolver(lookupFromRecord(snapshot.elements));
        for (const id of view.drawOrder()) view.bounds(id);
      }
    },
    Math.max(30_000, SEEDS * 400),
  );
});

const KEY_NAMES = [
  "type",
  "parent",
  "order",
  "pos",
  "rebase",
  "size",
  "rev",
  "deleted",
  "refs",
  "ext",
  "data",
  "view",
  "notes",
  "visibility",
  "entries",
  "surprise",
  "__proto__",
  "schemaVersion",
  "id",
  "badId!",
];
