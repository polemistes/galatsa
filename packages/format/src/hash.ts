// SPDX-License-Identifier: GPL-3.0-or-later

// Content addresses of assets: "sha256-" + lowercase hex SHA-256 of the bytes.
// Section 8.1 of docs/adr/0001-document-model-and-file-format.md.

import { ASSET_ID_PATTERN, type AssetId } from "@galatsa/core";

/** The part of Web Crypto used here (browsers, the desktop web view and Node). */
interface SubtleDigest {
  subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const crypto = (globalThis as { crypto?: SubtleDigest }).crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto (crypto.subtle) is not available");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The asset id of a file's bytes. */
export async function assetIdOf(bytes: Uint8Array): Promise<AssetId> {
  return `sha256-${await sha256Hex(bytes)}`;
}

export function isAssetId(value: string): value is AssetId {
  return ASSET_ID_PATTERN.test(value);
}
