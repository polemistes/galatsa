// SPDX-License-Identifier: GPL-3.0-or-later

// The live resolver without Yjs: random documents with every state concurrent
// edits can leave (parents that do not exist or are not containers, parent
// cycles, positions written in other spaces, pending rebases, delete marks that
// apply or not, gone containers, locks), changed one key at a time. After every
// change the live resolver must answer as a new Resolver does, and must have
// reported every element and container whose answers changed.

import { describe, expect, it } from "vitest";
import { revisionDigest } from "./digest.ts";
import { LiveResolver, type ResolvedChanges } from "./live.ts";
import { Resolver, type ElementEnvelope, type ElementLookup } from "./resolve.ts";
import { FRAME_TYPE, GROUP_TYPE, type DeleteMarks, type ElementId } from "./types.ts";

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

type Mutable = { -readonly [K in keyof ElementEnvelope]: ElementEnvelope[K] };

class MapLookup implements ElementLookup {
  readonly map = new Map<ElementId, ElementEnvelope>();
  get(id: ElementId) {
    return this.map.get(id);
  }
  ids() {
    return this.map.keys();
  }
}

const ROOT = "(root)";

function state(r: Resolver) {
  const elements = new Map<string, string>();
  const coverage = new Map<string, string>();
  const children = new Map<string, string>();
  const list = (c: ElementId | null) => {
    const text = `${r.children(c).join(" ")} | ${r.logicalChildren(c).join(" ")}`;
    if (text !== " | ") children.set(c ?? ROOT, text);
  };
  list(null);
  for (const id of r.ids()) {
    const e = r.get(id);
    if (!e) continue;
    const b = r.bounds(id);
    const l = r.localPosition(id);
    const w = r.worldOrigin(id);
    elements.set(
      id,
      [
        e.type,
        e.order,
        r.parentOf(id),
        r.logicalParentOf(id),
        `${l.x},${l.y}`,
        `${w.x},${w.y}`,
        e.size ? `${e.size.w}x${e.size.h}` : "-",
        e.rot ?? "-",
        r.isDeleted(id),
        r.isGone(id),
        r.isLocked(id),
        b ? `${b.x},${b.y},${b.w},${b.h}` : "-",
      ].join(" "),
    );
    coverage.set(id, JSON.stringify(r.coverage(id)));
    if (r.isContainer(id)) list(id);
  }
  return { elements, coverage, children, order: r.drawOrder().join(" ") };
}

const TYPES = [FRAME_TYPE, GROUP_TYPE, "x.shape/shape", FRAME_TYPE, GROUP_TYPE];

function randomDocument(rnd: () => number, n: number): MapLookup {
  const lookup = new MapLookup();
  const ids = Array.from({ length: n }, (_, i) => `e${i}`);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  for (const id of ids) {
    const type = pick(TYPES);
    lookup.map.set(id, {
      type,
      parent: rnd() < 0.2 ? null : pick([...ids, "missing"]),
      order: pick(["a0", "a1", "a2", "Zz"]),
      pos: { x: Math.floor(rnd() * 100), y: Math.floor(rnd() * 100), space: null },
      rebase: null,
      locked: rnd() < 0.1,
      rev: {},
      deleted: {},
      dissolved: rnd() < 0.1,
      purged: rnd() < 0.05,
      size: type === GROUP_TYPE ? undefined : { w: 10, h: 10 },
      rot: type === GROUP_TYPE || type === FRAME_TYPE ? undefined : 0,
    });
  }
  return lookup;
}

/** One random change of one key of one element; returns the id and key. */
function mutate(
  rnd: () => number,
  lookup: MapLookup,
  fresh: Resolver,
): [ElementId, string | null] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const ids = [...lookup.map.keys()];
  const n = ids.length;
  const id = rnd() < 0.05 ? `e${n + Math.floor(rnd() * 3)}` : pick(ids);
  const old = lookup.map.get(id);
  if (!old || rnd() < 0.03) {
    // Added, or removed from the document.
    if (old) lookup.map.delete(id);
    else
      lookup.map.set(id, {
        type: pick(TYPES),
        parent: pick([...ids, null]),
        order: "a1",
        pos: { x: 3, y: 4, space: pick([...ids, null]) },
        locked: false,
        size: { w: 5, h: 5 },
      });
    return [id, null];
  }
  const e: Mutable = { ...old };
  const space = () => (rnd() < 0.3 ? null : pick([...ids, "missing"]));
  const key = pick([
    "type",
    "parent",
    "parent",
    "order",
    "pos",
    "pos",
    "rebase",
    "rev",
    "deleted",
    "deleted",
    "dissolved",
    "purged",
    "locked",
    "size",
    "rot",
    "name",
  ]);
  switch (key) {
    case "type":
      e.type = pick(TYPES);
      break;
    case "parent":
      e.parent = rnd() < 0.15 ? null : pick([...ids, "missing", "e999"]);
      break;
    case "order":
      e.order = pick(["a0", "a1", "a2", "Zz", "a05"]);
      break;
    case "pos":
      e.pos = {
        x: Math.floor(rnd() * 100),
        y: Math.floor(rnd() * 100),
        space: rnd() < 0.5 ? fresh.parentOf(id) : space(),
      };
      break;
    case "rebase":
      e.rebase =
        rnd() < 0.2
          ? null
          : {
              to: rnd() < 0.6 ? fresh.parentOf(id) : space(),
              base: rnd() < 0.3 ? { x: e.pos.x, y: e.pos.y, dx: 7, dy: -3 } : null,
              shifts: [
                { from: space(), dx: 11, dy: 13 },
                { from: e.pos.space, dx: -5, dy: 2 },
              ],
            };
      break;
    case "rev": {
      const rev = { ...(e.rev ?? {}) };
      rev[pick(["w1", "w2"])] = Math.floor(rnd() * 3);
      e.rev = rev;
      break;
    }
    case "deleted": {
      const marks: DeleteMarks = { ...(e.deleted ?? {}) };
      if (rnd() < 0.3) {
        delete marks[pick(Object.keys(marks).concat("m0"))];
      } else {
        // A mark that lists what the element holds now, mostly with the right
        // revisions.
        const seen: { [id: string]: string } = {};
        const list = (at: ElementId) => {
          seen[at] = rnd() < 0.85 ? fresh.digestOf(at) : revisionDigest({ old: 1 });
        };
        list(id);
        for (const inside of fresh.descendants(id)) if (rnd() < 0.9) list(inside);
        marks[pick(["m0", "m1", "m2"])] = { seen };
      }
      e.deleted = marks;
      break;
    }
    case "dissolved":
      e.dissolved = !e.dissolved;
      break;
    case "purged":
      e.purged = !e.purged;
      break;
    case "locked":
      e.locked = !e.locked;
      break;
    case "size":
      e.size = e.type === GROUP_TYPE ? undefined : { w: Math.floor(rnd() * 50), h: 9 };
      break;
    case "rot":
      e.rot = e.type === GROUP_TYPE || e.type === FRAME_TYPE ? undefined : rnd() * 3;
      break;
    default:
      break;
  }
  lookup.map.set(id, e);
  return [id, key];
}

/** Whether a touch changed more than bookkeeping (must then be reported). */
function worked(keys: Set<string> | null | undefined): boolean {
  if (keys === undefined) return false;
  return keys === null || [...keys].some((k) => k !== "rev" && k !== "deleted");
}

function check(
  before: ReturnType<typeof state>,
  after: ReturnType<typeof state>,
  live: ReturnType<typeof state>,
  changes: ResolvedChanges,
  touched: ReadonlyMap<ElementId, Set<string> | null>,
): string[] {
  const out: string[] = [];
  for (const [id, text] of after.elements) {
    if (live.elements.get(id) !== text)
      out.push(`${id}: live "${live.elements.get(id)}", anew "${text}"`);
    const was = before.elements.get(id);
    if (was === undefined) {
      if (!changes.added.has(id)) out.push(`${id} added, not reported`);
    } else if ((was !== text || worked(touched.get(id))) && !changes.changed.has(id)) {
      out.push(`${id} changed, not reported`);
    }
  }
  for (const id of live.elements.keys())
    if (!after.elements.has(id)) out.push(`${id} only in the live resolver`);
  for (const [id, text] of after.coverage)
    if (live.coverage.get(id) !== text) out.push(`coverage of ${id} differs`);
  for (const id of before.elements.keys())
    if (!after.elements.has(id) && !changes.removed.has(id))
      out.push(`${id} removed, not reported`);
  for (const key of new Set([...after.children.keys(), ...live.children.keys()])) {
    if (after.children.get(key) !== live.children.get(key))
      out.push(
        `children of ${key}: live "${live.children.get(key)}", anew "${after.children.get(key)}"`,
      );
  }
  for (const key of new Set([...before.children.keys(), ...after.children.keys()])) {
    if (before.children.get(key) === after.children.get(key)) continue;
    if (!changes.containers.has(key === ROOT ? null : key))
      out.push(`children of ${key} changed, not reported`);
  }
  if (live.order !== after.order) out.push("drawing order differs");
  if (before.order !== after.order && !changes.drawOrder)
    out.push("drawing order changed, not reported");
  return out;
}

describe("the live resolver, on random states", () => {
  it("answers as a new Resolver after every change, and reports what changed", () => {
    const failures: string[] = [];
    let reported = 0;
    let differed = 0;
    for (let seed = 1; seed <= 60 && failures.length === 0; seed++) {
      const rnd = seeded(seed * 7717);
      const lookup = randomDocument(rnd, 8 + Math.floor(rnd() * 25));
      const live = new LiveResolver(lookup);
      let before = state(new Resolver(lookup));
      for (let step = 0; step < 150 && failures.length === 0; step++) {
        // One to three changes, taken in as one (one transaction).
        const touched = new Map<ElementId, Set<string> | null>();
        for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
          const [id, key] = mutate(rnd, lookup, new Resolver(lookup));
          const keys = touched.get(id);
          if (key === null || keys === null) touched.set(id, null);
          else touched.set(id, new Set([...(keys ?? []), key]));
        }
        const changes = live.update(touched);
        const after = state(new Resolver(lookup));
        const what = [...touched].map(
          ([id, keys]) => `${id} ${keys ? [...keys] : "record"}`,
        );
        for (const f of check(before, after, state(live), changes, touched))
          failures.push(`seed ${seed} step ${step} (${what.join("; ")}): ${f}`);
        reported += changes.added.size + changes.changed.size + changes.removed.size;
        for (const [e, text] of after.elements)
          if (before.elements.get(e) !== text) differed++;
        before = after;
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // What is reported is not everything every time.
    expect(reported).toBeLessThan(differed * 4);
  });

  it("rebuilds from scratch after changes it was not told about", () => {
    const rnd = seeded(99);
    const lookup = randomDocument(rnd, 30);
    const live = new LiveResolver(lookup);
    for (let i = 0; i < 40; i++) mutate(rnd, lookup, new Resolver(lookup));
    const changes = live.rebuild();
    const fresh = state(new Resolver(lookup));
    const now = state(live);
    expect(now.elements).toEqual(fresh.elements);
    expect(now.children).toEqual(fresh.children);
    expect(now.order).toEqual(fresh.order);
    expect(changes.drawOrder).toBe(true);
    expect(changes.added.size + changes.changed.size).toBe(fresh.elements.size);
  });

  it("calls subscribers only when something changed, and not after they stop", () => {
    const lookup = randomDocument(seeded(3), 10);
    const live = new LiveResolver(lookup);
    const calls: ResolvedChanges[] = [];
    const stop = live.subscribe((c) => calls.push(c));
    const e = { ...lookup.map.get("e1")! };
    lookup.map.set("e1", { ...e, rev: { w9: 1 } });
    live.update(new Map([["e1", new Set(["rev"])]]));
    lookup.map.set("e1", { ...e, pos: { ...e.pos, x: e.pos.x + 1 } });
    live.update(new Map([["e1", new Set(["pos"])]]));
    stop();
    lookup.map.set("e1", { ...e, pos: { ...e.pos, x: e.pos.x + 2 } });
    live.update(new Map([["e1", new Set(["pos"])]]));
    expect(calls.length).toBe(1);
    expect(calls[0]!.changed.has("e1")).toBe(true);
  });
});
