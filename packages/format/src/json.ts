// SPDX-License-Identifier: GPL-3.0-or-later

// Canonical JSON: object keys sorted by code unit, no whitespace. Used for
// document.json (so the same document always gives the same bytes) and for
// comparing documents.

import { strFromU8, strToU8 } from "fflate";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function utf8(text: string): Uint8Array {
  return strToU8(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return strFromU8(bytes);
}
