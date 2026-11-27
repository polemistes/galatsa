// SPDX-License-Identifier: GPL-3.0-or-later

// Incremental updates of the scene tree compared with a tree built from scratch,
// after random changes, for the ids a caller may report: every id, or the ids
// whose resolution changed (what a live resolver reports).

import {
  FRAME_TYPE,
  GROUP_TYPE,
  lookupFromRecord,
  Resolver,
  type Element,
  type ElementId,
  type Rect,
} from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { sceneFromSnapshot, type SceneSource } from "./scene.ts";
import { SceneTree, type SceneNode } from "./scene-tree.ts";
import { box, RECT } from "./test-support.ts";

type Elements = { [id: ElementId]: Element };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const area = (node: SceneNode): Rect => ({ x: -1, y: -1, w: node.w + 2, h: node.h + 2 });

function snapshotTree(tree: SceneTree) {
  const nodes: Record<string, unknown> = {};
  for (const [id, n] of [...tree.nodes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    nodes[id] = {
      parent: n.parent,
      rank: n.rank,
      gone: n.gone,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      rot: n.rot,
      bounds: n.bounds,
      ids: n.container?.ids,
    };
  }
  return { root: tree.root.ids, nodes };
}

/** What a full query of every container returns, in order. */
function queryAll(tree: SceneTree, rect: Rect): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (id: ElementId | null) => {
    const c = tree.container(id);
    if (!c) return;
    out[String(id)] = tree.visibleChildren(c, rect, 0).map((n) => n.id);
    for (const child of c.ids) if (tree.nodes.get(child)?.container) walk(child);
  };
  walk(null);
  return out;
}

/** Ids whose resolution or record differs between two states, plus containers whose children differ. */
function changedIds(before: Elements, after: Elements): ElementId[] {
  const a = new Resolver(lookupFromRecord(before));
  const b = new Resolver(lookupFromRecord(after));
  const ids = new Set<ElementId>([
    ...(Object.keys(before) as ElementId[]),
    ...(Object.keys(after) as ElementId[]),
  ]);
  const out: ElementId[] = [];
  for (const id of ids) {
    const x = before[id];
    const y = after[id];
    if (!x || !y || x !== y) {
      out.push(id);
      continue;
    }
    const pa = a.localPosition(id);
    const pb = b.localPosition(id);
    if (
      a.parentOf(id) !== b.parentOf(id) ||
      a.isGone(id) !== b.isGone(id) ||
      pa.x !== pb.x ||
      pa.y !== pb.y ||
      a.children(id).join() !== b.children(id).join()
    )
      out.push(id);
  }
  return out;
}

function mutate(els: Elements, r: () => number, nextId: () => ElementId): Elements {
  const out = { ...els };
  const ids = Object.keys(out) as ElementId[];
  const containers = ids.filter(
    (id) => out[id]!.type === FRAME_TYPE || out[id]!.type === GROUP_TYPE,
  );
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]!;
  const id = pick(ids);
  const e = out[id]!;
  const k = Math.floor(r() * 9);
  switch (k) {
    case 0: // move
      out[id] = {
        ...e,
        pos: { ...e.pos, x: e.pos.x + (r() - 0.5) * 200, y: e.pos.y + (r() - 0.5) * 200 },
      };
      break;
    case 1: {
      // reparent (position written in the new parent's space)
      const p = r() < 0.2 ? null : pick(containers);
      if (p === id) break;
      out[id] = {
        ...e,
        parent: p ?? null,
        pos: { x: r() * 300, y: r() * 300, space: p ?? null },
      };
      break;
    }
    case 2: // resize
      if ("size" in e && e.size)
        out[id] = { ...e, size: { w: 1 + r() * 200, h: 1 + r() * 200 } } as Element;
      break;
    case 3: // rotate
      if (e.type !== FRAME_TYPE && e.type !== GROUP_TYPE)
        out[id] = { ...e, rot: r() * 6 } as Element;
      break;
    case 4: // restack
      out[id] = {
        ...e,
        order: `k${Math.floor(r() * 1e8)
          .toString()
          .padStart(8, "0")}`,
      };
      break;
    case 5: // dissolve / undissolve a container
      if (e.type === FRAME_TYPE || e.type === GROUP_TYPE)
        out[id] = { ...e, dissolved: !e.dissolved };
      break;
    case 6: // remove the record
      delete out[id];
      break;
    case 7: {
      // add
      const p = r() < 0.3 ? null : pick(containers);
      const type = r() < 0.15 ? FRAME_TYPE : r() < 0.1 ? GROUP_TYPE : RECT;
      out[nextId()] = box(type, r() * 500, r() * 500, 1 + r() * 50, 1 + r() * 50, {
        parent: p ?? null,
        ...(type === FRAME_TYPE && r() < 0.5 ? { data: { clip: true } } : {}),
      });
      break;
    }
    case 8: // clip toggle on a frame
      if (e.type === FRAME_TYPE)
        out[id] = { ...e, data: { ...e.data, clip: e.data["clip"] !== true } };
      break;
  }
  return out;
}

function initial(r: () => number, nextId: () => ElementId): Elements {
  const out: Elements = {};
  const containers: ElementId[] = [];
  for (let i = 0; i < 60; i++) {
    const p =
      containers.length > 0 && r() < 0.5
        ? containers[Math.floor(r() * containers.length)]!
        : null;
    const type = i < 6 ? (i % 2 === 0 ? FRAME_TYPE : GROUP_TYPE) : RECT;
    const id = nextId();
    out[id] = box(type, r() * 1000, r() * 1000, 1 + r() * 100, 1 + r() * 100, {
      parent: p,
    });
    if (type !== RECT) containers.push(id);
  }
  return out;
}

describe("incremental scene tree updates", () => {
  for (const mode of ["resolved-diff", "all"] as const) {
    it(`matches a fresh tree after random changes (${mode})`, () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed);
        let n = 0;
        const nextId = () => `e${n++}` as ElementId;
        let els = initial(r, nextId);
        const tree = new SceneTree(sceneFromSnapshot({ elements: els }), area);
        for (let step = 0; step < 15; step++) {
          const next = mutate(els, r, nextId);
          const ids =
            mode === "all"
              ? ([...new Set([...Object.keys(els), ...Object.keys(next)])] as ElementId[])
              : changedIds(els, next);
          const source: SceneSource = sceneFromSnapshot({ elements: next });
          tree.apply(ids, source);
          els = next;
          const fresh = new SceneTree(sceneFromSnapshot({ elements: els }), area);
          const big = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 };
          try {
            expect(snapshotTree(tree)).toEqual(snapshotTree(fresh));
            expect(queryAll(tree, big)).toEqual(queryAll(fresh, big));
          } catch (e) {
            failures.push(`seed ${seed} step ${step}: ${String(e).slice(0, 300)}`);
            break;
          }
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }
});
