// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { FileFormatError } from "./errors.ts";
import { fromUtf8, utf8 } from "./json.ts";
import { crc32, isSafeEntryName, readZip, writeZip } from "./zip.ts";

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
    expect(code(() => readZip(bytes, { maxTotalSize: 100_000, maxEntries: 10 }))).toBe(
      "too-large",
    );
    expect(code(() => readZip(bytes, { maxTotalSize: 2_000_000, maxEntries: 0 }))).toBe(
      "too-large",
    );
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
    expect(code(() => readZip(patched))).toBe("unsupported");
  });
});
