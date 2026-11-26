// SPDX-License-Identifier: GPL-3.0-or-later

// Seeded pseudo-random numbers for the benchmark scene. Everything here uses 32-bit
// integer operations (Math.imul, shifts) and exact divisions by powers of two, so the
// same seed gives bit-identical output in every JavaScript engine. Math.random is
// never used.

/** A source of pseudo-random numbers. */
export interface Rng {
  /** Next unsigned 32-bit integer. */
  nextUint32(): number;
  /** Next number in [0, 1), a multiple of 2^-32. */
  next(): number;
  /** Next integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
}

const TWO_POW_32 = 4294967296;

/**
 * Mulberry32, a small 32-bit generator with a period of 2^32 (by Tommy Ettinger,
 * public domain). Good enough to scatter benchmark elements; not for cryptography.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const next = (): number => nextUint32() / TWO_POW_32;
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Invalid integer range [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    nextUint32,
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("Cannot pick from an empty array");
      return items[int(0, items.length - 1)] as T;
    },
    chance: (p: number): boolean => next() < p,
  };
}

/** Derives an independent seed from a base seed and a label number. */
export function deriveSeed(seed: number, label: number): number {
  let h = (seed ^ Math.imul(label + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Shuffles an array in place with the Fisher-Yates method. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

/** FNV-1a 32-bit hash of a string, as 8 hex digits. Used to pin generated output in tests. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
