// SPDX-License-Identifier: GPL-3.0-or-later

// Regression tests for the defects found in the second review, and for the
// decisions about the format made after it: a saved file can always be opened,
// one bad record or value never makes a file unreadable, and the limits hold.
// Sections 9.1 to 9.7 of docs/adr/0001-document-model-and-file-format.md.

import {
  InvalidDocumentError,
  SCHEMA_VERSION,
  validateSnapshot,
  type AssetId,
  type DocumentSnapshot,
} from "@galatsa/core";
import { buildSampleDocument, SAMPLE } from "@galatsa/core/testing";
import {
  addAsset,
  addElement,
  dataMap,
  forkDoc,
  initDocument,
  insertRouteEntry,
  renameElement,
  resizeElement,
  setExt,
  setStopView,
  setVisibility,
  syncDocs,
  toSnapshot,
} from "@galatsa/core/ydoc";
import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FileFormatError } from "./errors.ts";
import { readGalatsaFile, writeGalatsaFile } from "./file.ts";
import { assetIdOf } from "./hash.ts";
import { fromUtf8, utf8 } from "./json.ts";
import { readGalatsaSnapshot } from "./read.ts";
import { crc32, openZip, readZip, writeZip } from "./zip.ts";

function doc1(): Y.Doc {
  const d = new Y.Doc();
  initDocument(d, { id: "doc" });
  addElement(d, {
    id: "X",
    type: "galatsa.shapes/shape",
    x: 0,
    y: 0,
    size: { w: 10, h: 10 },
  });
  addElement(d, {
    id: "Z",
    type: "galatsa.shapes/shape",
    x: 5,
    y: 5,
    size: { w: 10, h: 10 },
  });
  return d;
}
const X = (d: Y.Doc) => d.getMap("elements").get("X") as Y.Map<unknown>;
const none = () => undefined;

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === "function" ? promise() : promise);
    return "no error";
  } catch (error) {
    return error instanceof FileFormatError ? error.code : `other: ${String(error)}`;
  }
}

function rewrite(
  bytes: Uint8Array,
  change: (entries: Map<string, Uint8Array>) => void,
): Uint8Array {
  const entries = new Map([...readZip(bytes)].map(([k, v]) => [k, v.slice()]));
  change(entries);
  return writeZip(
    [...entries].map(([name, data]) => ({ name, data, compress: name !== "mimetype" })),
  );
}

function editDocument(
  bytes: Uint8Array,
  change: (document: Record<string, never> & DocumentSnapshot) => void,
): Uint8Array {
  return rewrite(bytes, (entries) => {
    const document = JSON.parse(fromUtf8(entries.get("document.json")!)) as Record<
      string,
      never
    > &
      DocumentSnapshot;
    change(document);
    entries.set("document.json", utf8(JSON.stringify(document)));
  });
}

describe("review 2: a saved file can always be opened", () => {
  const cases: Array<[string, (d: Y.Doc) => void]> = [
    ["typeVersion 0", (d) => X(d).set("typeVersion", 0)],
    ["negative size", (d) => X(d).set("size", { w: -5, h: 10 })],
    ["dissolved on a shape", (d) => X(d).set("dissolved", true)],
    ["deleted as a plain value", (d) => X(d).set("deleted", {})],
    ["a reference that is not an id", (d) => X(d).set("refs", ["has space"])],
    [
      "a position space that is not an id",
      (d) => X(d).set("pos", { x: 0, y: 0, space: "a b" }),
    ],
    [
      "an array embedded in text",
      (d) => {
        const t = new Y.Text();
        dataMap(d, "X").set("t", t);
        t.applyDelta([{ insert: "a" }, { insert: [1, 2] as unknown as object }]);
      },
    ],
    [
      "an XML element with an empty name",
      (d) => {
        const f = new Y.XmlFragment();
        dataMap(d, "X").set("x", f);
        f.insert(0, [new Y.XmlElement("")]);
      },
    ],
    [
      "a record under a key that is not an id",
      (d) => {
        const m = new Y.Map<unknown>();
        d.getMap("elements").set("bad id!", m);
        m.set("type", "a/b");
      },
    ],
    [
      "shared maps nested 150 deep",
      (d) => {
        let cur = dataMap(d, "X");
        for (let i = 0; i < 150; i++) {
          const n = new Y.Map<unknown>();
          cur.set("k", n);
          cur = n;
        }
      },
    ],
    [
      "shared maps nested 6000 deep",
      (d) => {
        let cur = dataMap(d, "X");
        for (let i = 0; i < 6000; i++) {
          const n = new Y.Map<unknown>();
          cur.set("k", n);
          cur = n;
        }
      },
    ],
    [
      "an embed with an undefined field",
      (d) => {
        const t = new Y.Text();
        dataMap(d, "X").set("t", t);
        t.insert(0, "ab");
        t.insertEmbed(1, { src: "img", alt: undefined } as unknown as object);
      },
    ],
    ["a data key named __proto__", (d) => dataMap(d, "X").set("__proto__", { a: 1 })],
    [
      "binary data and undefined",
      (d) => dataMap(d, "X").set("b", [new Uint8Array([1]), undefined]),
    ],
    ["a stop that is not a map", (d) => d.getMap("stops").set("S", 5)],
    [
      "an asset description of the wrong shape",
      (d) => d.getMap("assets").set(`sha256-${"a".repeat(64)}`, { mediaType: 1 }),
    ],
  ];
  for (const [name, mutate] of cases) {
    it(`after a peer wrote ${name}`, async () => {
      const d = doc1();
      d.transact(() => mutate(d), "remote-peer");
      const expected = toSnapshot(d);
      expect(validateSnapshot(expected)).toEqual([]);
      for (const includeYdoc of [true, false]) {
        const written = writeGalatsaFile(d, none, { includeYdoc });
        expect(written.warnings).toEqual([]);
        const back = await readGalatsaFile(written.bytes);
        expect(back.snapshot).toEqual(expected);
        expect(back.mergeIdentityKept).toBe(includeYdoc);
        // The player's reader, without Yjs, reads the same document.
        expect((await readGalatsaSnapshot(written.bytes)).snapshot).toEqual(expected);
        // And the reopened document saves to the same content again.
        const again = await readGalatsaFile(writeGalatsaFile(back.doc, none).bytes);
        expect(again.snapshot).toEqual(expected);
      }
    });
  }

  it("a normal resize cannot make a file unreadable", async () => {
    const d = doc1();
    expect(() => resizeElement(d, "X", -5, 10)).toThrow(InvalidDocumentError);
    const back = await readGalatsaFile(writeGalatsaFile(d, none).bytes);
    expect(back.snapshot).toEqual(toSnapshot(d));
    expect(back.mergeIdentityKept).toBe(true);
  });

  it("a key named __proto__ in a data map survives a file without ydoc.bin", async () => {
    const d = doc1();
    d.transact(() => dataMap(d, "X").set("__proto__", { a: 1 }));
    const bytes = writeGalatsaFile(d, none, { forSharing: true }).bytes;
    const back = await readGalatsaFile(bytes);
    expect(Object.hasOwn(back.snapshot.elements.X!.data, "__proto__")).toBe(true);
    expect(back.snapshot.elements.X!.data.__proto__).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(back.snapshot.elements.X!.data)).toBe(Object.prototype);
  });

  it("if the Yjs state cannot be encoded, the file is written without it and says so", async () => {
    const d = doc1();
    d.transact(() => {
      const t = new Y.Text();
      dataMap(d, "X").set("t", t);
      // Yjs cannot encode a big integer inside an embed.
      t.insertEmbed(0, { n: 10n } as unknown as object);
    });
    const written = writeGalatsaFile(d, none);
    expect(written.warnings.map((w) => w.code)).toEqual(["ydoc-not-written"]);
    const back = await readGalatsaFile(written.bytes);
    expect(back.snapshot).toEqual(toSnapshot(d));
    expect(back.mergeIdentityKept).toBe(false);
  });

  it("a snapshot that is not valid is refused by the writer, not written", () => {
    const snapshot = toSnapshot(doc1());
    (snapshot.elements.X as unknown as { size: unknown }).size = { w: -1, h: 1 };
    expect(() => writeGalatsaFile(snapshot, none)).toThrow(InvalidDocumentError);
  });
});

describe("review 2: one bad record or value does not make a file unreadable", () => {
  it("bad records are left out, bad values read as defaults, and the user is told", async () => {
    const d = doc1();
    renameElement(d, "Z", "intact");
    const good = writeGalatsaFile(d, none, { includeYdoc: false }).bytes;
    const bytes = editDocument(good, (document) => {
      const elements = document.elements as unknown as Record<string, unknown>;
      elements.X = { type: "not a type" };
      elements["bad id"] = document.elements.Z;
      elements.half = { ...document.elements.Z, size: "big", pos: null, surprise: 1 };
      (document.stops as unknown as Record<string, unknown>).S = [];
    });
    const read = await readGalatsaFile(bytes);
    expect(Object.keys(read.snapshot.elements)).toEqual(["Z", "half"]);
    expect(read.snapshot.elements.Z).toEqual(toSnapshot(d).elements.Z);
    expect(read.snapshot.elements.half).toMatchObject({
      name: "intact",
      size: { w: 0, h: 0 },
      pos: { x: 0, y: 0, space: null },
    });
    const warning = read.warnings.find((w) => w.code === "content-quarantined");
    expect(warning?.details).toEqual([
      "elements.X: no valid element type, left out",
      "elements.bad id: not a valid id, left out",
      "elements.half.pos: must be an object, read as the origin",
      "elements.half.size: must be an object, read as empty",
      "elements.half.surprise: unknown field, left out",
      "stops.S: not an object, left out",
    ]);
    expect((await readGalatsaSnapshot(bytes)).snapshot).toEqual(read.snapshot);
  });

  it("a value of a kind this version does not know is kept and written back unchanged", async () => {
    const d = doc1();
    const good = writeGalatsaFile(d, none, { includeYdoc: false }).bytes;
    const future = { $y: "hologram", frames: [1, 2, { $y: "text", delta: 5 }] };
    const bytes = editDocument(good, (document) => {
      (document.elements.X!.ext as Record<string, unknown>)["future.hologram"] = future;
      (document.elements.X!.data as Record<string, unknown>).newer = future;
    });
    const read = await readGalatsaFile(bytes);
    const kept = {
      $y: "unsupported",
      note: 'unknown kind of value "hologram"',
      raw: future,
    };
    expect(read.snapshot.elements.X!.ext["future.hologram"]).toEqual(kept);
    expect(read.snapshot.elements.X!.data.newer).toEqual(kept);
    // It lives in the Y.Doc, syncs to other replicas and survives a save.
    const peer = forkDoc(read.doc, 5);
    renameElement(peer, "X", "renamed by an older version");
    syncDocs(read.doc, peer);
    const saved = writeGalatsaFile(read.doc, none).bytes;
    const document = JSON.parse(
      fromUtf8(readZip(saved).get("document.json")!),
    ) as DocumentSnapshot;
    expect(document.elements.X!.ext["future.hologram"]).toEqual(kept);
    expect((await readGalatsaFile(saved)).warnings).toEqual([]);
  });

  it("open slots on assets, route entries, stop views and visibility changes round-trip", async () => {
    const d = buildSampleDocument(new Y.Doc(), 2);
    const asset = `sha256-${"c".repeat(64)}` as AssetId;
    addAsset(d, asset, {
      mediaType: "image/png",
      byteLength: 1,
      ext: { "future.license": "CC0" },
    });
    setExt(d, SAMPLE.shape, "future.uses", asset);
    insertRouteEntry(d, SAMPLE.route1, SAMPLE.stop1, {
      id: "visit",
      ext: { "future.pause": 3 },
    });
    setStopView(d, SAMPLE.stop1, {
      kind: "frame",
      frame: SAMPLE.frame,
      padding: 0,
      ext: { "future.aspect": "16:9" },
    });
    setVisibility(d, SAMPLE.stop1, SAMPLE.shape, "show", { ext: { "future.fade": 200 } });
    const expected = toSnapshot(d);
    expect(expected.assets[asset]!.ext).toEqual({ "future.license": "CC0" });
    expect(expected.routes[SAMPLE.route1]!.entries.visit!.ext).toEqual({
      "future.pause": 3,
    });
    expect(expected.stops[SAMPLE.stop1]!.view.ext).toEqual({ "future.aspect": "16:9" });
    expect(expected.stops[SAMPLE.stop1]!.visibility[SAMPLE.shape]).toEqual({
      action: "show",
      ext: { "future.fade": 200 },
    });
    for (const includeYdoc of [true, false]) {
      const back = await readGalatsaFile(
        writeGalatsaFile(d, none, { includeYdoc }).bytes,
      );
      expect(back.snapshot).toEqual(expected);
    }
  });

  it("a damaged asset or thumbnail entry does not stop the file from opening", async () => {
    const d = buildSampleDocument(new Y.Doc(), 2);
    const png = new Uint8Array(3000).fill(7);
    const id = await assetIdOf(png);
    addAsset(d, id, { mediaType: "text/plain", byteLength: png.length });
    setExt(d, SAMPLE.shape, "x.asset", id);
    const good = writeGalatsaFile(d, (a) => (a === id ? png : undefined)).bytes;
    // Flip one byte inside the compressed asset data.
    const bad = good.slice();
    const marker = utf8(`assets/${id}`);
    let at = -1;
    for (let i = 0; i < bad.length - marker.length && at < 0; i++) {
      if (marker.every((b, k) => bad[i + k] === b)) at = i + marker.length;
    }
    bad[at + 2] = bad[at + 2]! ^ 0xff;
    const read = await readGalatsaFile(bad);
    expect(read.snapshot).toEqual(toSnapshot(d));
    expect(read.mergeIdentityKept).toBe(true);
    expect(read.assets.has(id)).toBe(false);
    expect(read.warnings.map((w) => w.code)).toContain("asset-damaged");
  });

  it("a damaged or incomplete ydoc.bin costs merge identity, not the document", async () => {
    const d = doc1();
    const good = writeGalatsaFile(d, none).bytes;
    // An update that depends on changes that are not there.
    const other = forkDoc(d, 9);
    renameElement(other, "X", "one");
    const first = Y.encodeStateVector(other);
    renameElement(other, "X", "two");
    const incomplete = Y.encodeStateAsUpdate(other, first);
    const base = Y.mergeUpdates([Y.encodeStateAsUpdate(d), incomplete]);
    for (const ydoc of [base, new Uint8Array([1, 2, 3])]) {
      const read = await readGalatsaFile(rewrite(good, (e) => e.set("ydoc.bin", ydoc)));
      expect(read.snapshot).toEqual(toSnapshot(d));
      expect(read.mergeIdentityKept).toBe(false);
      expect(read.warnings.map((w) => w.code)).toEqual(["ydoc-discarded"]);
    }
  });
});

describe("review 2: versions", () => {
  it("unknown archive entries and manifest fields are ignored and not written back", async () => {
    const d = doc1();
    const bytes = rewrite(writeGalatsaFile(d, none).bytes, (entries) => {
      entries.set("future/index.bin", new Uint8Array([1, 2, 3]));
      const manifest = JSON.parse(fromUtf8(entries.get("manifest.json")!)) as Record<
        string,
        unknown
      >;
      manifest.futureField = { a: 1 };
      entries.set("manifest.json", utf8(JSON.stringify(manifest)));
    });
    const read = await readGalatsaFile(bytes);
    expect(read.warnings).toEqual([]);
    expect(read.mergeIdentityKept).toBe(true);
    const saved = readZip(writeGalatsaFile(read.doc, none).bytes);
    expect([...saved.keys()]).toEqual([
      "mimetype",
      "manifest.json",
      "document.json",
      "ydoc.bin",
    ]);
    expect(fromUtf8(saved.get("manifest.json")!)).not.toContain("futureField");
  });

  it("a document that needs a newer version is not saved by this one", () => {
    const d = doc1();
    d.transact(
      () => d.getMap("meta").set("minReaderVersion", SCHEMA_VERSION + 1),
      "peer",
    );
    d.transact(() => d.getMap("meta").set("schemaVersion", SCHEMA_VERSION + 1), "peer");
    let code = "";
    try {
      writeGalatsaFile(d, none);
    } catch (error) {
      code = (error as FileFormatError).code;
    }
    expect(code).toBe("newer-version");
  });

  it("the document's own minimum reader version counts, even if the manifest says less", async () => {
    const d = doc1();
    const bytes = rewrite(
      writeGalatsaFile(d, none, { includeYdoc: false }).bytes,
      (e) => {
        const document = JSON.parse(
          fromUtf8(e.get("document.json")!),
        ) as DocumentSnapshot;
        document.schemaVersion = 9;
        document.minReaderVersion = 9;
        e.set("document.json", utf8(JSON.stringify(document)));
      },
    );
    expect(await failure(readGalatsaFile(bytes))).toBe("newer-version");
  });
});

describe("review 2: the archive", () => {
  it("a size of 0xFFFFFFFF or a zip64 extra field means the file needs a newer version", () => {
    const original = writeZip([
      { name: "mimetype", data: utf8("x/y"), compress: false },
      { name: "document.json", data: utf8("{}".repeat(100)), compress: true },
    ]);
    const central = (bytes: Uint8Array): number => {
      const v = new DataView(bytes.buffer);
      for (let i = 0; i < bytes.length - 46; i++) {
        if (v.getUint32(i, true) !== 0x02014b50) continue;
        const length = v.getUint16(i + 28, true);
        const name = String.fromCharCode(...bytes.subarray(i + 46, i + 46 + length));
        if (name === "document.json") return i;
      }
      throw new Error("no entry");
    };
    for (const offset of [20, 24, 42]) {
      const patched = original.slice();
      new DataView(patched.buffer).setUint32(central(patched) + offset, 0xffffffff, true);
      let error: FileFormatError | null = null;
      try {
        readZip(patched);
      } catch (e) {
        error = e as FileFormatError;
      }
      expect(error?.code).toBe("newer-version");
      expect(error?.message).toMatch(/newer version/);
    }
  });

  it("an archive hidden in the archive comment is not read: comments are not allowed", () => {
    const real = writeZip([{ name: "a", data: utf8("REAL"), compress: false }]);
    const fake = writeZip([{ name: "b", data: utf8("FAKE"), compress: false }]);
    const out = new Uint8Array(real.length + fake.length);
    out.set(real, 0);
    new DataView(out.buffer).setUint16(real.length - 2, fake.length, true);
    const moved = fake.slice();
    const view = new DataView(moved.buffer);
    const end = moved.length - 22;
    const directory = view.getUint32(end + 16, true);
    view.setUint32(end + 16, directory + real.length, true);
    view.setUint32(
      directory + 42,
      view.getUint32(directory + 42, true) + real.length,
      true,
    );
    out.set(moved, real.length);
    let message = "";
    try {
      readZip(out);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/belong to no entry/);
    // A plain comment is refused too, and so are bytes after the archive.
    const commented = new Uint8Array(real.length + 5);
    commented.set(real, 0);
    new DataView(commented.buffer).setUint16(real.length - 2, 5, true);
    expect(() => readZip(commented)).toThrow(/comment/);
    const trailing = new Uint8Array(real.length + 5);
    trailing.set(real, 0);
    expect(() => readZip(trailing)).toThrow(FileFormatError);
  });

  it("memory is bounded by the file plus what is decompressed", async () => {
    // A stored entry is a view of the file, not a copy.
    const media = new Uint8Array(100_000).fill(3);
    const d = doc1();
    const id = await assetIdOf(media);
    addAsset(d, id, { mediaType: "video/mp4", byteLength: media.length });
    setExt(d, "X", "x.media", id);
    const file = writeGalatsaFile(d, (a) => (a === id ? media : undefined)).bytes;
    const read = await readGalatsaFile(file);
    expect(read.assets.get(id)!.buffer).toBe(file.buffer);
    // The limit counts only what has to be decompressed.
    await expect(
      readGalatsaFile(file, { limits: { maxInflatedSize: 50_000, maxEntries: 10 } }),
    ).resolves.toBeDefined();
    expect(
      await failure(
        readGalatsaFile(file, { limits: { maxInflatedSize: 100, maxEntries: 10 } }),
      ),
    ).toBe("too-large");

    // An entry that declares 400 MiB but holds 5 bytes costs 5 bytes, and only
    // that entry is lost.
    const name = "big.bin";
    const body = deflateSync(utf8("hello"));
    const head = new Uint8Array(30 + name.length);
    const hv = new DataView(head.buffer);
    const declared = 400 * 1024 ** 2;
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(8, 8, true);
    hv.setUint32(14, crc32(utf8("hello")), true);
    hv.setUint32(18, body.length, true);
    hv.setUint32(22, declared, true);
    hv.setUint16(26, name.length, true);
    head.set(utf8(name), 30);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, 8, true);
    dv.setUint32(16, crc32(utf8("hello")), true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, declared, true);
    dv.setUint16(28, name.length, true);
    dir.set(utf8(name), 46);
    const tail = new Uint8Array(22);
    const tv = new DataView(tail.buffer);
    tv.setUint32(0, 0x06054b50, true);
    tv.setUint16(8, 1, true);
    tv.setUint16(10, 1, true);
    tv.setUint32(12, dir.length, true);
    tv.setUint32(16, head.length + body.length, true);
    const archive = new Uint8Array(head.length + body.length + dir.length + 22);
    archive.set(head, 0);
    archive.set(body, head.length);
    archive.set(dir, head.length + body.length);
    archive.set(tail, head.length + body.length + dir.length);
    const before = (
      globalThis as { process?: { memoryUsage(): { arrayBuffers: number } } }
    ).process?.memoryUsage().arrayBuffers;
    const contents = openZip(archive);
    const after = (
      globalThis as { process?: { memoryUsage(): { arrayBuffers: number } } }
    ).process?.memoryUsage().arrayBuffers;
    expect([...contents.damaged]).toEqual([name]);
    if (before !== undefined && after !== undefined) {
      expect(after - before).toBeLessThan(8 * 1024 ** 2);
    }
  });
});
