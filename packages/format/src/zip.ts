// SPDX-License-Identifier: GPL-3.0-or-later

// The zip container of a Galatsa file. Writing uses fflate's zipSync. Reading
// parses the archive directory here and uses only fflate's inflate, so that every
// entry's CRC-32 is verified and declared sizes are checked before anything is
// inflated. Sections 9.1, 9.7 and 9.8 of
// docs/adr/0001-document-model-and-file-format.md.

import { inflateSync, zipSync, type Zippable } from "fflate";
import { FileFormatError } from "./errors.ts";

// ---------------------------------------------------------------------------
// CRC-32 (the zip polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
  /** Deflate the entry (true) or store it as is (false). */
  compress: boolean;
}

/** A fixed timestamp, so the same content always gives the same bytes. */
const FIXED_TIME = new Date(1980, 0, 1, 0, 0, 0);

/** Writes entries in the given order. */
export function writeZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const files: Zippable = {};
  for (const entry of entries) {
    if (Object.hasOwn(files, entry.name))
      throw new Error(`Duplicate zip entry ${entry.name}`);
    files[entry.name] = [
      entry.data,
      { level: entry.compress ? 6 : 0, mtime: FIXED_TIME },
    ];
  }
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ZipLimits {
  /** Largest total uncompressed size accepted, in bytes. */
  maxTotalSize: number;
  /** Largest number of entries accepted. */
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxTotalSize: 4 * 1024 ** 3,
  maxEntries: 100_000,
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64_LOCATOR = 0x07064b50;

/** Entry names: ASCII, relative, "/" separated, no empty, "." or ".." segments. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  if (!/^[\x21-\x7e]+$/.test(name) || name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function damaged(detail: string): FileFormatError {
  return new FileFormatError("damaged", `The file is damaged: ${detail}.`);
}

/**
 * Reads all entries of an archive. Throws FileFormatError for anything that is not
 * a complete, intact zip archive in the subset this format uses.
 */
export function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  if (bytes.length < 22) {
    throw new FileFormatError(
      "not-zip",
      "The file is not a Galatsa file (too short to be an archive).",
    );
  }
  // The end record is at most 22 + 65535 (comment) bytes from the end.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === SIG_END && at + 22 + u16(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    if (u32(0) === SIG_LOCAL)
      throw damaged("the end of the archive is missing (was saving interrupted?)");
    throw new FileFormatError(
      "not-zip",
      "The file is not a Galatsa file (not a zip archive).",
    );
  }
  if (end >= 20 && u32(end - 20) === SIG_END64_LOCATOR) {
    throw new FileFormatError(
      "unsupported",
      "The file uses zip64, which this version of Galatsa cannot read.",
    );
  }
  const disk = u16(end + 4);
  const cdDisk = u16(end + 6);
  const count = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (disk !== 0 || cdDisk !== 0 || u16(end + 8) !== count) {
    throw new FileFormatError(
      "unsupported",
      "Archives split over several files are not supported.",
    );
  }
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new FileFormatError(
      "unsupported",
      "The file uses zip64, which this version of Galatsa cannot read.",
    );
  }
  if (count > limits.maxEntries) {
    throw new FileFormatError("too-large", `The file has too many entries (${count}).`);
  }
  if (cdOffset + cdSize > end) throw damaged("the archive directory is out of bounds");

  const entries = new Map<string, Uint8Array>();
  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== SIG_CENTRAL)
      throw damaged("the archive directory is broken");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const localOffset = u32(at + 42);
    if (at + 46 + nameLength > end) throw damaged("the archive directory is broken");
    let name = "";
    for (let k = 0; k < nameLength; k++) name += String.fromCharCode(bytes[at + 46 + k]!);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1)
      throw new FileFormatError("unsupported", "Encrypted files are not supported.");
    if (!isSafeEntryName(name))
      throw damaged(`an entry has an unsafe name (${JSON.stringify(name)})`);
    if (entries.has(name)) throw damaged(`the entry ${name} appears twice`);
    if (method !== 0 && method !== 8) {
      throw new FileFormatError(
        "unsupported",
        `The entry ${name} uses an unsupported compression method.`,
      );
    }
    if (method === 0 && compressedSize !== size)
      throw damaged(`the size of ${name} is inconsistent`);
    total += size;
    if (total > limits.maxTotalSize) {
      throw new FileFormatError(
        "too-large",
        "The file's contents are larger than the allowed limit.",
      );
    }

    if (localOffset + 30 > cdOffset || u32(localOffset) !== SIG_LOCAL) {
      throw damaged(`the entry ${name} is missing`);
    }
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (dataStart + compressedSize > cdOffset)
      throw damaged(`the entry ${name} is cut short`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else {
      try {
        // A buffer of exactly the declared size: a lying entry cannot grow past it.
        data = inflateSync(raw, { out: new Uint8Array(size) });
      } catch {
        throw damaged(`the entry ${name} cannot be decompressed`);
      }
    }
    if (data.length !== size || crc32(data) !== crc)
      throw damaged(`the entry ${name} fails its checksum`);
    entries.set(name, data);
  }
  return entries;
}
