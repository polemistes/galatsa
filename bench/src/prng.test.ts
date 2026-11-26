// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createRng, deriveSeed, hashString, shuffle } from "./prng.ts";

describe("createRng", () => {
  it("gives the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it("gives pinned values, so the generator cannot change unnoticed", () => {
    const rng = createRng(1);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([
      2693262067, 11749833, 2265367787,
    ]);
  });

  it("gives different sequences for different seeds", () => {
    expect(createRng(1).nextUint32()).not.toBe(createRng(2).nextUint32());
  });

  it("keeps next() in [0, 1) and int() within its bounds", () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 10000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(-3, 3);
      expect(Number.isInteger(n)).toBe(true);
      seen.add(n);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it("rejects bad ranges and empty picks", () => {
    const rng = createRng(1);
    expect(() => rng.int(3, 2)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});

describe("deriveSeed and shuffle", () => {
  it("derives distinct, stable seeds", () => {
    const seeds = new Set([0, 1, 2, 3, 100, 101].map((label) => deriveSeed(5, label)));
    expect(seeds.size).toBe(6);
    expect(deriveSeed(5, 1)).toBe(deriveSeed(5, 1));
  });

  it("shuffles into a permutation", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = shuffle([...items], createRng(3));
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });
});

describe("hashString", () => {
  it("is FNV-1a", () => {
    expect(hashString("")).toBe("811c9dc5");
    expect(hashString("a")).toBe("e40c292c");
    expect(hashString("foobar")).toBe("bf9cf968");
  });
});
