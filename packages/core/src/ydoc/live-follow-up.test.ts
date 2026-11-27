// SPDX-License-Identifier: GPL-3.0-or-later

// Random operations where other listeners (an
// 'afterTransaction' listener and a deep observer) write follow-up
// transactions into the same batch, touching the same records again (move
// twice, parent changed and set back, delete and restore, records removed and
// written again). The live resolver is checked after every batch. 40 seeds by
// default; GALATSA_FUZZ_SEEDS for a long run.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { GROUP_TYPE, FRAME_TYPE } from "../model/types.ts";
import { watchLiveResolver } from "./live-check.ts";
import { liveResolver } from "./live.ts";
import * as ops from "./ops.ts";
import { forkDoc, syncInto } from "./sync.ts";
import { createUndoManager, noteWork } from "./track.ts";

const SHAPE = "galatsa.shapes/shape";

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.GALATSA_FUZZ_SEEDS ?? 40);

describe("follow-up writes in the same batch", () => {
  it("keeps the live resolver equal to a new resolution", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS && failures.length === 0; seed++) {
      const rnd = seeded(seed * 104729);
      const int = (n: number) => Math.floor(rnd() * n);
      const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
      const start = new Y.Doc();
      start.clientID = 10;
      ops.initDocument(start, { id: `d${seed}` });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ops.addElement(start, {
          id: `F${i}`,
          type: FRAME_TYPE,
          parent: i > 0 && rnd() < 0.5 ? `F${int(i)}` : null,
          x: int(100),
          y: int(100),
          size: { w: 100, h: 100 },
        });
        ids.push(`F${i}`);
      }
      for (let i = 0; i < 6; i++) {
        ops.addElement(start, {
          id: `E${i}`,
          type: SHAPE,
          parent: rnd() < 0.7 ? pick(ids.slice(0, 4)) : null,
          x: int(50),
          y: int(50),
          size: { w: 5, h: 5 },
        });
        ids.push(`E${i}`);
      }
      const doc = forkDoc(start, 1);
      const other = forkDoc(start, 2);
      let step = 0;
      let where = "";
      const stop = watchLiveResolver(doc, (m) =>
        failures.push(`seed ${seed} step ${step} ${where}: ${m}`),
      );
      const live = liveResolver(doc);
      const undo = createUndoManager(doc, { captureTimeout: 0 });
      const elements = doc.getMap("elements") as Y.Map<Y.Map<unknown>>;
      const containers = () =>
        ids.filter((id) => {
          const t = elements.get(id)?.get("type");
          return t === FRAME_TYPE || t === GROUP_TYPE;
        });
      let depth = 0;
      // Reads the live resolver in the middle of a batch, as an editor binding
      // in an observer might: this must not leave anything wrong behind.
      const poke = () => {
        try {
          for (let i = 0; i < 3; i++) {
            const id = pick([...live.ids()]);
            live.worldOrigin(id);
            live.isGone(id);
            live.isLocked(id);
            live.bounds(id);
            live.logicalChildren(id);
            live.coverage(id);
            live.digestOf(id);
            live.slotIn(id, null);
          }
          live.drawOrder();
        } catch (error) {
          failures.push(
            `seed ${seed} step ${step}: mid-batch read threw ${String(error)}`,
          );
        }
      };
      const randomOp = (d: Y.Doc, raw: boolean) => {
        const map = d.getMap("elements") as Y.Map<Y.Map<unknown>>;
        const id = pick(ids);
        const record = map.get(id);
        const k = int(raw ? 14 : 10);
        try {
          switch (k) {
            case 0:
              ops.moveElement(d, id, int(200), int(200));
              break;
            case 1:
              ops.reparent(d, id, rnd() < 0.3 ? null : pick(containers()));
              break;
            case 2:
              ops.deleteElements(d, [id]);
              break;
            case 3:
              ops.restoreElement(d, id);
              break;
            case 4:
              ops.setLocked(d, id, rnd() < 0.5);
              break;
            case 5:
              ops.dissolve(d, pick(containers()));
              break;
            case 6: {
              const g = ops.group(d, [id]);
              ids.push(g);
              break;
            }
            case 7:
              ops.bringToFront(d, id);
              break;
            case 8:
              d.transact(() => {
                ops.moveElement(d, id, int(200), int(200));
                if (d === doc) poke();
                ops.reparent(d, pick(ids), pick(containers()));
                if (d === doc) poke();
                ops.deleteElements(d, [pick(ids)]);
                if (d === doc) poke();
              });
              break;
            case 9:
              ops.resizeElement(d, id, 1 + int(90), 1 + int(90));
              break;
            // Raw writes, as an editor binding or a peer might make them.
            case 10:
              if (record) d.transact(() => record.set("parent", pick([...ids, "zz"])));
              break;
            case 11:
              if (record)
                d.transact(() =>
                  record.set("pos", {
                    x: int(99),
                    y: int(99),
                    space: pick([...ids, null]),
                  }),
                );
              break;
            case 12:
              if (record) d.transact(() => noteWork(d, record, true));
              break;
            case 13:
              if (record && rnd() < 0.5) {
                // Removed and written again (another record under the same id).
                const copy = new Y.Map<unknown>();
                d.transact(() => {
                  for (const [key, value] of record.entries())
                    copy.set(
                      key,
                      value instanceof Y.AbstractType ? value.clone() : value,
                    );
                  map.set(id, copy);
                });
              } else if (record) d.transact(() => map.delete(id));
              break;
          }
        } catch {
          // Operations refuse some random requests (cycles, missing elements).
        }
      };
      doc.on("afterTransaction", (tr: Y.Transaction) => {
        if (rnd() < 0.5) poke();
        if (depth >= 2 || tr.origin === "sync" || rnd() < 0.5) return;
        depth++;
        try {
          randomOp(doc, true);
        } finally {
          depth--;
        }
      });
      elements.observeDeep(() => {
        if (rnd() < 0.5) poke();
        if (depth >= 2 || rnd() < 0.7) return;
        depth++;
        try {
          randomOp(doc, true);
        } finally {
          depth--;
        }
      });
      for (step = 0; step < 60 && failures.length === 0; step++) {
        const c = int(10);
        where = `top ${c}`;
        try {
          if (c < 6) randomOp(doc, false);
          else if (c === 6) undo.undo();
          else if (c === 7) undo.redo();
          else if (c === 8) {
            randomOp(other, true);
            syncInto(doc, other);
          } else syncInto(other, doc);
        } catch (error) {
          failures.push(`seed ${seed} step ${step}: threw ${String(error)}`);
        }
      }
      stop();
      expect(live).toBe(liveResolver(doc));
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 600_000);
});
