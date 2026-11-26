// SPDX-License-Identifier: GPL-3.0-or-later

// Fractional order keys for z-order, route entries and the list of routes.
// Section 4 of docs/adr/0001-document-model-and-file-format.md.
//
// Keys are generated with the `fractional-indexing` package (CC0-1.0). The key
// syntax (isValidOrderKey) and the comparison rule are part of the file format;
// the generator is not.

import {
  BASE_62_DIGITS,
  generateKeyBetween,
  generateNKeysBetween,
} from "fractional-indexing";
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

const DIGITS = BASE_62_DIGITS;
const JITTER_DIGITS = 3;
/** Longest key accepted. Keys grow by about one character per six insertions at one spot. */
export const MAX_ORDER_KEY_LENGTH = 1024;

/**
 * True for keys in the format's syntax (section 4.1): a head letter giving the
 * length of the integer part (a-z: 2 to 27 characters, A-Z: 27 down to 2), the
 * remaining integer digits, then optional fraction digits not ending in "0", all
 * digits from 0-9A-Za-z. The smallest integer ("A" followed by 26 zeros) is
 * reserved.
 */
export function isValidOrderKey(key: string): boolean {
  const head = key.charCodeAt(0);
  let length: number;
  if (head >= 97 && head <= 122) length = head - 97 + 2;
  else if (head >= 65 && head <= 90) length = 90 - head + 2;
  else return false;
  if (key.length < length || key.length > MAX_ORDER_KEY_LENGTH) return false;
  for (let i = 1; i < key.length; i++) if (!DIGITS.includes(key[i]!)) return false;
  if (key.length > length && key.endsWith("0")) return false;
  return key !== "A" + "0".repeat(26);
}

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
    const index = min + Math.floor(random() * (DIGITS.length - min));
    suffix += DIGITS[Math.min(index, DIGITS.length - 1)];
  }
  const candidate = key + suffix;
  if (!isValidOrderKey(candidate)) return key;
  if (low !== null && !(compareCodeUnits(low, candidate) < 0)) return key;
  if (high !== null && !(compareCodeUnits(candidate, high) < 0)) return key;
  return candidate;
}

/**
 * A key that sorts strictly between `low` and `high` (null means open end).
 * Never throws: bounds that are not valid keys (possible only in state written by
 * a faulty peer; files are validated) are treated as open ends. If the bounds are
 * equal or reversed, the new key goes just after `low` (section 4.3).
 */
export function keyBetween(
  low: OrderKey | null,
  high: OrderKey | null,
  random: RandomSource = Math.random,
): OrderKey {
  if (low !== null && !isValidOrderKey(low)) low = null;
  if (high !== null && !isValidOrderKey(high)) high = null;
  if (low !== null && high !== null && compareCodeUnits(low, high) >= 0) high = null;
  return withJitter(generateKeyBetween(low, high), low, high, random);
}

/** `n` increasing keys strictly between `low` and `high` (no jitter). Never throws. */
export function keysBetween(
  low: OrderKey | null,
  high: OrderKey | null,
  n: number,
): OrderKey[] {
  if (low !== null && !isValidOrderKey(low)) low = null;
  if (high !== null && !isValidOrderKey(high)) high = null;
  if (low !== null && high !== null && compareCodeUnits(low, high) >= 0) high = null;
  return generateNKeysBetween(low, high, n);
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
  // The nearest valid keys below and above the slot.
  let lo = clamped - 1;
  while (lo >= 0 && !isValidOrderKey(siblings[lo]!.order)) lo--;
  const below = lo >= 0 ? siblings[lo] : undefined;
  let hi = clamped;
  // Skip invalid keys and keys equal to the lower bound (no room between them).
  while (
    hi < siblings.length &&
    (!isValidOrderKey(siblings[hi]!.order) ||
      (below !== undefined && siblings[hi]!.order <= below.order))
  ) {
    hi++;
  }
  const above = hi < siblings.length ? siblings[hi] : undefined;
  return keyBetween(below?.order ?? null, above?.order ?? null, random);
}
