// SPDX-License-Identifier: GPL-3.0-or-later

// Randomized test: three replicas apply random structural operations while
// exchanging state at random, then sync fully. Checks convergence and the
// invariants of docs/adr/0001-document-model-and-file-format.md, with undo and
// redo among the operations. Runs 30 seeds by
// default; set GALATSA_FUZZ_SEEDS=150 for the full run.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { purgeSnapshot } from "../model/purge.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { FRAME_TYPE } from "../model/types.ts";
import { validateSnapshot } from "../model/validate.ts";
import * as ops from "./ops.ts";
import { createUndoManager } from "./schema.ts";
import { fromSnapshot, toSnapshot, yLookup } from "./snapshot.ts";
import { forkDoc, syncDocs } from "./sync.ts";
import { seededBytes, seededRandom } from "./testing.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.GALATSA_FUZZ_SEEDS ?? 30);
const STEPS = 60;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

describe(`fuzz: ${SEEDS} seeds x 3 replicas x ${STEPS} operations`, () => {
  it("converges and keeps the invariants", () => {
    const errors = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = seededRandom(seed);
      const o = { random: rnd, randomBytes: seededBytes(seed * 7919) };
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
      const start = new Y.Doc();
      start.clientID = 1000;
      ops.initDocument(start, { id: "fuzz" }, o);
      for (let i = 0; i < 4; i++) {
        ops.addElement(
          start,
          { id: `F${i}`, type: FRAME_TYPE, x: i * 100, y: 0, size: { w: 50, h: 50 } },
          o,
        );
      }
      for (let i = 0; i < 6; i++) {
        ops.addElement(
          start,
          { id: `E${i}`, type: "x.y/z", x: i * 10, y: 5, size: { w: 5, h: 5 } },
          o,
        );
      }
      const replicas = [forkDoc(start, 1), forkDoc(start, 2), forkDoc(start, 3)];
      const undo = new Map(replicas.map((d) => [d, createUndoManager(d, 0)]));
      let groups = 0;
      for (let step = 0; step < STEPS; step++) {
        const doc = pick(replicas);
        const r = new Resolver(yLookup(doc));
        const all = [...doc.getMap("elements").keys()];
        const visible = all.filter((id) => !r.isGone(id));
        const id = pick(all);
        try {
          switch (Math.floor(rnd() * 12)) {
            case 0:
              ops.moveElement(doc, id, rnd() * 100, rnd() * 100, o);
              break;
            case 1: {
              const targets = visible.filter(
                (c) => r.isContainer(c) && !r.isWithin(c, id),
              );
              ops.reparent(
                doc,
                id,
                rnd() < 0.2 || targets.length === 0 ? null : pick(targets),
                o,
              );
              break;
            }
            case 2: {
              if (r.isGone(id)) break;
              const logical = r.logicalParentOf(id);
              const members = r
                .logicalChildren(logical)
                .filter((s) => s === id || rnd() < 0.4);
              ops.group(doc, members, { ...o, id: `G${doc.clientID}_${groups++}` });
              break;
            }
            case 3:
              if (r.isContainer(id)) ops.dissolve(doc, id, o);
              break;
            case 4:
              ops.deleteElements(doc, [id], o);
              break;
            case 5:
              ops.restoreElement(doc, id, o);
              break;
            case 6:
              if (!r.isGone(id)) ops.bringToFront(doc, id, o);
              break;
            case 7:
              if (!r.isGone(id)) ops.sendBackward(doc, id, o);
              break;
            case 8:
              ops.renameElement(doc, id, `n${step}`, o);
              break;
            case 9:
              syncDocs(pick(replicas), pick(replicas));
              break;
            case 10:
              undo.get(doc)!.undo();
              break;
            case 11:
              undo.get(doc)!.redo();
              break;
          }
        } catch (error) {
          const message = (error as Error).message.replace(/[A-Za-z0-9_-]{6,}/g, "#");
          errors.set(message, (errors.get(message) ?? 0) + 1);
        }
      }
      syncDocs(replicas[0]!, replicas[1]!);
      syncDocs(replicas[1]!, replicas[2]!);
      syncDocs(replicas[0]!, replicas[2]!);
      const snapshot = toSnapshot(replicas[0]!);
      expect(toSnapshot(replicas[1]!)).toEqual(snapshot);
      expect(toSnapshot(replicas[2]!)).toEqual(snapshot);
      expect(validateSnapshot(snapshot)).toEqual([]);
      expect(toSnapshot(fromSnapshot(snapshot))).toEqual(snapshot);

      const r = new Resolver(lookupFromRecord(snapshot.elements));
      const order = r.drawOrder();
      const shown = Object.keys(snapshot.elements).filter((k) => !r.isGone(k));
      expect(new Set(order).size).toBe(order.length);
      expect(new Set(order)).toEqual(new Set(shown));
      for (const k of shown) {
        const p = r.worldOrigin(k);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(r.logicalParentOf(k) === null || !r.isGone(r.logicalParentOf(k)!)).toBe(
          true,
        );
      }
      // Purging changes nothing the user sees.
      const purged = purgeSnapshot(snapshot);
      expect(validateSnapshot(purged)).toEqual([]);
      const pr = new Resolver(lookupFromRecord(purged.elements));
      expect(pr.drawOrder()).toEqual(order);
      for (const k of order) {
        const a = r.worldOrigin(k);
        const b = pr.worldOrigin(k);
        expect(close(a.x, b.x) && close(a.y, b.y)).toBe(true);
      }
    }
    // Operations must not fail on merged states; record what did, for diagnosis.
    expect([...errors]).toEqual([]);
  });
});
