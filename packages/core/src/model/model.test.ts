// SPDX-License-Identifier: GPL-3.0-or-later

// Unit tests of the Yjs-free model: order keys, ids, zoom range, resolution,
// routes and validation. See docs/adr/0001-document-model-and-file-format.md.

import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PRECISION_BUDGET,
  clampZoom,
  maxPreciseZoom,
  rotatedBounds,
  zoomToFit,
} from "./geometry.ts";
import { newId } from "./ids.ts";
import { compareCodeUnits, keyAt, keyBetween, sortOrdered } from "./order.ts";
import { Resolver, lookupFromRecord } from "./resolve.ts";
import {
  hiddenAt,
  isHiddenBy,
  liveRoutes,
  regionToWorld,
  routeSteps,
  stopRegion,
} from "./route.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  SCHEMA_VERSION,
  type DocumentSnapshot,
  type Element,
  type Stop,
} from "./types.ts";
import { validateSnapshot } from "./validate.ts";

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function el(
  partial: Partial<Element> & { type?: string; parent?: string | null },
): Element {
  return {
    type: "test.shapes/box",
    typeVersion: 1,
    parent: null,
    order: "a0",
    pos: { x: 0, y: 0, space: partial.parent ?? null },
    rebase: null,
    name: "",
    locked: false,
    assets: [],
    removed: null,
    data: {},
    size: { w: 10, h: 10 },
    rot: 0,
    ...partial,
  } as Element;
}

describe("order keys", () => {
  it("sorts by code units, not locale, and breaks ties by id", () => {
    expect(compareCodeUnits("Z", "a")).toBeLessThan(0);
    expect(
      sortOrdered([
        { id: "b", order: "a1" },
        { id: "a", order: "a1" },
        { id: "c", order: "a0" },
      ]).map((x) => x.id),
    ).toEqual(["c", "a", "b"]);
  });

  it("generates keys strictly between neighbours, with jitter", () => {
    const random = seeded(1);
    let low: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const k: string = keyBetween(low, null, random);
      if (low !== null) expect(compareCodeUnits(low, k)).toBeLessThan(0);
      keys.push(k);
      low = k;
    }
    const mid = keyBetween(keys[10]!, keys[11]!, random);
    expect(compareCodeUnits(keys[10]!, mid)).toBeLessThan(0);
    expect(compareCodeUnits(mid, keys[11]!)).toBeLessThan(0);
    // Two replicas inserting at the same place get different keys.
    expect(keyBetween("a0", "a1", seeded(2))).not.toBe(keyBetween("a0", "a1", seeded(3)));
  });

  it("places after a run of equal keys instead of failing", () => {
    const siblings = [
      { id: "a", order: "a0" },
      { id: "b", order: "a0" },
      { id: "c", order: "a5" },
    ];
    const k = keyAt(siblings, 1, seeded(4));
    expect(compareCodeUnits("a0", k)).toBeLessThan(0);
    expect(compareCodeUnits(k, "a5")).toBeLessThan(0);
  });
});

describe("ids", () => {
  it("are 22 URL-safe characters and differ", () => {
    const a = newId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newId()).not.toBe(a);
  });
});

describe("zoom range and precision budget", () => {
  it("allows the full range near the origin and clamps far from it", () => {
    expect(maxPreciseZoom(0, 0)).toBe(MAX_ZOOM);
    expect(maxPreciseZoom(2 ** 14, 0)).toBe(MAX_ZOOM);
    expect(maxPreciseZoom(1e6, -5)).toBeCloseTo(PRECISION_BUDGET / 1e6);
    expect(clampZoom(1e-20, 0, 0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e20, 1e6, 0)).toBe(PRECISION_BUDGET / 1e6);
  });

  it("keeps the error under 1/64 pixel at the clamp", () => {
    for (const c of [1, 1234.5, 1e6, 3e9]) {
      const z = maxPreciseZoom(c, 0);
      const spacing = c * 2 ** -52; // float64 spacing near c
      expect(spacing * z).toBeLessThanOrEqual(1 / 64);
    }
  });

  it("fits rectangles and bounds rotated boxes", () => {
    expect(zoomToFit({ x: 0, y: 0, w: 200, h: 100 }, 1000, 1000)).toBe(5);
    const b = rotatedBounds({ x: 0, y: 0, w: 10, h: 10 }, Math.PI / 4);
    expect(b.w).toBeCloseTo(Math.SQRT2 * 10);
    expect(b.x + b.w / 2).toBeCloseTo(5);
  });
});

describe("resolution", () => {
  it("treats missing and non-container parents as the root", () => {
    const r = new Resolver(
      lookupFromRecord({ a: el({ parent: "gone" }), b: el({ parent: "a" }) }),
    );
    expect(r.parentOf("a")).toBe(null);
    expect(r.parentOf("b")).toBe(null);
  });

  it("breaks parent cycles at the smallest id, whatever the iteration order", () => {
    const frame = (parent: string) =>
      el({ type: FRAME_TYPE, parent, pos: { x: 1, y: 1, space: parent } });
    const elements = {
      q: frame("p"),
      p: frame("r"),
      r: frame("q"),
      s: el({ parent: "q", pos: { x: 0, y: 0, space: "q" } }),
    };
    const reversed = Object.fromEntries(Object.entries(elements).reverse());
    for (const record of [elements, reversed]) {
      const r = new Resolver(lookupFromRecord(record));
      expect(r.parentOf("p")).toBe(null);
      expect(r.parentOf("q")).toBe("p");
      expect(r.parentOf("r")).toBe("q");
      expect(r.drawOrder().sort()).toEqual(["p", "q", "r", "s"]);
    }
  });

  it("converts positions: own space, rebase, then world fallback", () => {
    const elements = {
      F: el({ type: FRAME_TYPE, pos: { x: 100, y: 100, space: null } }),
      G: el({ type: FRAME_TYPE, pos: { x: 500, y: 0, space: null } }),
      own: el({ parent: "F", pos: { x: 1, y: 2, space: "F" } }),
      rebased: el({
        parent: "F",
        pos: { x: 10, y: 10, space: null },
        rebase: { from: null, to: "F", dx: -100, dy: -100 },
      }),
      stale: el({ parent: "F", pos: { x: 10, y: 10, space: "G" } }),
      selfInside: el({
        type: FRAME_TYPE,
        parent: null,
        pos: { x: 7, y: 8, space: "inner" },
      }),
      inner: el({
        type: FRAME_TYPE,
        parent: "selfInside",
        pos: { x: 0, y: 0, space: "selfInside" },
      }),
    };
    const r = new Resolver(lookupFromRecord(elements));
    expect(r.localPosition("own")).toEqual({ x: 1, y: 2 });
    expect(r.worldOrigin("rebased")).toEqual({ x: 10, y: 10 });
    expect(r.worldOrigin("stale")).toEqual({ x: 510, y: 10 });
    expect(r.localPosition("selfInside")).toEqual({ x: 7, y: 8 });
  });

  it("hides deleted subtrees, draws through dissolved containers, and stacks per container", () => {
    const elements = {
      F: el({ type: FRAME_TYPE, order: "a1" }),
      a: el({ parent: "F", order: "a1" }),
      b: el({ parent: "F", order: "a0" }),
      top: el({ order: "a2" }),
      back: el({ order: "a0" }),
      Gr: el({ type: GROUP_TYPE, order: "a3", removed: "dissolve" }),
      g1: el({ parent: "Gr" }),
      D: el({ type: GROUP_TYPE, order: "a4", removed: "delete" }),
      d1: el({ parent: "D" }),
    };
    const r = new Resolver(lookupFromRecord(elements));
    expect(r.drawOrder()).toEqual(["back", "F", "b", "a", "top", "g1"]);
    expect(r.isDeleted("d1")).toBe(true);
    expect(r.logicalParentOf("g1")).toBe(null);
  });

  it("computes group bounds from live children", () => {
    const elements = {
      Gr: el({ type: GROUP_TYPE, pos: { x: 100, y: 100, space: null } }),
      a: el({ parent: "Gr", pos: { x: 0, y: 0, space: "Gr" }, size: { w: 10, h: 10 } }),
      b: el({ parent: "Gr", pos: { x: 20, y: 30, space: "Gr" }, size: { w: 10, h: 10 } }),
      c: el({ parent: "Gr", pos: { x: 500, y: 500, space: "Gr" }, removed: "delete" }),
      Empty: el({ type: GROUP_TYPE }),
    };
    const r = new Resolver(lookupFromRecord(elements));
    expect(r.bounds("Gr")).toEqual({ x: 100, y: 100, w: 30, h: 40 });
    expect(r.bounds("Empty")).toBe(null);
  });
});

function stop(partial: Partial<Stop>): Stop {
  return {
    name: "",
    view: { kind: "rect", space: null, x: 0, y: 0, w: 10, h: 10 },
    notes: { $y: "text", delta: [] },
    visibility: {},
    transition: null,
    removed: false,
    ...partial,
  };
}

describe("routes and visibility", () => {
  const doc: Pick<DocumentSnapshot, "stops" | "routes"> = {
    stops: {
      s1: stop({}),
      s2: stop({ visibility: { title: { action: "hide" } } }),
      s3: stop({ visibility: { chart: { action: "show" } } }),
      s4: stop({ visibility: { chart: { action: "hide" } } }),
      gone: stop({ removed: true }),
    },
    routes: {
      full: {
        name: "",
        order: "a0",
        removed: false,
        entries: {
          e1: { stop: "s1", order: "a0" },
          e2: { stop: "s2", order: "a1" },
          e3: { stop: "s3", order: "a2" },
          e4: { stop: "s4", order: "a3" },
          ex: { stop: "gone", order: "a4" },
          ey: { stop: "missing", order: "a5" },
        },
      },
      short: {
        name: "",
        order: "a1",
        removed: false,
        entries: { e1: { stop: "s1", order: "a0" }, e4: { stop: "s4", order: "a1" } },
      },
      old: { name: "", order: "Zz", removed: true, entries: {} },
    },
  };

  it("plays entries in order, skipping removed and missing stops", () => {
    expect(routeSteps(doc, "full").map((s) => s.stop)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(routeSteps(doc, "old")).toEqual([]);
    expect(liveRoutes(doc)).toEqual(["full", "short"]);
  });

  it("adds up show and hide changes along the route", () => {
    const at = (route: string, i: number) => [...hiddenAt(doc, route, i)].sort();
    expect(at("full", -1)).toEqual(["chart"]);
    expect(at("full", 0)).toEqual(["chart"]);
    expect(at("full", 1)).toEqual(["chart", "title"]);
    expect(at("full", 2)).toEqual(["title"]);
    expect(at("full", 3)).toEqual(["chart", "title"]);
    // The short route skips the entrance at s3: the chart starts visible.
    expect(at("short", 0)).toEqual([]);
    expect(at("short", 1)).toEqual(["chart"]);
  });

  it("finds stop regions in the most local space and hides subtrees", () => {
    const elements = {
      F: el({
        type: FRAME_TYPE,
        pos: { x: 100, y: 200, space: null },
        size: { w: 400, h: 300 },
      }),
      inner: el({
        type: FRAME_TYPE,
        parent: "F",
        pos: { x: 10, y: 10, space: "F" },
        size: { w: 40, h: 30 },
      }),
      child: el({ parent: "inner", pos: { x: 1, y: 1, space: "inner" } }),
    };
    const r = new Resolver(lookupFromRecord(elements));
    const stops = {
      a: stop({ view: { kind: "frame", frame: "inner", padding: 0.5 } }),
      b: stop({ view: { kind: "rect", space: "missing", x: 1, y: 2, w: 3, h: 4 } }),
      c: stop({ view: { kind: "frame", frame: "missing", padding: 0 } }),
    };
    const sr = { stops, routes: {} };
    const region = stopRegion(sr, r, "a")!;
    expect(region).toEqual({ space: "F", rect: { x: -10, y: -10, w: 80, h: 70 } });
    expect(regionToWorld(r, region)).toEqual({ x: 90, y: 190, w: 80, h: 70 });
    expect(stopRegion(sr, r, "b")).toEqual({
      space: null,
      rect: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(stopRegion(sr, r, "c")).toBe(null);
    expect(isHiddenBy(r, new Set(["F"]), "child")).toBe(true);
  });
});

describe("validation", () => {
  const valid: DocumentSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    id: "doc1",
    title: "",
    settings: {},
    elements: {
      a: el({
        data: {
          text: { $y: "text", delta: [{ insert: "x" }] },
          plain: { nested: { $y: "anything" } },
        },
      }),
    },
    stops: { s: stop({}) },
    routes: {
      r: {
        name: "",
        order: "a0",
        removed: false,
        entries: { e: { stop: "s", order: "a0" } },
      },
    },
    assets: { [`sha256-${"a".repeat(64)}`]: { mediaType: "image/png", byteLength: 3 } },
  };

  it("accepts a valid snapshot, including $y keys nested in plain JSON", () => {
    expect(validateSnapshot(valid)).toEqual([]);
  });

  it("reports structural problems", () => {
    const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown> &
      DocumentSnapshot;
    const a = broken.elements.a as unknown as Record<string, unknown>;
    a.pos = { x: "1", y: 0, space: null };
    a.removed = "dissolve";
    (a.data as Record<string, unknown>).bad = { $y: "nope" };
    broken.assets = {
      "sha256-xyz": { mediaType: "png", byteLength: -1 },
    } as DocumentSnapshot["assets"];
    const problems = validateSnapshot(broken);
    expect(problems.some((p) => p.includes("pos.x"))).toBe(true);
    expect(
      problems.some((p) => p.includes("only frames and groups can be dissolved")),
    ).toBe(true);
    expect(problems.some((p) => p.includes("unknown shared type"))).toBe(true);
    expect(problems.some((p) => p.includes("invalid asset id"))).toBe(true);
    expect(validateSnapshot(null)).toEqual(["document: must be an object"]);
  });
});
