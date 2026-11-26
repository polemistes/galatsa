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
import { runScenario } from "./scenario.ts";
import { fromSnapshot, inspectDocument, toSnapshot } from "./snapshot.ts";
import { forkDoc } from "./sync.ts";
import { buildSampleDocument, seededRandom } from "./testing.ts";

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

/** Things a faulty or hostile peer might store anywhere. */
function junk(rnd: () => number, depth = 0): unknown {
  const value = anything(rnd, depth);
  // Yjs itself refuses these directly in a shared map or array, not nested.
  return typeof value === "function" || typeof value === "bigint" || value instanceof Date
    ? [value]
    : value;
}

function encodable(value: unknown): unknown {
  if (typeof value === "bigint") return 1;
  return Array.isArray(value) ? value.map(encodable) : value;
}

function anything(rnd: () => number, depth: number): unknown {
  const simple = [
    null,
    undefined,
    true,
    0,
    -0,
    -5,
    1.5,
    Number.NaN,
    Infinity,
    "",
    "a b",
    "__proto__",
    "a0",
    "x\uD800",
    10n,
    2n ** 80n,
    new Uint8Array([1, 2]),
    new Date(0),
    () => 1,
    "sha256-" + "f".repeat(64),
  ];
  const roll = Math.floor(rnd() * 16);
  if (depth > 3 || roll < 8) return simple[Math.floor(rnd() * simple.length)];
  if (roll === 8) return [junk(rnd, depth + 1), junk(rnd, depth + 1)];
  if (roll === 9) {
    return JSON.parse(
      `{"__proto__": 1, "$y": ${JSON.stringify(
        ["text", "map", "any", "json", "unsupported", "hologram", 5][Math.floor(rnd() * 7)],
      )}, "delta": [], "note": "n", "value": {"u": 2}}`,
    );
  }
  if (roll === 10) return { x: junk(rnd, depth + 1), y: 1, w: junk(rnd, depth + 1), space: junk(rnd, depth + 1) };
  if (roll === 11) {
    const map = new Y.Map<unknown>();
    map.set(String(junk(rnd, 9)), junk(rnd, depth + 1));
    map.set("seen", junk(rnd, depth + 1));
    return map;
  }
  if (roll === 12) {
    const text = new Y.Text();
    text.applyDelta([
      { insert: "ab" },
      { insert: [1, { a: undefined }] as unknown as object },
      // (A big integer here cannot be encoded by Yjs at all, so no peer can send it.)
      { insert: "c", attributes: { k: encodable(junk(rnd, 9)) ?? 1 } },
    ]);
    return text;
  }
  if (roll === 13) {
    const array = new Y.Array<unknown>();
    // (Yjs refuses undefined directly in an array.)
    array.push([junk(rnd, depth + 1) ?? null, junk(rnd, depth + 1) ?? 0]);
    return array;
  }
  if (roll === 14) {
    const fragment = new Y.XmlFragment();
    const element = new Y.XmlElement(String(junk(rnd, 9) ?? ""));
    fragment.insert(0, [element, new Y.XmlText("t")]);
    element.setAttribute("a", junk(rnd, depth + 1) as string);
    return fragment;
  }
  return { nested: { deep: junk(rnd, depth + 1) } };
}

const KEYS = [
  "type",
  "typeVersion",
  "parent",
  "order",
  "pos",
  "rebase",
  "size",
  "rot",
  "name",
  "locked",
  "rev",
  "deleted",
  "dissolved",
  "refs",
  "ext",
  "data",
  "view",
  "notes",
  "visibility",
  "transition",
  "entries",
  "surprise",
  "__proto__",
];

describe(`random junk from a peer: ${SEEDS} seeds`, () => {
  it(
    "reading is total, valid, stable, and the same on every replica",
    () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const rnd = seededRandom(seed * 31);
        const doc = buildSampleDocument(new Y.Doc(), seed);
        const tables = ["elements", "stops", "routes", "assets", "settings", "meta"];
        for (let step = 0; step < 25; step++) {
          doc.transact(() => {
            const table = doc.getMap<unknown>(tables[Math.floor(rnd() * tables.length)]!);
            const ids = [...table.keys()];
            const roll = rnd();
            const key = KEYS[Math.floor(rnd() * KEYS.length)]!;
            if (roll < 0.15 || ids.length === 0) {
              table.set(rnd() < 0.5 ? `junk${step}` : String(junk(rnd, 9)), junk(rnd));
              return;
            }
            const record = table.get(ids[Math.floor(rnd() * ids.length)]!);
            if (!(record instanceof Y.Map)) return;
            const inner = record.get(key);
            if (inner instanceof Y.Map && rnd() < 0.6) {
              inner.set(rnd() < 0.5 ? "k" : String(junk(rnd, 9)), junk(rnd));
            } else if (rnd() < 0.1) record.delete(key);
            else record.set(key, junk(rnd));
          }, "remote-peer");
        }
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
