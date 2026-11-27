// SPDX-License-Identifier: GPL-3.0-or-later

// Reduced versions of image assets in the file (docs/adr/0012): written beside
// the assets, outside the document, read back as a cache; files without them,
// with damaged ones or with ones of names this version does not know open as
// before, and the document reads the same with and without them.

import type { AssetId } from "@galatsa/core";
import { buildSampleDocument } from "@galatsa/core/testing";
import { addAsset, addElement, toSnapshot } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readGalatsaFile, writeGalatsaFile, type WriteOptions } from "./file.ts";
import { assetIdOf } from "./hash.ts";
import { fromUtf8 } from "./json.ts";
import { isKnownEntry } from "./layout.ts";
import {
  MAX_PREVIEWS_PER_ASSET,
  normalizePreviews,
  parsePreviewEntry,
  previewEntryName,
  type AssetPreview,
} from "./previews.ts";
import { readGalatsaSnapshot } from "./read.ts";
import { openZip, readZip, writeZip } from "./zip.ts";

const ORIGINAL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 9, 9]);
const UNUSED = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

function preview(
  width: number,
  height: number,
  mediaType: AssetPreview["mediaType"] = "image/webp",
  fill = width % 251,
): AssetPreview {
  return { width, height, mediaType, bytes: new Uint8Array(64).fill(fill) };
}

async function sample(): Promise<{
  doc: Y.Doc;
  image: AssetId;
  unused: AssetId;
  assets: Map<AssetId, Uint8Array>;
  previews: Map<AssetId, AssetPreview[]>;
}> {
  const doc = buildSampleDocument(new Y.Doc(), 1);
  const image = await assetIdOf(ORIGINAL);
  const unused = await assetIdOf(UNUSED);
  addAsset(doc, image, {
    mediaType: "image/png",
    byteLength: ORIGINAL.length,
    width: 4000,
    height: 3000,
  });
  addElement(doc, {
    id: "pic",
    type: "galatsa.image/image",
    x: 0,
    y: 0,
    size: { w: 400, h: 300 },
    data: { asset: image, crop: null, opacity: 1 },
  });
  const set = [preview(1024, 768), preview(256, 192), preview(2048, 1536)];
  return {
    doc,
    image,
    unused,
    assets: new Map([
      [image, ORIGINAL],
      [unused, UNUSED],
    ]),
    previews: new Map([
      [image, set],
      [unused, [preview(256, 256)]],
    ]),
  };
}

function write(
  s: Awaited<ReturnType<typeof sample>>,
  options: WriteOptions = {},
): ReturnType<typeof writeGalatsaFile> {
  return writeGalatsaFile(s.doc, (id) => s.assets.get(id), {
    previews: (id) => s.previews.get(id),
    ...options,
  });
}

describe("previews in the file", () => {
  it("writes the previews of the assets the file carries, smallest first, and reads them back", async () => {
    const s = await sample();
    const written = write(s);
    expect(written.warnings).toEqual([]);
    const names = [...readZip(written.bytes).keys()].filter((n) =>
      n.startsWith("previews/"),
    );
    expect(names.sort()).toEqual(
      [
        `previews/${s.image}/1024x768.webp`,
        `previews/${s.image}/2048x1536.webp`,
        `previews/${s.image}/256x192.webp`,
      ].sort(),
    );
    const read = await readGalatsaFile(written.bytes);
    expect(read.warnings.filter((w) => w.code !== "asset-missing")).toEqual([]);
    expect(read.previews.get(s.image)!.map((p) => [p.width, p.height])).toEqual([
      [256, 192],
      [1024, 768],
      [2048, 1536],
    ]);
    expect(read.previews.get(s.image)![1]!.bytes).toEqual(preview(1024, 768).bytes);
    // An asset nothing refers to has no bytes in the file, and no previews.
    expect(read.previews.has(s.unused)).toBe(false);
    const player = await readGalatsaSnapshot(written.bytes);
    expect(player.previews.get(s.image)!.length).toBe(3);
  });

  it("leaves the document as it is: save and open give the same document, with merge identity", async () => {
    const s = await sample();
    const read = await readGalatsaFile(write(s).bytes);
    expect(read.snapshot).toEqual(toSnapshot(s.doc));
    expect(read.mergeIdentityKept).toBe(true);
    const without = await readGalatsaFile(
      writeGalatsaFile(s.doc, (id) => s.assets.get(id)).bytes,
    );
    expect(without.snapshot).toEqual(read.snapshot);
    expect(without.previews.size).toBe(0);
    // Previews are not in document.json or ydoc.bin.
    const entries = readZip(write(s).bytes);
    const document = fromUtf8(entries.get("document.json")!);
    expect(document).not.toContain("previews");
  });

  it("stores previews uncompressed, as views of the file", async () => {
    const s = await sample();
    const bytes = write(s).bytes;
    const read = await readGalatsaFile(bytes);
    const p = read.previews.get(s.image)![0]!;
    expect(p.bytes.buffer).toBe(bytes.buffer);
  });

  it("an export for sharing carries only the smallest preview of each image by default", async () => {
    const s = await sample();
    const shared = await readGalatsaFile(write(s, { forSharing: true }).bytes);
    expect(shared.previews.get(s.image)!.map((p) => p.width)).toEqual([256]);
    const all = await readGalatsaFile(
      write(s, { forSharing: true, previewsKept: "all" }).bytes,
    );
    expect(all.previews.get(s.image)!.length).toBe(3);
    const none = await readGalatsaFile(write(s, { previewsKept: "none" }).bytes);
    expect(none.previews.size).toBe(0);
  });

  it("writes previews of an external asset (its bytes stay outside)", async () => {
    const s = await sample();
    addAsset(s.doc, s.image, {
      mediaType: "image/png",
      byteLength: ORIGINAL.length,
      width: 4000,
      height: 3000,
      external: { path: "big.png" },
    });
    const read = await readGalatsaFile(write(s).bytes);
    expect(read.assets.has(s.image)).toBe(false);
    expect(read.previews.get(s.image)!.length).toBe(3);
  });

  it("writes the file without previews when it would not fit with them", async () => {
    const s = await sample();
    const size = writeGalatsaFile(s.doc, (id) => s.assets.get(id)).bytes.length;
    const written = write(s, { limits: { maxFileSize: size + 10 } });
    expect(written.warnings.map((w) => w.code)).toEqual(["previews-not-written"]);
    const read = await readGalatsaFile(written.bytes);
    expect(read.previews.size).toBe(0);
    expect(read.snapshot).toEqual(toSnapshot(s.doc));
  });

  it("a preview source that throws costs the previews, not the save", async () => {
    const s = await sample();
    const written = writeGalatsaFile(s.doc, (id) => s.assets.get(id), {
      previews: () => {
        throw new Error("store gone");
      },
    });
    expect((await readGalatsaFile(written.bytes)).snapshot).toEqual(toSnapshot(s.doc));
  });
});

describe("older and odd files", () => {
  it("a file without previews (as version 1 wrote them before) opens with none", async () => {
    const s = await sample();
    const read = await readGalatsaFile(
      writeGalatsaFile(s.doc, (id) => s.assets.get(id)).bytes,
    );
    expect(read.previews.size).toBe(0);
    expect(read.warnings.filter((w) => w.code !== "asset-missing")).toEqual([]);
  });

  it("a reader that does not know previews skips them unread and reads the same document", async () => {
    const s = await sample();
    const bytes = write(s).bytes;
    // What version 1 accepted before previews were added.
    const before = (name: string): boolean =>
      isKnownEntry(name) && !name.startsWith("previews/");
    const { entries, damaged } = openZip(bytes, undefined, before);
    expect([...entries.keys()].some((n) => n.startsWith("previews/"))).toBe(false);
    expect(damaged.size).toBe(0);
  });

  it("ignores entries under previews/ whose names are not previews, and damaged previews", async () => {
    const s = await sample();
    const bytes = write(s).bytes;
    const entries = readZip(bytes);
    const good = `previews/${s.image}/256x192.webp`;
    const odd = [
      `previews/${s.image}/0x10.webp`,
      `previews/${s.image}/10x10.gif`,
      `previews/${s.image}/99999x10.png`,
      `previews/sha256-abc/10x10.png`,
      `previews/${s.image}/10x10.webp/more`,
      `previews/${s.image}`,
    ];
    const parts = [...entries].map(([name, data]) => ({
      name,
      data,
      compress: name === "document.json" || name === "ydoc.bin",
    }));
    for (const name of odd)
      parts.push({ name, data: new Uint8Array([1]), compress: false });
    const rebuilt = writeZip(parts);
    // Damage the good preview's bytes in place: the archive's checksum catches it.
    const at = indexOf(rebuilt, entries.get(good)!);
    rebuilt[at] = rebuilt[at]! ^ 0xff;
    const read = await readGalatsaFile(rebuilt);
    expect(read.previews.get(s.image)!.map((p) => p.width)).toEqual([1024, 2048]);
    expect(read.warnings.filter((w) => w.code !== "asset-missing")).toEqual([]);
    expect(read.snapshot).toEqual(toSnapshot(s.doc));
  });
});

describe("preview names and lists", () => {
  it("parses only well-formed names", async () => {
    const id = await assetIdOf(ORIGINAL);
    const name = previewEntryName(id, {
      width: 512,
      height: 384,
      mediaType: "image/jpeg",
    });
    expect(name).toBe(`previews/${id}/512x384.jpg`);
    expect(parsePreviewEntry(name)).toEqual({
      asset: id,
      facts: { width: 512, height: 384, mediaType: "image/jpeg" },
    });
    expect(parsePreviewEntry(`previews/${id}/0512x384.jpg`)).toBeNull();
    expect(parsePreviewEntry(`previews/${id}/16385x2.png`)).toBeNull();
    expect(parsePreviewEntry(`previews/${id}/16384x2.png`)).not.toBeNull();
  });

  it("keeps valid previews, one per size, smallest first, at most eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => preview(1000 - i * 10, 10));
    const list = normalizePreviews([
      preview(300, 200),
      preview(300, 200, "image/png"),
      { ...preview(10, 10), bytes: new Uint8Array(0) },
      { ...preview(10, 10), width: 1.5 },
      { ...preview(10, 10), mediaType: "image/gif" as "image/png" },
      ...many,
    ]);
    expect(list.length).toBe(MAX_PREVIEWS_PER_ASSET);
    expect(list[0]).toEqual(preview(300, 200));
    expect(list.map((p) => p.width)).toEqual(
      [...list.map((p) => p.width)].sort((a, b) => a - b),
    );
    expect(normalizePreviews(list, "smallest")).toEqual([preview(300, 200)]);
    expect(normalizePreviews(list, "none")).toEqual([]);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  throw new Error("not found");
}
