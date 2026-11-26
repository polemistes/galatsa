// SPDX-License-Identifier: GPL-3.0-or-later

// Regression tests for the defects the third review found in the file format:
// the writer never writes a file the default reader refuses or cannot read, an
// archive has one reading, and versions never go down. Sections 9.1, 9.4 and
// 9.7 of docs/adr/0001-document-model-and-file-format.md.

import { SCHEMA_VERSION, type AssetId } from "@galatsa/core";
import {
  addAsset,
  addElement,
  createUndoManager,
  dataMap,
  forkDoc,
  initDocument,
  moveElement,
  raiseVersions,
  setExt,
  syncDocs,
  toSnapshot,
  versionsOf,
} from "@galatsa/core/ydoc";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FileFormatError } from "./errors.ts";
import { readGalatsaFile, writeGalatsaFile } from "./file.ts";
import { assetIdOf } from "./hash.ts";
import { fromUtf8, utf8 } from "./json.ts";
import { MAX_DOCUMENT_SIZE, MAX_YDOC_SIZE } from "./layout.ts";
import { readGalatsaSnapshot } from "./read.ts";
import {
  DEFAULT_ZIP_LIMITS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SIZE,
  openZip,
  readZip,
  writeZip,
} from "./zip.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const none = () => undefined;

function base(): Y.Doc {
  const doc = new Y.Doc();
  initDocument(doc, { id: "d" });
  addElement(doc, {
    id: "X",
    type: "galatsa.shapes/shape",
    x: 0,
    y: 0,
    size: { w: 1, h: 1 },
  });
  return doc;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (error) {
    return error instanceof FileFormatError ? error.code : `other: ${String(error)}`;
  }
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return error instanceof FileFormatError ? error.code : `other: ${String(error)}`;
  }
}

/** Offset of an entry's local header and of its directory record. */
function locate(bytes: Uint8Array, name: string): { local: number; central: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = { local: -1, central: -1 };
  for (let i = 0; i + 46 < bytes.length; i++) {
    const signature = view.getUint32(i, true);
    const at = signature === 0x04034b50 ? 26 : signature === 0x02014b50 ? 28 : -1;
    if (at < 0) continue;
    const length = view.getUint16(i + at, true);
    const start = i + (at === 26 ? 30 : 46);
    if (String.fromCharCode(...bytes.subarray(start, start + length)) !== name) continue;
    if (at === 26) found.local = i;
    else found.central = i;
  }
  return found;
}

describe("review 3: what the writer writes, the default reader opens", () => {
  it("assets are stored, never compressed, whatever their type", async () => {
    const doc = base();
    const assets = new Map<AssetId, Uint8Array>();
    for (const [mediaType, fill] of [
      ["application/pdf", 0],
      ["image/tiff", 1],
      ["image/svg+xml", 2],
      ["application/octet-stream", 3],
    ] as const) {
      const bytes = new Uint8Array(60_000).fill(fill);
      const id = await assetIdOf(bytes);
      assets.set(id, bytes);
      addAsset(doc, id, { mediaType, byteLength: bytes.length });
      setExt(doc, "X", `test.asset${fill}`, id);
    }
    const { bytes, warnings } = writeGalatsaFile(doc, (id) => assets.get(id));
    expect(warnings).toEqual([]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const id of assets.keys()) {
      expect(view.getUint16(locate(bytes, `assets/${id}`).central + 10, true)).toBe(0);
    }
    // The four assets are 240 kB, far over this limit; they do not count,
    // because nothing has to be decompressed to read them.
    const read = await readGalatsaFile(bytes, {
      limits: { maxInflatedSize: 20_000, maxEntries: 100 },
    });
    expect(read.assets.size).toBe(4);
    for (const [id, data] of read.assets) {
      expect(data.buffer).toBe(bytes.buffer);
      expect(data).toEqual(assets.get(id));
    }
    await expect(readGalatsaSnapshot(bytes)).resolves.toBeDefined();
  });

  it("the writer's own limits are the reader's defaults", () => {
    expect(MAX_DOCUMENT_SIZE + MAX_YDOC_SIZE).toBeLessThanOrEqual(
      DEFAULT_ZIP_LIMITS.maxInflatedSize,
    );
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBe(MAX_ZIP_ENTRIES);
  });

  it("a document too large for a reader is refused, a Yjs state too large is left out", async () => {
    const doc = base();
    expect(
      codeOf(() => writeGalatsaFile(doc, none, { limits: { maxDocumentSize: 100 } })),
    ).toBe("too-large");
    const written = writeGalatsaFile(doc, none, { limits: { maxYdocSize: 100 } });
    expect(written.warnings.map((w) => w.code)).toEqual(["ydoc-not-written"]);
    expect([...readZip(written.bytes).keys()]).not.toContain("ydoc.bin");
    const read = await readGalatsaFile(written.bytes);
    expect(read.snapshot).toEqual(toSnapshot(doc));
    expect(read.mergeIdentityKept).toBe(false);
  });

  it("a file that would not fit in a zip archive is refused, not written wrong", async () => {
    const doc = base();
    const media = new Uint8Array(50_000).fill(9);
    const id = await assetIdOf(media);
    addAsset(doc, id, { mediaType: "video/mp4", byteLength: media.length });
    setExt(doc, "X", "test.media", id);
    const source = (asset: AssetId) => (asset === id ? media : undefined);
    const size = writeGalatsaFile(doc, source).bytes.length;
    // Exactly at the limit it is written; one byte under the size, refused.
    expect(
      writeGalatsaFile(doc, source, { limits: { maxFileSize: size } }).bytes.length,
    ).toBe(size);
    let error: unknown;
    try {
      writeGalatsaFile(doc, source, { limits: { maxFileSize: size - 1 } });
    } catch (caught) {
      error = caught;
    }
    expect((error as FileFormatError).code).toBe("too-large");
    expect((error as Error).message).toMatch(/4 GiB/);
    expect((error as Error).message).toMatch(/next to the presentation/);
    // The limit of the format itself cannot be raised.
    expect(codeOf(() => writeZip([], MAX_ZIP_SIZE * 2))).toBe("no error");
    const entry = { name: "a", data: new Uint8Array(10), compress: false };
    expect(codeOf(() => writeZip([entry], 10))).toBe("too-large");
    // Compressed entries count with their compressed size.
    const text = { name: "t", data: utf8("a".repeat(100_000)), compress: true };
    expect(writeZip([text], 2000).length).toBeLessThan(2000);
  });

  it("more entries than zip can count are refused", () => {
    const data = new Uint8Array(0);
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `e${i}`,
      data,
      compress: false,
    }));
    expect(codeOf(() => writeZip(entries))).toBe("too-large");
    const most = writeZip(entries.slice(0, MAX_ZIP_ENTRIES));
    expect(openZip(most, DEFAULT_ZIP_LIMITS, () => false).damaged.size).toBe(0);
  });

  it.runIf(env?.GALATSA_HEAVY === "1")(
    "really more than 4 GiB is refused (run with GALATSA_HEAVY=1)",
    () => {
      const chunk = new Uint8Array(900 * 1024 ** 2);
      const entries = [0, 1, 2, 3, 4].map((i) => ({
        name: `assets/video${i}`,
        data: chunk,
        compress: false,
      }));
      expect(codeOf(() => writeZip(entries))).toBe("too-large");
      expect(writeZip(entries.slice(0, 4)).length).toBeGreaterThan(3.5 * 1024 ** 3);
    },
    600_000,
  );

  it("what is written is plain zip that another reader reads the same", async () => {
    const doc = base();
    const media = new Uint8Array(5000).fill(4);
    const id = await assetIdOf(media);
    addAsset(doc, id, { mediaType: "image/png", byteLength: media.length });
    setExt(doc, "X", "test.media", id);
    const { bytes } = writeGalatsaFile(doc, () => media, {
      thumbnail: new Uint8Array([1, 2]),
    });
    const ours = readZip(bytes);
    const theirs = unzipSync(bytes);
    expect(Object.keys(theirs)).toEqual([...ours.keys()]);
    for (const [name, data] of ours) expect(theirs[name]).toEqual(data);
    expect([...ours.keys()].slice(0, 3)).toEqual([
      "mimetype",
      "manifest.json",
      "document.json",
    ]);
    expect(
      writeGalatsaFile(doc, () => media, { thumbnail: new Uint8Array([1, 2]) }).bytes,
    ).toEqual(bytes);
  });

  it("text that was typed and deleted is not in the file", async () => {
    const doc = base();
    const undo = createUndoManager(doc, { captureTimeout: 0, origins: ["binding"] });
    const text = new Y.Text();
    doc.transact(() => dataMap(doc, "X").set("text", text), "binding");
    doc.transact(() => text.insert(0, "SALARY 900000"), "binding");
    doc.transact(() => text.delete(0, text.length), "binding");
    moveElement(doc, "X", 5, 5);
    moveElement(doc, "X", 6, 6);
    // The running program still has it, for undo.
    expect(fromUtf8(Y.encodeStateAsUpdate(doc))).toContain("SALARY 900000");
    const peer = forkDoc(doc, 7);
    const { bytes } = writeGalatsaFile(doc, none);
    expect(fromUtf8(readZip(bytes).get("ydoc.bin")!)).not.toContain("SALARY");
    expect(fromUtf8(readZip(bytes).get("document.json")!)).not.toContain("SALARY");
    // The file is still the same replica, and undo still works in the session.
    const read = await readGalatsaFile(bytes);
    expect(read.mergeIdentityKept).toBe(true);
    moveElement(peer, "X", 7, 7);
    syncDocs(read.doc, peer);
    expect(toSnapshot(read.doc)).toEqual(toSnapshot(peer));
    undo.undo();
    undo.undo();
    undo.undo();
    expect(text.toString()).toBe("SALARY 900000");
  });

  it("content that refers to an asset without a description is reported, and its bytes are kept", async () => {
    const doc = base();
    const video = new Uint8Array(3000).fill(8);
    const id = await assetIdOf(video);
    setExt(doc, "X", "test.media", id);
    const { bytes } = writeGalatsaFile(doc, () => video);
    const read = await readGalatsaFile(bytes);
    expect(read.assets.get(id)).toEqual(video);
    expect(read.warnings.map((w) => w.code)).toEqual(["asset-undescribed"]);
  });
});

describe("review 3: an archive has one reading", () => {
  const archive = () =>
    writeZip([
      { name: "mimetype", data: utf8("x/y"), compress: false },
      { name: "document.json", data: utf8('{"a":1}'.repeat(50)), compress: true },
    ]);

  it("a local header that says something else than the directory is refused", () => {
    // The reviewer's case: sizes and checksum zeroed in the local header only,
    // so that a reader going by local headers finds another archive inside.
    const inner = writeZip([
      { name: "document.json", data: utf8('{"evil":true}'), compress: false },
    ]);
    const outer = writeZip([{ name: "thumbnail.png", data: inner, compress: false }]);
    const patched = outer.slice();
    const view = new DataView(patched.buffer);
    view.setUint32(14, 0, true);
    view.setUint32(18, 0, true);
    view.setUint32(22, 0, true);
    expect(() => openZip(patched)).toThrow(/described differently/);
    // Each field on its own.
    const good = archive();
    const { local } = locate(good, "document.json");
    for (const [offset, width] of [
      [6, 2],
      [8, 2],
      [14, 4],
      [18, 4],
      [22, 4],
    ] as const) {
      const bad = good.slice();
      const v = new DataView(bad.buffer);
      if (width === 2)
        v.setUint16(local + offset, v.getUint16(local + offset, true) ^ 0x800, true);
      else v.setUint32(local + offset, v.getUint32(local + offset, true) + 1, true);
      expect(
        codeOf(() => openZip(bad)),
        `offset ${offset}`,
      ).toBe("damaged");
    }
    expect(codeOf(() => openZip(good))).toBe("no error");
  });

  it("sizes kept after the data (a data descriptor) are refused", () => {
    const good = archive();
    const { local, central } = locate(good, "document.json");
    const bad = good.slice();
    const view = new DataView(bad.buffer);
    view.setUint16(local + 6, 0x8, true);
    view.setUint16(central + 8, 0x8, true);
    expect(() => openZip(bad)).toThrow(/after its data/);
  });
});

describe("review 3: versions never go down", () => {
  it("a Yjs state that needs a newer reader than the manifest says is not opened", async () => {
    const doc = base();
    const good = writeGalatsaFile(doc, none).bytes;
    raiseVersions(doc, { minReaderVersion: SCHEMA_VERSION + 1 });
    const entries = new Map<string, Uint8Array>(readZip(good));
    entries.set("ydoc.bin", Y.encodeStateAsUpdate(doc));
    const crafted = writeZip(
      [...entries].map(([name, data]) => ({ name, data, compress: name === "ydoc.bin" })),
    );
    expect(await failure(readGalatsaFile(crafted))).toBe("newer-version");
  });

  it("opening a file never lowers what its Yjs state says", async () => {
    const doc = base();
    const good = writeGalatsaFile(doc, none).bytes;
    // A compatible newer writer raised the content version in the Yjs state;
    // an older tool rewrote manifest and document.json with the old number.
    raiseVersions(doc, { schemaVersion: SCHEMA_VERSION + 2 });
    const entries = new Map<string, Uint8Array>(readZip(good));
    entries.set("ydoc.bin", Y.encodeStateAsUpdate(doc));
    const crafted = writeZip(
      [...entries].map(([name, data]) => ({ name, data, compress: name === "ydoc.bin" })),
    );
    const read = await readGalatsaFile(crafted);
    expect(read.mergeIdentityKept).toBe(true);
    expect(versionsOf(read.doc).schemaVersion).toBe(SCHEMA_VERSION + 2);
    expect(read.snapshot.schemaVersion).toBe(SCHEMA_VERSION + 2);
    // And saving keeps it.
    const again = await readGalatsaFile(writeGalatsaFile(read.doc, none).bytes);
    expect(again.formatVersion).toBe(SCHEMA_VERSION + 2);
    expect(again.mergeIdentityKept).toBe(true);
  });
});
