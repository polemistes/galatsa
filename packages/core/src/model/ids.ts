// SPDX-License-Identifier: GPL-3.0-or-later

// Random ids for elements, stops, routes, route entries and documents. Section
// 3.1 of docs/adr/0001-document-model-and-file-format.md: 128 random bits as 22
// URL-safe base64 characters, so replicas never need to coordinate.

/** The part of Web Crypto this module uses (available in browsers and Node). */
interface RandomValuesSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/** Fills a byte array with random bytes. Injected in tests for determinism. */
export type RandomBytes = (bytes: Uint8Array) => void;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const defaultRandomBytes: RandomBytes = (bytes) => {
  const crypto = (globalThis as { crypto?: RandomValuesSource }).crypto;
  if (!crypto) throw new Error("No source of secure random numbers (globalThis.crypto)");
  crypto.getRandomValues(bytes);
};

/** A new random id: 22 characters, 128 random bits. */
export function newId(randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = new Uint8Array(16);
  randomBytes(bytes);
  // 16 bytes = 128 bits = 21 full 6-bit characters plus 2 bits.
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(buffer >> bits) & 63];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (6 - bits)) & 63];
  return out;
}
