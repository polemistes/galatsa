// SPDX-License-Identifier: GPL-3.0-or-later

// Deterministic randomness for tests.

import type { RandomBytes } from "../model/ids.ts";
import type { RandomSource } from "../model/order.ts";
import type { OpOptions } from "./ops.ts";

/** A small deterministic random number generator (mulberry32). */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random bytes for ids. */
export function seededBytes(seed: number): RandomBytes {
  const random = seededRandom(seed);
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  };
}

/** Options for deterministic operations. */
export function seededOptions(seed: number): OpOptions {
  return { random: seededRandom(seed), randomBytes: seededBytes(seed + 1) };
}
