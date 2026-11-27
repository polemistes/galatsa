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
import {
  compareCodeUnits,
  isValidOrderKey,
  keyAt,
  keyBetween,
  sortOrdered,
} from "./order.ts";
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
import { revisionDigest, revisionText, sha256Ascii } from "./digest.ts";
import { MAX_DEPTH, nestingDepth, readSnapshot, validateSnapshot } from "./grammar.ts";

/** The digest of the revision that `el` and `stop` give their records. */
const W1 = revisionDigest({ w: 1 });

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function el(partial: Record<string, unknown>): Element {
  return {
    type: "test.shapes/box",
    typeVersion: 1,
    parent: null,
    order: "a0",
    pos: { x: 0, y: 0, space: partial.parent ?? null },
    rebase: null,
    name: "",
    locked: false,
    rev: { w: 1 },
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: {},
    size: { w: 10, h: 10 },
    rot: 0,
    ...partial,
  } as unknown as Element;
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
        rebase: { to: "F", base: null, shifts: [{ from: null, dx: -100, dy: -100 }] },
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

  it("hides deleted elements, draws through gone containers, and stacks per container", () => {
    const elements = {
      F: el({ type: FRAME_TYPE, order: "a1" }),
      a: el({ parent: "F", order: "a1" }),
      b: el({ parent: "F", order: "a0" }),
      top: el({ order: "a2" }),
      back: el({ order: "a0" }),
      Gr: el({ type: GROUP_TYPE, order: "a3", dissolved: true }),
      g1: el({ parent: "Gr" }),
      // The delete of D lists what its user saw: D, d1, d3, sub and s1.
      D: el({
        type: GROUP_TYPE,
        order: "a4",
        deleted: {
          k: {
            seen: { D: W1, d1: W1, d3: W1, sub: W1, s1: W1 },
          },
        },
      }),
      d1: el({ parent: "D" }),
      // Added to D after the delete (not listed): survives in D's slot.
      d2: el({ parent: "D", order: "a1" }),
      // Listed, but worked on since (another revision): survives.
      d3: el({ parent: "D", order: "a2", rev: { w: 1, v: 3 } }),
      // A group inside D that was worked on: it survives, and so does what is in
      // it, although s1 itself is as the delete saw it.
      sub: el({ type: GROUP_TYPE, parent: "D", order: "a3", rev: { w: 2 } }),
      s1: el({ parent: "sub" }),
    };
    const r = new Resolver(lookupFromRecord(elements));
    expect(r.drawOrder()).toEqual([
      "back",
      "F",
      "b",
      "a",
      "top",
      "g1",
      "d2",
      "d3",
      "sub",
      "s1",
    ]);
    expect(r.isDeleted("D")).toBe(true);
    expect(r.deleters("d1")).toEqual([{ root: "D", action: "k" }]);
    expect(r.isDeleted("d2")).toBe(false);
    expect(r.isDeleted("d3")).toBe(false);
    expect(r.isDeleted("sub")).toBe(false);
    expect(r.isDeleted("s1")).toBe(false);
    expect(r.logicalParentOf("g1")).toBe(null);
    expect(r.logicalParentOf("d2")).toBe(null);
    expect(r.logicalChildren(null)).toEqual([
      "back",
      "F",
      "top",
      "g1",
      "d2",
      "d3",
      "sub",
    ]);
    // What a delete of a visible container lists, and of one that is gone already.
    expect(Object.keys(r.coverage("F")).sort()).toEqual(["F", "a", "b"]);
    expect(Object.keys(r.coverage("D")).sort()).toEqual(["D", "d1"]);
  });

  it("a delete stops applying when the deleted element itself was worked on", () => {
    const seen = { D: W1, d1: W1 };
    const make = (rev: Record<string, number>, dissolved: boolean) =>
      new Resolver(
        lookupFromRecord({
          D: el({ type: GROUP_TYPE, rev, dissolved, deleted: { k: { seen } } }),
          d1: el({ parent: "D" }),
        }),
      );
    expect(make({ w: 1 }, false).isDeleted("d1")).toBe(true);
    // Worked on (for example dissolved by someone who did not see the delete).
    expect(make({ w: 1, v: 64 }, true).isDeleted("d1")).toBe(false);
    // Dissolved knowingly, after the delete: still deleted.
    expect(make({ w: 1 }, true).isDeleted("d1")).toBe(true);
  });

  it("a place marker is gone for good, whatever else its record says", () => {
    const r = new Resolver(
      lookupFromRecord({
        F: el({ type: FRAME_TYPE, purged: true, dissolved: false }),
        x: el({ parent: "F" }),
      }),
    );
    expect(r.isGone("F")).toBe(true);
    expect(r.drawOrder()).toEqual(["x"]);
    expect(r.logicalParentOf("x")).toBe(null);
  });

  it("the digest of a revision is fixed by the format", () => {
    const hex = (bytes: Uint8Array) =>
      [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    // SHA-256 test vectors (FIPS 180-2).
    expect(hex(sha256Ascii("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      hex(sha256Ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(hex(sha256Ascii(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(revisionText({ "b.0": 3, "a.1": 64 })).toBe("a.1=64\nb.0=3");
    expect(revisionDigest({})).toBe("");
    expect(revisionDigest({ "abc.0": 7 })).toBe("kHrilVv4WhFPXweb");
    expect(revisionDigest({ "b.0": 3, "a.1": 64 })).toBe(
      revisionDigest({ "a.1": 64, "b.0": 3 }),
    );
    expect(revisionDigest({ "a.1": 64 })).not.toBe(revisionDigest({ "a.1": 63 }));
  });

  it("resolves very deep trees without overflowing the stack", () => {
    const elements: Record<string, Element> = {};
    for (let i = 0; i < 30_000; i++) {
      elements[`g${i}`] = el({ type: GROUP_TYPE, parent: i === 0 ? null : `g${i - 1}` });
    }
    elements.leaf = el({ parent: "g29999" });
    const r = new Resolver(lookupFromRecord(elements));
    expect(r.drawOrder().length).toBe(30_001);
    expect(r.isDeleted("leaf")).toBe(false);
    expect(r.bounds("g0")).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(r.logicalChildren(null)).toEqual(["g0"]);
    expect(Object.keys(r.coverage("g0")).length).toBe(30_001);
  });

  it("computes group bounds from live children", () => {
    const elements = {
      Gr: el({ type: GROUP_TYPE, pos: { x: 100, y: 100, space: null } }),
      a: el({ parent: "Gr", pos: { x: 0, y: 0, space: "Gr" }, size: { w: 10, h: 10 } }),
      b: el({ parent: "Gr", pos: { x: 20, y: 30, space: "Gr" }, size: { w: 10, h: 10 } }),
      c: el({
        parent: "Gr",
        pos: { x: 500, y: 500, space: "Gr" },
        deleted: { k: { seen: { c: W1 } } },
      }),
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
    rev: { w: 1 },
    deleted: {},
    ext: {},
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
      gone: stop({ deleted: { k: { seen: { gone: W1 } } } }),
      // Removed, but worked on concurrently: the removal does not apply.
      kept: stop({ rev: { w: 1, v: 2 }, deleted: { k: { seen: { kept: W1 } } } }),
    },
    routes: {
      full: {
        name: "",
        order: "a0",
        rev: {},
        deleted: {},
        ext: {},
        entries: {
          e1: { stop: "s1", order: "a0" },
          e2: { stop: "s2", order: "a1" },
          e3: { stop: "s3", order: "a2" },
          e4: { stop: "s4", order: "a3" },
          ex: { stop: "gone", order: "a4" },
          ey: { stop: "missing", order: "a5" },
          ez: { stop: "kept", order: "a6" },
        },
      },
      short: {
        name: "",
        order: "a1",
        rev: {},
        deleted: {},
        ext: {},
        entries: { e1: { stop: "s1", order: "a0" }, e4: { stop: "s4", order: "a1" } },
      },
      old: {
        name: "",
        order: "Zz",
        rev: {},
        deleted: { k: { seen: { old: "" } } },
        ext: {},
        entries: {},
      },
    },
  };

  it("plays entries in order, skipping removed and missing stops", () => {
    expect(routeSteps(doc, "full").map((s) => s.stop)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "kept",
    ]);
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
    minReaderVersion: 1,
    id: "doc1",
    title: "",
    settings: {},
    elements: {
      a: el({
        data: {
          text: { $y: "text", delta: [{ insert: "x" }], attributes: { dir: "rtl" } },
          plain: { nested: { $y: "anything" } },
          bin: { $y: "any", value: { b: "AQI=" } },
        },
        ext: { "core.alt": "A box" },
      }),
    },
    stops: { s: stop({}) },
    routes: {
      r: {
        name: "",
        order: "a0",
        rev: {},
        deleted: {},
        ext: {},
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
    a.dissolved = true;
    a.smuggled = 1;
    (a.data as Record<string, unknown>).bad = { $y: "nope" };
    broken.assets = {
      "sha256-xyz": { mediaType: "png", byteLength: -1 },
    } as DocumentSnapshot["assets"];
    const problems = validateSnapshot(broken);
    expect(problems.some((p) => p.includes("pos.x"))).toBe(true);
    expect(
      problems.some((p) => p.includes("only frames and groups can be dissolved")),
    ).toBe(true);
    expect(problems.some((p) => p.includes("smuggled: unknown field"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown kind of value"))).toBe(true);
    expect(problems.some((p) => p.includes("not a valid id"))).toBe(true);
    expect(validateSnapshot(null)).toEqual(["document: must be an object"]);
  });

  it("accepts external media next to the file, but only by plain file name", () => {
    const asset = `sha256-${"b".repeat(64)}` as const;
    const withExternal = (path: string) => {
      const doc = JSON.parse(JSON.stringify(valid)) as DocumentSnapshot;
      doc.assets[asset] = { mediaType: "video/mp4", byteLength: 9, external: { path } };
      return validateSnapshot(doc);
    };
    expect(withExternal("film.mp4")).toEqual([]);
    for (const bad of ["../film.mp4", "a/b.mp4", "C:film", "..", ""]) {
      expect(withExternal(bad).some((p) => p.includes("external"))).toBe(true);
    }
  });

  it("rejects order keys outside the syntax, and __proto__ as an id", () => {
    for (const bad of ["", "a", "Z", "abc0", "0", "a1 ", "A" + "0".repeat(26)]) {
      expect(isValidOrderKey(bad)).toBe(false);
      const doc = JSON.parse(JSON.stringify(valid)) as DocumentSnapshot;
      (doc.elements.a as { order: string }).order = bad;
      expect(validateSnapshot(doc).some((p) => p.includes("order key"))).toBe(true);
    }
    for (const good of ["a0", "a1V", "Zz", "b00", "a0ab1"])
      expect(isValidOrderKey(good)).toBe(true);
    const doc = JSON.parse(JSON.stringify(valid)) as DocumentSnapshot;
    Object.defineProperty(doc.elements, "__proto__", {
      value: doc.elements.a,
      enumerable: true,
    });
    expect(validateSnapshot(doc).some((p) => p.includes("not a valid id"))).toBe(true);
  });

  it("generates keys even next to invalid ones, without throwing", () => {
    for (const bad of ["", "a", "abc0", "Z", "0", "a1 "]) {
      expect(() => keyBetween(bad, null)).not.toThrow();
      expect(isValidOrderKey(keyBetween(bad, null))).toBe(true);
    }
    const k = keyAt(
      [
        { id: "x", order: "" },
        { id: "y", order: "abc0" },
        { id: "z", order: "a5" },
      ],
      2,
    );
    expect(isValidOrderKey(k)).toBe(true);
    expect(compareCodeUnits(k, "a5")).toBeLessThan(0);
  });

  it("refuses very deep nesting without overflowing the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const doc = JSON.parse(JSON.stringify(valid)) as DocumentSnapshot;
    (doc.elements.a!.data as Record<string, unknown>).deep = deep;
    expect(nestingDepth(doc)).toBeGreaterThan(MAX_DEPTH);
    expect(validateSnapshot(doc).some((p) => p.includes("nested too deep"))).toBe(true);
    expect(nestingDepth(readSnapshot(doc).snapshot, 100_000)).toBeLessThanOrEqual(
      MAX_DEPTH,
    );
  });

  it("reads anything as a valid document, and reading the result changes nothing", () => {
    const junk = JSON.parse(JSON.stringify(valid)) as Record<string, unknown> &
      DocumentSnapshot;
    const a = junk.elements.a as unknown as Record<string, unknown>;
    a.size = { w: -5, h: "x" };
    a.typeVersion = 0;
    a.rev = { ok: 3, "bad key": 1, zero: 0 };
    a.deleted = {
      k: { seen: { a: W1, "bad id": "", b: "not a digest", c: { w: 1 } } },
      "bad action": {},
      j: 5,
    };
    a.refs = ["z", "a", "z", "not an id!"];
    a.purged = true;
    a.rebase = { to: null, base: null, shifts: "many" };
    const data = a.data as Record<string, unknown>;
    data.future = { $y: "hologram", depth: 3 };
    data.brokenText = { $y: "text", delta: "abc" };
    data.runs = {
      $y: "text",
      delta: [
        { insert: "a" },
        { insert: "b" },
        { insert: "" },
        { insert: null },
        { insert: "c", attributes: { bold: null } },
        7,
      ],
    };
    data.escaped = { $y: "json", value: 5 };
    data.any = { $y: "any", value: { a: [1, 2] } };
    data.lone = "x\uD800";
    (junk.elements as Record<string, unknown>)["no type"] = {};
    (junk.elements as Record<string, unknown>).typeless = { type: "Nope" };
    (junk.stops.s as unknown as Record<string, unknown>).view = { kind: "orbit" };
    (junk.stops.s as unknown as Record<string, unknown>).visibility = {
      a: { action: "show", ext: { "x.fade": 200 } },
      b: { action: "spin" },
    };
    (junk.routes.r as unknown as Record<string, unknown>).entries = {
      e: { stop: "s", order: "a0", ext: { "x.note": "n" } },
      f: { stop: 5 },
    };
    junk.schemaVersion = 0;
    (junk as Record<string, unknown>).extra = true;
    const first = readSnapshot(junk);
    expect(first.problems.length).toBeGreaterThan(15);
    const snapshot = first.snapshot!;
    expect(snapshot.elements.a).toMatchObject({
      size: { w: 0, h: 0 },
      typeVersion: 1,
      rev: { ok: 3 },
      deleted: { k: { seen: { a: W1 } } },
      refs: ["a", "z"],
      purged: false,
      rebase: null,
    });
    const read = snapshot.elements.a!.data;
    expect(read.future).toEqual({
      $y: "unsupported",
      note: 'unknown kind of value "hologram"',
      raw: { $y: "hologram", depth: 3 },
    });
    expect(read.brokenText).toMatchObject({ $y: "unsupported", raw: { delta: "abc" } });
    expect(read.runs).toEqual({ $y: "text", delta: [{ insert: "abc" }] });
    expect(read.escaped).toBe(5);
    expect(read.any).toMatchObject({ $y: "unsupported" });
    expect(read.lone).toBe("x\uFFFD");
    expect(Object.keys(snapshot.elements)).toEqual(["a"]);
    expect(snapshot.stops.s!.view).toEqual({
      kind: "rect",
      space: null,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    expect(snapshot.stops.s!.visibility).toEqual({
      a: { action: "show", ext: { "x.fade": 200 } },
    });
    expect(snapshot.routes.r!.entries).toEqual({
      e: { stop: "s", order: "a0", ext: { "x.note": "n" } },
    });
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    const second = readSnapshot(snapshot);
    expect(second.problems).toEqual([]);
    expect(second.snapshot).toEqual(snapshot);
  });

  it("restores an unsupported value when this version can read the original", () => {
    const doc = JSON.parse(JSON.stringify(valid)) as DocumentSnapshot;
    const original = { $y: "map", entries: { k: 1 } };
    (doc.elements.a!.data as Record<string, unknown>).kept = {
      $y: "unsupported",
      note: "written by a version that did not know maps",
      raw: original,
    };
    expect(readSnapshot(doc).snapshot!.elements.a!.data.kept).toEqual(original);
  });
});
