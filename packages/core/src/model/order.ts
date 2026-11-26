// SPDX-License-Identifier: GPL-3.0-or-later

// Fractional order keys for z-order, route entries and the list of routes.
// Section 4 of docs/adr/0001-document-model-and-file-format.md.
//
// Keys are generated with the `fractional-indexing` package (CC0-1.0). Only the
// comparison rule is part of the file format: keys are compared as plain strings
// (code unit order) and ties are broken by id. Any generator that produces keys
// in the package's format may be used.

import { BASE_62_DIGITS, generateKeyBetween } from "fractional-indexing";
import type { OrderKey } from "./types.ts";

/** Compares two strings by UTF-16 code units, the order every reader must use. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Something that has an order key and a unique id for breaking ties. */
export interface Ordered {
  readonly id: string;
  readonly order: OrderKey;
}

/** Sort order for siblings: by key, then by id. */
export function compareOrdered(a: Ordered, b: Ordered): number {
  return compareCodeUnits(a.order, b.order) || compareCodeUnits(a.id, b.id);
}

/** Returns a new array sorted back to front. */
export function sortOrdered<T extends Ordered>(items: Iterable<T>): T[] {
  return [...items].sort(compareOrdered);
}

/** Source of random numbers in [0, 1). Injected so tests can be deterministic. */
export type RandomSource = () => number;

const JITTER_DIGITS = 3;

/**
 * Appends a few random digits so that two replicas inserting at the same place at
 * the same time almost never produce the same key. The result is only used if it
 * still sorts strictly between the bounds.
 */
function withJitter(
  key: OrderKey,
  low: OrderKey | null,
  high: OrderKey | null,
  random: RandomSource,
): OrderKey {
  let suffix = "";
  for (let i = 0; i < JITTER_DIGITS; i++) {
    // The last digit must not be "0": keys may not end in the zero digit.
    const min = i === JITTER_DIGITS - 1 ? 1 : 0;
    const index = min + Math.floor(random() * (BASE_62_DIGITS.length - min));
    suffix += BASE_62_DIGITS[Math.min(index, BASE_62_DIGITS.length - 1)];
  }
  const candidate = key + suffix;
  if (low !== null && !(compareCodeUnits(low, candidate) < 0)) return key;
  if (high !== null && !(compareCodeUnits(candidate, high) < 0)) return key;
  return candidate;
}

/**
 * A key that sorts strictly between `low` and `high` (null means open end).
 * If the bounds are equal (two siblings that got the same key concurrently), the
 * new key goes just after them: callers that need an exact place re-key one of
 * the two first (section 4.3).
 */
export function keyBetween(
  low: OrderKey | null,
  high: OrderKey | null,
  random: RandomSource = Math.random,
): OrderKey {
  if (low !== null && high !== null && compareCodeUnits(low, high) >= 0) {
    high = null;
  }
  return withJitter(generateKeyBetween(low, high), low, high, random);
}

/**
 * Key for putting an item at `index` in `siblings` (sorted, not containing the
 * item being placed). Index 0 is the back, `siblings.length` the front.
 */
export function keyAt(
  siblings: readonly Ordered[],
  index: number,
  random: RandomSource = Math.random,
): OrderKey {
  const clamped = Math.max(0, Math.min(index, siblings.length));
  const below = clamped > 0 ? siblings[clamped - 1] : undefined;
  let above = clamped < siblings.length ? siblings[clamped] : undefined;
  // Skip past siblings that share the lower key; there is no room between them.
  let next = clamped;
  while (below && above && above.order === below.order) {
    next += 1;
    above = next < siblings.length ? siblings[next] : undefined;
  }
  return keyBetween(below?.order ?? null, above?.order ?? null, random);
}
