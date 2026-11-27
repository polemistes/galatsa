// SPDX-License-Identifier: GPL-3.0-or-later

// Culling: exactly the elements whose drawn area meets the view are drawn, in
// drawing order; elements under half a device pixel are left out; the tree kept
// up to date from changed ids matches one built from scratch.

import { FRAME_TYPE, GROUP_TYPE, type Element, type ElementId } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { SceneTree } from "./scene-tree.ts";
import { SpatialIndex } from "./spatial.ts";
import {
  box,
  CIRCLE_STROKE,
  RECT,
  RecordingContext,
  record,
  testHost,
} from "./test-support.ts";

/** A small deterministic generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("spatial index", () => {
  it("finds the same entries as a linear scan, for mixed sizes", () => {
    const random = rng(7);
    const index = new SpatialIndex<number>();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let i = 0; i < 3000; i++) {
      const size = 2 ** (random() * 16);
      const r = {
        x: random() * 100000 - 50000,
        y: random() * 60000,
        w: size,
        h: size * random(),
      };
      rects.push(r);
      index.set(i, r);
    }
    // Move and remove some.
    for (let i = 0; i < 300; i++) {
      const r = { ...rects[i]!, x: rects[i]!.x + 1000 };
      rects[i] = r;
      index.set(i, r);
    }
    for (let i = 300; i < 400; i++) index.delete(i);
    for (let q = 0; q < 200; q++) {
      const w = 2 ** (random() * 18);
      const query = { x: random() * 100000 - 50000, y: random() * 60000, w, h: w * 0.6 };
      const minSize = random() < 0.5 ? 0 : 2 ** (random() * 10);
      const found: number[] = [];
      index.query(query, (v) => found.push(v), minSize);
      const expected = rects
        .map((r, i) => [r, i] as const)
        .filter(
          ([r, i]) =>
            (i < 300 || i >= 400) &&
            r.x <= query.x + query.w &&
            query.x <= r.x + r.w &&
            r.y <= query.y + query.h &&
            query.y <= r.y + r.h &&
            Math.max(r.w, r.h) >= minSize,
        )
        .map(([, i]) => i);
      expect(found.sort((a, b) => a - b)).toEqual(expected);
    }
  });
});

describe("culling", () => {
  // A grid of 40 x 40 rectangles of 10 units, 20 units apart, at the root.
  const list: Array<[ElementId, Element]> = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 40; j++)
      list.push([`r${i}-${j}`, box(RECT, i * 20, j * 20, 10, 10)]);
  const elements = record(list);

  function draw(camera: { cx: number; cy: number; zoom: number }, dpr = 1) {
    const { host, drawn } = testHost();
    const renderer = new CanvasRenderer({ host });
    renderer.attach(new RecordingContext(), {
      width: 400,
      height: 300,
      devicePixelRatio: dpr,
    });
    renderer.setScene(sceneFromSnapshot({ elements }));
    renderer.setCamera({ space: null, ...camera });
    renderer.render();
    return drawn;
  }

  it("draws exactly what meets the view, back to front", () => {
    const camera = { cx: 400, cy: 400, zoom: 2 };
    const drawn = draw(camera);
    // The view: 200 x 150 units around (400, 400), plus the cull margin.
    const expected = list
      .filter(([, e]) => {
        const x = e.pos.x;
        const y = e.pos.y;
        return x + 10 >= 300 - 1 && x <= 500 + 1 && y + 10 >= 325 - 1 && y <= 475 + 1;
      })
      .map(([id]) => id);
    expect(drawn).toEqual(expected);
  });

  it("leaves out elements smaller than half a device pixel", () => {
    // 10 units at zoom 0.04 are 0.4 device pixels at ratio 1, 0.8 at ratio 2.
    expect(draw({ cx: 400, cy: 400, zoom: 0.04 }, 1)).toEqual([]);
    expect(draw({ cx: 400, cy: 400, zoom: 0.04 }, 2)).toHaveLength(1600);
  });

  it("culls inside frames in each frame's own space, and respects clipping", () => {
    const { host, drawn } = testHost();
    const far = 2 ** 40;
    const els = record([
      ["F", box(FRAME_TYPE, far, 0, 100, 100, { data: { clip: true } })],
      ["in", box(RECT, 10, 10, 10, 10, { parent: "F" })],
      ["out", box(RECT, 200, 10, 10, 10, { parent: "F" })],
      ["G", element(GROUP_TYPE, "F", 50, 50)],
      ["g1", box(RECT, 0, 0, 5, 5, { parent: "G" })],
      ["root", box(RECT, 0, 0, 10, 10)],
    ]);
    const renderer = new CanvasRenderer({ host });
    renderer.attach(new RecordingContext(), {
      width: 400,
      height: 400,
      devicePixelRatio: 1,
    });
    renderer.setScene(sceneFromSnapshot({ elements: els }));
    // Whole frame in view; "out" is outside the clipped frame even though the
    // view would reach it.
    renderer.setCamera({ space: "F", cx: 100, cy: 50, zoom: 1 });
    renderer.render();
    expect(drawn).toEqual(["in", "g1"]);
    drawn.length = 0;
    // Deep inside, only the group member.
    renderer.setCamera({ space: "F", cx: 52, cy: 52, zoom: 1000 });
    renderer.render();
    expect(drawn).toEqual(["g1"]);
  });

  it("grows the bounds by what the type says it draws outside its box", () => {
    const { host, drawn } = testHost();
    const els = record([
      ["ring", box(CIRCLE_STROKE, 0, 0, 100, 100, { data: { width: 40 } })],
    ]);
    const renderer = new CanvasRenderer({ host });
    renderer.attach(new RecordingContext(), {
      width: 100,
      height: 100,
      devicePixelRatio: 1,
    });
    renderer.setScene(sceneFromSnapshot({ elements: els }));
    // The view is left of the box, but within the stroke's half width.
    renderer.setCamera({ space: null, cx: -10, cy: 50, zoom: 10 });
    renderer.render();
    expect(drawn).toEqual(["ring"]);
  });
});

function element(type: string, parent: ElementId | null, x: number, y: number): Element {
  return box(type, x, y, 0, 0, { parent, size: undefined } as Partial<Element>);
}

describe("updates from changed ids", () => {
  /** Bounds, parent and rank of every node, for comparison. */
  function shape(tree: SceneTree) {
    return [...tree.nodes.values()]
      .map((n) => ({
        id: n.id,
        parent: n.parent,
        rank: n.rank,
        gone: n.gone,
        bounds: n.bounds,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  it("matches a tree built from scratch after random edits", () => {
    const random = rng(11);
    const area = (n: { w: number; h: number }) => ({ x: 0, y: 0, w: n.w, h: n.h });
    const els: Record<ElementId, Element> = {};
    const containers: ElementId[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `C${i}`;
      els[id] =
        i % 2 === 0
          ? box(FRAME_TYPE, random() * 1000, random() * 1000, 200, 150, {
              data: { clip: i === 2 },
            })
          : element(GROUP_TYPE, null, random() * 1000, random() * 1000);
      containers.push(id);
    }
    for (let i = 0; i < 60; i++) {
      const parent =
        random() < 0.5 ? null : containers[Math.floor(random() * containers.length)]!;
      els[`e${i}`] = box(
        RECT,
        random() * 500,
        random() * 500,
        1 + random() * 50,
        1 + random() * 50,
        {
          parent,
          rot: random() < 0.3 ? random() * 6 : 0,
        } as Partial<Element>,
      );
    }
    const tree = new SceneTree(sceneFromSnapshot({ elements: { ...els } }), area);
    const ids = Object.keys(els);
    for (let step = 0; step < 300; step++) {
      const changed = new Set<ElementId>();
      const id = ids[Math.floor(random() * ids.length)]!;
      const e = els[id];
      const r = random();
      if (!e || (r < 0.1 && !id.startsWith("C"))) {
        // Add (again) a rectangle.
        els[id] = box(RECT, random() * 500, random() * 500, 5, 5);
      } else if (r < 0.2 && !id.startsWith("C")) {
        delete els[id];
      } else if (r < 0.5) {
        els[id] = {
          ...e,
          pos: { ...e.pos, x: e.pos.x + random() * 100 - 50 },
        } as Element;
      } else if (r < 0.7 && !id.startsWith("C")) {
        const parent =
          random() < 0.4 ? null : containers[Math.floor(random() * containers.length)]!;
        els[id] = { ...e, parent, pos: { x: 3, y: 4, space: parent } } as Element;
      } else if (r < 0.8) {
        els[id] = { ...e, order: `k${random().toFixed(8)}` } as Element;
      } else if (r < 0.9 && e.type !== GROUP_TYPE) {
        els[id] = { ...e, size: { w: random() * 300, h: random() * 300 } } as Element;
      } else {
        els[id] = {
          ...e,
          deleted: random() < 0.5 ? {} : { a: { seen: { [id]: "" } } },
        } as Element;
      }
      changed.add(id);
      const source = sceneFromSnapshot({ elements: { ...els } });
      tree.apply(changed, source);
      const fresh = new SceneTree(source, area);
      expect(shape(tree), `step ${step}`).toEqual(shape(fresh));
      // The root's children are in the same order.
      expect(tree.root.ids).toEqual(fresh.root.ids);
    }
  });
});
