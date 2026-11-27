// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { FileFormatError } from "./errors.ts";
import { deflateSync } from "fflate";
import { fromUtf8, utf8 } from "./json.ts";
import { crc32, isSafeEntryName, readZip, writeZip } from "./zip.ts";

// Counts the compressed bytes the reader feeds to fflate's streaming inflater, so
// a test can check how much work the reader did without measuring time.
const inflateInput = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("fflate", async (importOriginal) => {
  const real = await importOriginal<typeof import("fflate")>();
  class Inflate extends real.Inflate {
    override push(chunk: Uint8Array, final?: boolean): void {
      inflateInput.bytes += chunk.length;
      super.push(chunk, final);
    }
  }
  return { ...real, Inflate };
});

function replaceAll(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const out = bytes.slice();
  const f = utf8(from);
  const t = utf8(to);
  for (let i = 0; i + f.length <= out.length; i++) {
    if (f.every((b, k) => out[i + k] === b)) out.set(t, i);
  }
  return out;
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof FileFormatError ? error.code : `other: ${String(error)}`;
  }
  return undefined;
}

describe("zip container", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("writes and reads stored and deflated entries in order", () => {
    const big = utf8("galatsa ".repeat(10_000));
    const bytes = writeZip([
      { name: "mimetype", data: utf8("x/y"), compress: false },
      { name: "a/b.json", data: big, compress: true },
      { name: "empty", data: new Uint8Array(0), compress: true },
    ]);
    expect(bytes.length).toBeLessThan(big.length / 10);
    // The first entry's name is right after the first local header.
    expect(fromUtf8(bytes.subarray(30, 38))).toBe("mimetype");
    const entries = readZip(bytes);
    expect([...entries.keys()]).toEqual(["mimetype", "a/b.json", "empty"]);
    expect(entries.get("a/b.json")).toEqual(big);
    expect(entries.get("empty")).toEqual(new Uint8Array(0));
  });

  it("gives the same bytes for the same content", () => {
    const make = () => writeZip([{ name: "a", data: utf8("same"), compress: true }]);
    expect(make()).toEqual(make());
  });

  it("rejects unsafe names", () => {
    for (const bad of [
      "",
      "/abs",
      "a/../b",
      "..",
      "a//b",
      "a\\b",
      "ä",
      "a/./b",
      "sp ace",
    ]) {
      expect(isSafeEntryName(bad)).toBe(false);
    }
    expect(isSafeEntryName("assets/sha256-00")).toBe(true);
    const bytes = replaceAll(
      writeZip([{ name: "zz/x", data: utf8("1"), compress: false }]),
      "zz/x",
      "../x",
    );
    expect(code(() => readZip(bytes))).toBe("damaged");
  });

  it("rejects duplicate entries", () => {
    const bytes = writeZip([
      { name: "dup1", data: utf8("first"), compress: false },
      { name: "dup2", data: utf8("second"), compress: false },
    ]);
    expect(code(() => readZip(replaceAll(bytes, "dup2", "dup1")))).toBe("damaged");
  });

  it("detects truncation, corruption and non-archives", () => {
    const data = utf8("some content that compresses ".repeat(100));
    const bytes = writeZip([{ name: "doc.json", data, compress: true }]);
    expect(code(() => readZip(bytes.subarray(0, bytes.length - 30)))).toBe("damaged");
    const corrupt = bytes.slice();
    corrupt[60] = corrupt[60]! ^ 0xff;
    expect(code(() => readZip(corrupt))).toBe("damaged");
    expect(code(() => readZip(utf8("just some text, not an archive at all")))).toBe(
      "not-zip",
    );
    expect(code(() => readZip(new Uint8Array(3)))).toBe("not-zip");
  });

  it("enforces size limits before inflating", () => {
    const bytes = writeZip([
      { name: "big", data: new Uint8Array(1_000_000), compress: true },
    ]);
    expect(bytes.length).toBeLessThan(10_000);
    expect(code(() => readZip(bytes, { maxInflatedSize: 100_000, maxEntries: 10 }))).toBe(
      "too-large",
    );
    expect(
      code(() => readZip(bytes, { maxInflatedSize: 2_000_000, maxEntries: 0 })),
    ).toBe("too-large");
  });

  it("refuses zip64 archives with a clear code", () => {
    const bytes = writeZip([{ name: "a", data: utf8("1"), compress: false }]);
    const end = bytes.length - 22;
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    const patched = new Uint8Array(bytes.length + 20);
    patched.set(bytes.subarray(0, end), 0);
    patched.set(locator, end);
    patched.set(bytes.subarray(end), end + 20);
    expect(code(() => readZip(patched))).toBe("newer-version");
  });
});

/** Builds an archive by hand: one local entry and central records pointing at it. */
function handMade(
  localName: string,
  compressed: Uint8Array,
  size: number,
  crc: number,
  centralNames: string[],
): Uint8Array {
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [
    v & 255,
    (v >>> 8) & 255,
    (v >>> 16) & 255,
    (v >>> 24) & 255,
  ];
  const name = (n: string) => [...utf8(n)];
  const local = [
    ...u32(0x04034b50),
    ...u16(20),
    ...u16(0),
    ...u16(8),
    ...u16(0),
    ...u16(0),
    ...u32(crc),
    ...u32(compressed.length),
    ...u32(size),
    ...u16(localName.length),
    ...u16(0),
    ...name(localName),
  ];
  const central: number[] = [];
  for (const n of centralNames) {
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(compressed.length),
      ...u32(size),
      ...u16(n.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(0),
      ...name(n),
    );
  }
  const cdOffset = local.length + compressed.length;
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(centralNames.length),
    ...u16(centralNames.length),
    ...u32(central.length),
    ...u32(cdOffset),
    ...u16(0),
  ];
  const out = new Uint8Array(cdOffset + central.length + end.length);
  out.set(local, 0);
  out.set(compressed, local.length);
  out.set(central, cdOffset);
  out.set(end, cdOffset + central.length);
  return out;
}

describe("zip reader limits (review findings)", () => {
  it("rejects entries that share bytes (a tiny file cannot fill memory)", () => {
    const raw = new Uint8Array(4 * 1024 * 1024);
    const file = handMade("a", deflateSync(raw), raw.length, crc32(raw), ["a", "b", "c"]);
    expect(file.length).toBeLessThan(20_000);
    expect(code(() => readZip(file))).toBe("damaged");
  });

  it("stops inflating as soon as an entry exceeds its declared size", () => {
    const raw = new Uint8Array(64 * 1024 * 1024);
    const file = handMade(
      "a",
      deflateSync(raw, { level: 9 }),
      1,
      crc32(new Uint8Array(1)),
      ["a"],
    );
    const compressed = deflateSync(raw, { level: 9 });
    inflateInput.bytes = 0;
    expect(code(() => readZip(file))).toBe("damaged");
    // The first chunk (16 KiB of compressed input) already overflows the declared
    // size; the reader must stop there instead of inflating all 64 MiB.
    expect(inflateInput.bytes).toBeGreaterThan(0);
    expect(inflateInput.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(inflateInput.bytes).toBeLessThan(compressed.length);
  });

  it("rejects a local header whose name differs from the directory", () => {
    const raw = utf8("hello");
    const file = handMade("x", deflateSync(raw), raw.length, crc32(raw), ["a"]);
    expect(code(() => readZip(file))).toBe("damaged");
  });

  it("skips entries the caller does not accept, without decompressing them", () => {
    const raw = new Uint8Array(1024);
    const bytes = writeZip([
      { name: "keep", data: utf8("k"), compress: true },
      { name: "other", data: raw, compress: true },
    ]);
    const entries = readZip(
      bytes,
      { maxInflatedSize: 10, maxEntries: 10 },
      (n) => n === "keep",
    );
    expect([...entries.keys()]).toEqual(["keep"]);
  });
});
