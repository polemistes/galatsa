// SPDX-License-Identifier: GPL-3.0-or-later

// The zip container of a Galatsa file. Writing uses fflate's zipSync. Reading
// parses the archive directory here and uses only fflate's streaming inflate, so
// that there is one way to read an archive (no comment, no gaps, no overlapping
// entries), every entry's CRC-32 is verified, no entry can inflate past its
// declared size, and one damaged entry does not make the others unreadable.
// Sections 9.1, 9.7 and 9.8 of docs/adr/0001-document-model-and-file-format.md.

import { Inflate, deflateSync } from "fflate";
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

/** Largest archive, and largest entry count, that zip can hold without zip64. */
export const MAX_ZIP_SIZE = 0xffffffff;
export const MAX_ZIP_ENTRIES = 0xfffe;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** MS-DOS date of 1980-01-01: a fixed time, so equal content gives equal bytes. */
const FIXED_DATE = 0x0021;

function tooLarge(detail: string): FileFormatError {
  return new FileFormatError(
    "too-large",
    `The file cannot be written: ${detail}. Very large media can be kept in a file next to the presentation.`,
  );
}

/**
 * Writes entries in the given order, in the strict subset of zip that Galatsa
 * files use (section 9.1): no flags, no extra fields, no comment, nothing
 * between the entries, the same sizes and checksum in each local header as in
 * the directory. Zip without zip64 ends at 4 GiB and 65 534 entries; an archive
 * that would not fit is refused (FileFormatError "too-large") instead of being
 * written with offsets that wrap around.
 */
export function writeZip(
  entries: readonly ZipEntryInput[],
  maxSize: number = MAX_ZIP_SIZE,
): Uint8Array {
  const limit = Math.min(maxSize, MAX_ZIP_SIZE);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw tooLarge(`it would have ${entries.length} entries, more than zip allows`);
  }
  const names = new Set<string>();
  const overhead = (name: string) => 30 + name.length + 46 + name.length;
  // Before compressing anything: what is stored as it is must fit already.
  let total = 22;
  for (const entry of entries) {
    if (!isSafeEntryName(entry.name))
      throw new Error(`Unsafe zip entry name ${entry.name}`);
    if (names.has(entry.name)) throw new Error(`Duplicate zip entry ${entry.name}`);
    names.add(entry.name);
    total += overhead(entry.name) + (entry.compress ? 0 : entry.data.length);
    if (total > limit) throw tooLarge("it would be larger than 4 GiB");
  }
  const parts = entries.map((entry) => {
    const stored = entry.compress ? deflateSync(entry.data, { level: 6 }) : entry.data;
    total += entry.compress ? stored.length : 0;
    if (total > limit) throw tooLarge("it would be larger than 4 GiB");
    return { entry, stored, crc: crc32(entry.data) };
  });

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const header = (at: number, part: (typeof parts)[number]): number => {
    view.setUint16(at, 20, true); // version needed: 2.0
    view.setUint16(at + 2, 0, true); // flags: none
    view.setUint16(at + 4, part.entry.compress ? 8 : 0, true);
    view.setUint16(at + 6, 0, true); // time
    view.setUint16(at + 8, FIXED_DATE, true);
    view.setUint32(at + 10, part.crc, true);
    view.setUint32(at + 14, part.stored.length, true);
    view.setUint32(at + 18, part.entry.data.length, true);
    view.setUint16(at + 22, part.entry.name.length, true);
    view.setUint16(at + 24, 0, true); // extra field: none
    return at + 26;
  };
  const name = (at: number, text: string): number => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
    return at + text.length;
  };
  let at = 0;
  const offsets: number[] = [];
  for (const part of parts) {
    offsets.push(at);
    view.setUint32(at, SIG_LOCAL, true);
    at = name(header(at + 4, part), part.entry.name);
    out.set(part.stored, at);
    at += part.stored.length;
  }
  const directory = at;
  parts.forEach((part, i) => {
    view.setUint32(at, SIG_CENTRAL, true);
    view.setUint16(at + 4, 20, true); // version made by
    const rest = header(at + 6, part);
    // comment length, disk, internal and external attributes: all zero
    view.setUint32(rest + 10, offsets[i]!, true);
    at = name(rest + 14, part.entry.name);
  });
  view.setUint32(at, SIG_END, true);
  view.setUint16(at + 8, parts.length, true);
  view.setUint16(at + 10, parts.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ZipLimits {
  /**
   * Largest total size, in bytes, of the entries that have to be decompressed.
   * Stored entries are returned as views of the input and cost no memory, so
   * reading a file needs at most the file itself plus this much.
   */
  maxInflatedSize: number;
  /** Largest number of entries accepted. */
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxInflatedSize: 512 * 1024 ** 2,
  maxEntries: MAX_ZIP_ENTRIES,
};
const SIG_END64_LOCATOR = 0x07064b50;
/** Header id of the zip64 extra field. */
const EXTRA_ZIP64 = 0x0001;

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

/** Size of the compressed chunks fed to the inflater (bounds work per step). */
const INFLATE_CHUNK = 16 * 1024;

/**
 * Inflates `raw` into exactly `size` bytes, feeding small chunks and stopping as
 * soon as the output would exceed `size`. The output buffer grows with the data,
 * so an entry that declares a large size but holds little costs little.
 */
function inflateBounded(raw: Uint8Array, size: number): Uint8Array | null {
  let out = new Uint8Array(Math.min(size, Math.max(64 * 1024, raw.length * 4)));
  let at = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    if (overflow) return;
    if (at + chunk.length > size) {
      overflow = true;
      return;
    }
    if (at + chunk.length > out.length) {
      const grown = new Uint8Array(
        Math.min(size, Math.max(out.length * 2, at + chunk.length)),
      );
      grown.set(out.subarray(0, at));
      out = grown;
    }
    out.set(chunk, at);
    at += chunk.length;
  });
  try {
    for (let offset = 0; offset < raw.length && !overflow; offset += INFLATE_CHUNK) {
      const end = Math.min(raw.length, offset + INFLATE_CHUNK);
      inflater.push(raw.subarray(offset, end), end === raw.length);
    }
    if (raw.length === 0) inflater.push(raw, true);
  } catch {
    return null;
  }
  return overflow || at !== size ? null : out.subarray(0, size);
}

export interface ZipContents {
  /**
   * The accepted entries that are intact. Stored entries are views of the input
   * bytes: they are valid as long as the input is not changed.
   */
  entries: Map<string, Uint8Array>;
  /** Accepted entries that cannot be decompressed or fail their checksum. */
  damaged: Set<string>;
}

/**
 * Opens an archive. Entries for which `accept` returns false are checked
 * structurally but not decompressed or kept. Throws FileFormatError for anything
 * that is not a complete zip archive in the subset this format uses: an archive
 * comment or bytes after the archive, gaps or overlapping entries, local
 * headers that differ from the directory in name, sizes, checksum, method or
 * flags, sizes kept after the data, unsafe or duplicate names, encryption, zip64
 * (reported as needing a newer version), and archives over the limits. An entry whose own data is damaged is reported in `damaged`; the
 * others are still read.
 */
export function openZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  accept: (name: string) => boolean = () => true,
): ZipContents {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  if (bytes.length < 22) {
    throw new FileFormatError(
      "not-zip",
      "The file is not a Galatsa file (too short to be an archive).",
    );
  }
  // Galatsa files have no archive comment, so the end record is the last 22
  // bytes. This leaves no room for a second archive hidden in a comment.
  const end = bytes.length - 22;
  if (u32(end) !== SIG_END || u16(end + 20) !== 0) {
    for (let at = end; at >= Math.max(0, end - 0xffff); at--) {
      if (u32(at) === SIG_END && at + 22 + u16(at + 20) === bytes.length) {
        throw damaged("the archive has a comment, which Galatsa files never have");
      }
    }
    if (u32(0) === SIG_LOCAL) {
      throw damaged("the end of the archive is missing (was saving interrupted?)");
    }
    throw new FileFormatError(
      "not-zip",
      "The file is not a Galatsa file (not a zip archive).",
    );
  }
  const zip64 = () =>
    new FileFormatError(
      "newer-version",
      "The file is larger than 4 GiB (zip64) and needs a newer version of Galatsa.",
    );
  if (end >= 20 && u32(end - 20) === SIG_END64_LOCATOR) throw zip64();
  const disk = u16(end + 4);
  const cdDisk = u16(end + 6);
  const count = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw zip64();
  if (disk !== 0 || cdDisk !== 0 || u16(end + 8) !== count) {
    throw new FileFormatError(
      "unsupported",
      "Archives split over several files are not supported.",
    );
  }
  if (count > limits.maxEntries) {
    throw new FileFormatError("too-large", `The file has too many entries (${count}).`);
  }
  if (cdOffset + cdSize !== end) throw damaged("the archive directory is out of place");

  interface Pending {
    name: string;
    method: number;
    crc: number;
    size: number;
    start: number;
    dataStart: number;
    compressedSize: number;
  }
  const pending: Pending[] = [];
  const names = new Set<string>();
  let inflated = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== SIG_CENTRAL) {
      throw damaged("the archive directory is broken");
    }
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const localOffset = u32(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw damaged("the archive directory is broken");
    const name = latin1(bytes, at + 46, nameLength);
    // A size or offset of 0xFFFFFFFF, or a zip64 extra field, means zip64.
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw zip64();
    for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength;) {
      if (u16(x) === EXTRA_ZIP64) throw zip64();
      x += 4 + u16(x + 2);
    }
    at = next;

    if (flags & 0x1)
      throw new FileFormatError("unsupported", "Encrypted files are not supported.");
    // Sizes after the data ("data descriptor") are not used: a local header
    // then says nothing, and a reader that trusts it finds something else.
    if (flags & 0x8) throw damaged(`the entry ${name} keeps its size after its data`);
    if (!isSafeEntryName(name)) {
      throw damaged(`an entry has an unsafe name (${JSON.stringify(name)})`);
    }
    if (names.has(name)) throw damaged(`the entry ${name} appears twice`);
    names.add(name);
    if (method !== 0 && method !== 8) {
      throw new FileFormatError(
        "unsupported",
        `The entry ${name} uses an unsupported compression method.`,
      );
    }
    if (method === 0 && compressedSize !== size) {
      throw damaged(`the size of ${name} is inconsistent`);
    }
    if (localOffset + 30 > cdOffset || u32(localOffset) !== SIG_LOCAL) {
      throw damaged(`the entry ${name} is missing`);
    }
    const localNameLength = u16(localOffset + 26);
    if (
      localNameLength !== nameLength ||
      latin1(bytes, localOffset + 30, nameLength) !== name
    ) {
      throw damaged(`the entry ${name} has a different name in its local header`);
    }
    // The local header says the same as the directory, so that a reader which
    // goes by local headers finds the same archive.
    if (
      u16(localOffset + 6) !== flags ||
      u16(localOffset + 8) !== method ||
      u32(localOffset + 14) !== crc ||
      u32(localOffset + 18) !== compressedSize ||
      u32(localOffset + 22) !== size
    ) {
      throw damaged(`the entry ${name} is described differently in its local header`);
    }
    const dataStart = localOffset + 30 + localNameLength + u16(localOffset + 28);
    if (dataStart + compressedSize > cdOffset)
      throw damaged(`the entry ${name} is cut short`);
    if (method === 8 && accept(name)) {
      inflated += size;
      if (inflated > limits.maxInflatedSize) {
        throw new FileFormatError(
          "too-large",
          "The file's compressed contents are larger than the allowed limit.",
        );
      }
    }
    pending.push({
      name,
      method,
      crc,
      size,
      start: localOffset,
      dataStart,
      compressedSize,
    });
  }
  if (at !== end) throw damaged("the archive directory is broken");

  // Every byte of the file belongs to exactly one entry, the directory or the
  // end record: entries do not overlap, and there is nothing before, between or
  // after them. So a file cannot hold a second archive that another reader
  // would find instead.
  const ranges = [...pending].sort((a, b) => a.start - b.start);
  let expected = 0;
  for (const entry of ranges) {
    if (entry.start < expected)
      throw damaged(`the entry ${entry.name} overlaps another entry`);
    if (entry.start > expected)
      throw damaged("the archive holds bytes that belong to no entry");
    expected = entry.dataStart + entry.compressedSize;
  }
  if (expected !== cdOffset)
    throw damaged("the archive holds bytes that belong to no entry");

  const contents: ZipContents = { entries: new Map(), damaged: new Set() };
  for (const entry of pending) {
    if (!accept(entry.name)) continue;
    const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    const data = entry.method === 0 ? raw : inflateBounded(raw, entry.size);
    if (data === null || crc32(data) !== entry.crc) contents.damaged.add(entry.name);
    else contents.entries.set(entry.name, data);
  }
  return contents;
}

/** Reads the entries of an archive; throws if any accepted entry is damaged. */
export function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  accept: (name: string) => boolean = () => true,
): Map<string, Uint8Array> {
  const contents = openZip(bytes, limits, accept);
  for (const name of contents.damaged) {
    throw damaged(`the entry ${name} fails its checksum`);
  }
  return contents.entries;
}

function latin1(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let k = 0; k < length; k++) out += String.fromCharCode(bytes[start + k]!);
  return out;
}
