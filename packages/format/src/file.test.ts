// SPDX-License-Identifier: GPL-3.0-or-later

// Round trips, unknown extensions, migrations and damaged files. Section 9 of
// docs/adr/0001-document-model-and-file-format.md.

import {
  FRAME_TYPE,
  MAX_DEPTH,
  nestingDepth,
  validateSnapshot,
  type AssetId,
  type DocumentSnapshot,
  type ElementData,
} from "@galatsa/core";
import { SAMPLE, buildSampleDocument } from "@galatsa/core/testing";
import {
  addAsset,
  addElement,
  addStop,
  dataMap,
  deleteElements,
  edit,
  forkDoc,
  lineageOf,
  renameElement,
  setSetting,
  setStopTransition,
  stopNotes,
  syncDocs,
  tidyUp,
  toSnapshot,
} from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FileFormatError, type FileErrorCode } from "./errors.ts";
import { assetIdOf } from "./hash.ts";
import { canonicalJson, fromUtf8, utf8 } from "./json.ts";
import { FORMAT_VERSION, MIGRATIONS, type MigrationRegistry } from "./migrations.ts";
import {
  readGalatsaFile,
  writeGalatsaFile as writeFile,
  type AssetSource,
  type WriteOptions,
} from "./file.ts";
import { MIMETYPE } from "./layout.ts";
import { readGalatsaSnapshot } from "./read.ts";
import { readZip, writeZip } from "./zip.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const VIDEO = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

/** An element of an extension this program does not have, with every kind of data. */
const UNKNOWN_DATA: ElementData = {
  settings: {
    $y: "json",
    value: { mode: "spiral", turns: 3.5, $y: "plain object with a $y key" },
  },
  caption: {
    $y: "text",
    delta: [{ insert: "Caption", attributes: { bold: true } }, { insert: "\n" }],
  },
  items: {
    $y: "array",
    items: [
      { a: 1 },
      { $y: "map", entries: { label: { $y: "text", delta: [{ insert: "x" }] } } },
    ],
  },
  tree: {
    $y: "xmlFragment",
    children: [{ $y: "xmlElement", name: "node", attributes: { k: 1 }, children: [] }],
  },
};

async function sampleWithAssets(): Promise<{
  doc: Y.Doc;
  assets: Map<AssetId, Uint8Array>;
}> {
  const doc = buildSampleDocument(new Y.Doc(), 3);
  const png = await assetIdOf(PNG);
  const video = await assetIdOf(VIDEO);
  addAsset(doc, png, { mediaType: "image/png", byteLength: PNG.length });
  addAsset(doc, video, { mediaType: "video/mp4", byteLength: VIDEO.length });
  addElement(doc, {
    id: "pic",
    type: "galatsa.image/image",
    x: 0,
    y: 0,
    size: { w: 1, h: 1 },
    data: { asset: png },
  });
  addElement(doc, {
    id: "clip",
    type: "galatsa.media/media",
    x: 0,
    y: 0,
    size: { w: 1, h: 1 },
    data: { asset: video },
  });
  addElement(doc, {
    id: "alien",
    type: "example.spiral/spiral",
    typeVersion: 4,
    x: 5,
    y: 6,
    size: { w: 7, h: 8 },
    rot: 0.25,
    data: UNKNOWN_DATA,
  });
  return {
    doc,
    assets: new Map([
      [png, PNG],
      [video, VIDEO],
    ]),
  };
}

async function failure(promise: Promise<unknown>): Promise<FileErrorCode | string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof FileFormatError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
}

/** Writes a file and returns its bytes. */
function writeGalatsaFile(
  source: Y.Doc | DocumentSnapshot,
  assets: AssetSource,
  options?: WriteOptions,
): Uint8Array {
  return writeFile(source, assets, options).bytes;
}

/** Rebuilds a file's archive with some entries replaced or removed. */
function rewrite(
  bytes: Uint8Array,
  change: (entries: Map<string, Uint8Array>) => void,
): Uint8Array {
  const entries = readZip(bytes);
  change(entries);
  return writeZip(
    [...entries].map(([name, data]) => ({ name, data, compress: name !== "mimetype" })),
  );
}

describe("file round trip", () => {
  it("writes a file and reads back an equal document, with assets and merge identity", async () => {
    const { doc, assets } = await sampleWithAssets();
    const thumbnail = new Uint8Array([9, 9, 9]);
    const bytes = writeGalatsaFile(doc, (id) => assets.get(id), {
      generator: "test",
      thumbnail,
    });
    const read = await readGalatsaFile(bytes);
    expect(read.snapshot).toEqual(toSnapshot(doc));
    expect(read.mergeIdentityKept).toBe(true);
    expect(read.formatVersion).toBe(FORMAT_VERSION);
    expect(read.thumbnail).toEqual(thumbnail);
    expect([...read.assets.keys()].sort()).toEqual([...assets.keys()].sort());
    // The sample's own placeholder asset ids have no bytes: reported, not fatal.
    expect(read.warnings.map((w) => w.code).sort()).toEqual([
      "asset-missing",
      "asset-missing",
    ]);
    // Writing what was read gives the same document.json and the same Yjs state.
    const again = readZip(
      writeGalatsaFile(read.doc, (id) => read.assets.get(id), {
        generator: "test",
        thumbnail,
      }),
    );
    const first = readZip(bytes);
    expect(again.get("document.json")).toEqual(first.get("document.json"));
    expect(again.get("ydoc.bin")).toEqual(first.get("ydoc.bin"));
  });

  it("lays out the archive as specified", async () => {
    const { doc, assets } = await sampleWithAssets();
    const entries = readZip(writeGalatsaFile(doc, (id) => assets.get(id)));
    const names = [...entries.keys()];
    expect(names[0]).toBe("mimetype");
    expect(fromUtf8(entries.get("mimetype")!)).toBe(MIMETYPE);
    expect(names).toContain("manifest.json");
    expect(names).toContain("document.json");
    expect(names).toContain("ydoc.bin");
    expect(names.filter((n) => n.startsWith("assets/"))).toHaveLength(2);
    expect(JSON.parse(fromUtf8(entries.get("manifest.json")!))).toEqual({
      format: "galatsa",
      formatVersion: 1,
      minReaderVersion: 1,
      generator: "Galatsa",
      ydoc: { encoding: "yjs-update-v1", lineage: lineageOf(doc) },
    });
  });

  it("keeps an element from a missing extension unchanged through a round trip", async () => {
    const { doc, assets } = await sampleWithAssets();
    const original = toSnapshot(doc).elements.alien!;
    // Through ydoc.bin, and through document.json alone.
    for (const includeYdoc of [true, false]) {
      const bytes = writeGalatsaFile(doc, (id) => assets.get(id), { includeYdoc });
      const read = await readGalatsaFile(bytes);
      expect(read.mergeIdentityKept).toBe(includeYdoc);
      expect(read.snapshot.elements.alien).toEqual(original);
      const again = readZip(writeGalatsaFile(read.doc, (id) => read.assets.get(id)));
      const json = JSON.parse(fromUtf8(again.get("document.json")!)) as DocumentSnapshot;
      expect(canonicalJson(json.elements.alien)).toBe(canonicalJson(original));
    }
  });

  it("reads the JSON form without Yjs, as the player does", async () => {
    const { doc, assets } = await sampleWithAssets();
    const read = await readGalatsaSnapshot(writeGalatsaFile(doc, (id) => assets.get(id)));
    expect(read.snapshot).toEqual(toSnapshot(doc));
    expect(read.ydoc).not.toBe(null);
    expect(read.migrated).toBe(false);
  });

  it("keeps merge identity: a reopened file merges with other copies without duplicates", async () => {
    const { doc, assets } = await sampleWithAssets();
    const peer = forkDoc(doc, 77);
    const read = await readGalatsaFile(writeGalatsaFile(doc, (id) => assets.get(id)));
    renameElement(read.doc, SAMPLE.frame, "Renamed offline");
    edit(peer, () => stopNotes(peer, SAMPLE.stop1).insert(0, "Peer note. "));
    syncDocs(read.doc, peer);
    const merged = toSnapshot(read.doc);
    expect(toSnapshot(peer)).toEqual(merged);
    expect(merged.elements[SAMPLE.frame]!.name).toBe("Renamed offline");
    expect(merged.stops[SAMPLE.stop1]!.notes.delta[0]!.insert).toBe(
      "Peer note. Welcome everyone\n",
    );
  });

  it("keeps the assets of deleted elements until they are purged", async () => {
    const { doc, assets } = await sampleWithAssets();
    deleteElements(doc, ["clip"]);
    const read = await readGalatsaFile(writeGalatsaFile(doc, (id) => assets.get(id)));
    expect(read.assets.has(await assetIdOf(PNG))).toBe(true);
    expect(read.assets.has(await assetIdOf(VIDEO))).toBe(true);
    const shared = await readGalatsaFile(
      writeGalatsaFile(doc, (id) => assets.get(id), { forSharing: true }),
    );
    expect(shared.assets.has(await assetIdOf(VIDEO))).toBe(false);
    expect(shared.snapshot.assets[await assetIdOf(VIDEO)]).toBeUndefined();
    expect(shared.snapshot.elements.clip).toBeUndefined();
  });

  it("writes a snapshot without a Y.Doc (no ydoc.bin)", async () => {
    const { doc, assets } = await sampleWithAssets();
    const snapshot = toSnapshot(doc);
    const read = await readGalatsaFile(
      writeGalatsaFile(snapshot, (id) => assets.get(id)),
    );
    expect(read.snapshot).toEqual(snapshot);
    expect(read.mergeIdentityKept).toBe(false);
    expect(read.warnings.map((w) => w.code)).not.toContain("ydoc-discarded");
  });
});

describe("format versions", () => {
  /**
   * A hypothetical next version: version 2 renames the frame data key "fill" to
   * "background". Real migrations are registered in MIGRATIONS the same way.
   */
  const NEXT: MigrationRegistry = {
    current: 2,
    migrations: [
      {
        from: 1,
        description: "Rename frame data key fill to background",
        migrate({ manifest, document }) {
          const doc = document as DocumentSnapshot;
          for (const element of Object.values(doc.elements)) {
            if (element.type === FRAME_TYPE && "fill" in element.data) {
              element.data.background = element.data.fill!;
              delete element.data.fill;
            }
          }
          return { manifest, document: doc };
        },
      },
    ],
  };

  it("upgrades an older file with a migration and drops its Yjs state", async () => {
    const { doc, assets } = await sampleWithAssets();
    const v1 = writeGalatsaFile(doc, (id) => assets.get(id));
    const read = await readGalatsaFile(v1, { migrations: NEXT });
    expect(read.formatVersion).toBe(1);
    expect(read.snapshot.schemaVersion).toBe(2);
    expect(read.snapshot.elements[SAMPLE.frame]!.data).toEqual({
      background: "#ffffff",
      clip: false,
      stroke: null,
    });
    // Elements the migration does not own pass through untouched.
    expect(read.snapshot.elements.alien).toEqual(toSnapshot(doc).elements.alien);
    expect(read.mergeIdentityKept).toBe(false);
    expect(read.warnings.map((w) => w.code)).toContain("migrated");
  });

  it("reads current files with the real registry without migrating", async () => {
    const { doc, assets } = await sampleWithAssets();
    const read = await readGalatsaFile(
      writeGalatsaFile(doc, (id) => assets.get(id)),
      { migrations: MIGRATIONS },
    );
    expect(read.warnings.map((w) => w.code)).not.toContain("migrated");
  });

  it("refuses files from a newer version", async () => {
    const { doc, assets } = await sampleWithAssets();
    const bytes = rewrite(
      writeGalatsaFile(doc, (id) => assets.get(id)),
      (entries) => {
        entries.set(
          "manifest.json",
          utf8(
            JSON.stringify({
              format: "galatsa",
              formatVersion: 99,
              minReaderVersion: 99,
              generator: "future",
            }),
          ),
        );
      },
    );
    expect(await failure(readGalatsaFile(bytes))).toBe("newer-version");
  });

  it("a compatible newer file (higher format, low minimum reader) opens and keeps its additions", async () => {
    const { doc, assets } = await sampleWithAssets();
    const bytes = rewrite(
      writeGalatsaFile(doc, (id) => assets.get(id)),
      (entries) => {
        const m = JSON.parse(fromUtf8(entries.get("manifest.json")!)) as Record<
          string,
          unknown
        >;
        entries.set("manifest.json", utf8(JSON.stringify({ ...m, formatVersion: 3 })));
        const d = JSON.parse(fromUtf8(entries.get("document.json")!)) as DocumentSnapshot;
        d.schemaVersion = 3;
        d.elements[SAMPLE.shape]!.ext["future.alt"] = "Alt text from version 3";
        entries.set("document.json", utf8(JSON.stringify(d)));
      },
    );
    const read = await readGalatsaFile(bytes);
    expect(read.snapshot.schemaVersion).toBe(3);
    expect(read.snapshot.elements[SAMPLE.shape]!.ext["future.alt"]).toBe(
      "Alt text from version 3",
    );
    const again = await readGalatsaFile(
      writeGalatsaFile(read.doc, (id) => read.assets.get(id)),
    );
    expect(again.snapshot.elements[SAMPLE.shape]!.ext["future.alt"]).toBe(
      "Alt text from version 3",
    );
    expect(again.formatVersion).toBe(3);
  });

  it("refuses a newer file whose minimum reader version is too high", async () => {
    const { doc, assets } = await sampleWithAssets();
    const bytes = rewrite(
      writeGalatsaFile(doc, (id) => assets.get(id)),
      (entries) => {
        const m = JSON.parse(fromUtf8(entries.get("manifest.json")!)) as Record<
          string,
          unknown
        >;
        entries.set(
          "manifest.json",
          utf8(JSON.stringify({ ...m, formatVersion: 3, minReaderVersion: 2 })),
        );
      },
    );
    expect(await failure(readGalatsaFile(bytes))).toBe("newer-version");
  });
});

describe("damaged and foreign files", () => {
  it("reports each kind of problem with its own code", async () => {
    const { doc, assets } = await sampleWithAssets();
    const good = writeGalatsaFile(doc, (id) => assets.get(id));
    expect(await failure(readGalatsaFile(good.subarray(0, good.length - 100)))).toBe(
      "damaged",
    );
    expect(await failure(readGalatsaFile(utf8("hello")))).toBe("not-zip");
    const foreign = writeZip([
      { name: "word/document.xml", data: utf8("<w/>"), compress: true },
    ]);
    expect(await failure(readGalatsaFile(foreign))).toBe("not-galatsa");
    expect(
      await failure(
        readGalatsaFile(rewrite(good, (e) => e.set("mimetype", utf8("application/zip")))),
      ),
    ).toBe("not-galatsa");
    // Without a usable document.json and without ydoc.bin there is no document.
    const plain = writeGalatsaFile(doc, (id) => assets.get(id), { includeYdoc: false });
    for (const change of [
      (e: Map<string, Uint8Array>) => e.delete("document.json"),
      (e: Map<string, Uint8Array>) => e.set("document.json", utf8("{not json")),
      (e: Map<string, Uint8Array>) => e.set("document.json", utf8('{"schemaVersion":1}')),
      (e: Map<string, Uint8Array>) => e.set("document.json", utf8("[]")),
    ]) {
      expect(await failure(readGalatsaFile(rewrite(plain, change)))).toBe("damaged");
      expect(await failure(readGalatsaSnapshot(rewrite(plain, change)))).toBe("damaged");
      // With ydoc.bin, the document is recovered from it, merge identity included.
      const recovered = await readGalatsaFile(rewrite(good, change));
      expect(recovered.snapshot).toEqual(toSnapshot(doc));
      expect(recovered.mergeIdentityKept).toBe(true);
      expect(recovered.warnings.map((w) => w.code)).toContain("document-recovered");
      // The reader without Yjs cannot do that.
      expect(await failure(readGalatsaSnapshot(rewrite(good, change)))).toBe("damaged");
    }
    expect(
      await failure(
        readGalatsaFile(good, { limits: { maxInflatedSize: 100, maxEntries: 100 } }),
      ),
    ).toBe("too-large");
  });

  it("ignores asset bytes that do not match their id", async () => {
    const { doc, assets } = await sampleWithAssets();
    const png = await assetIdOf(PNG);
    const bytes = rewrite(
      writeGalatsaFile(doc, (id) => assets.get(id)),
      (e) => e.set(`assets/${png}`, new Uint8Array([1, 2, 3])),
    );
    const read = await readGalatsaFile(bytes);
    expect(read.assets.has(png)).toBe(false);
    expect(read.warnings.map((w) => w.code)).toContain("asset-damaged");
  });

  it("prefers document.json when ydoc.bin disagrees with it or is unreadable", async () => {
    const { doc, assets } = await sampleWithAssets();
    const good = writeGalatsaFile(doc, (id) => assets.get(id));
    const edited = rewrite(good, (e) => {
      const json = JSON.parse(fromUtf8(e.get("document.json")!)) as DocumentSnapshot;
      json.title = "Edited by another tool";
      e.set("document.json", utf8(JSON.stringify(json)));
    });
    const read = await readGalatsaFile(edited);
    expect(read.snapshot.title).toBe("Edited by another tool");
    expect(read.mergeIdentityKept).toBe(false);
    expect(read.warnings.map((w) => w.code)).toContain("ydoc-discarded");

    const garbage = await readGalatsaFile(
      rewrite(good, (e) => e.set("ydoc.bin", new Uint8Array([255, 255, 255]))),
    );
    expect(garbage.snapshot).toEqual(toSnapshot(doc));
    expect(garbage.warnings.map((w) => w.code)).toContain("ydoc-discarded");
  });
});

describe("review findings (format)", () => {
  it("a deleted element's content is not in an export for sharing", async () => {
    const doc = buildSampleDocument(new Y.Doc(), 3);
    edit(doc, () =>
      (dataMap(doc, SAMPLE.text).get("text") as Y.Text).insert(0, "CONFIDENTIAL "),
    );
    deleteElements(doc, [SAMPLE.text]);
    const bytes = writeGalatsaFile(doc, () => undefined, { forSharing: true });
    const entries = readZip(bytes);
    expect(entries.has("ydoc.bin")).toBe(false);
    expect(fromUtf8(entries.get("document.json")!)).not.toContain("CONFIDENTIAL");
    const read = await readGalatsaSnapshot(bytes);
    expect(read.snapshot.elements[SAMPLE.text]).toBeUndefined();
  });

  it("writes assets referred to from settings, stop transitions and text embeds", async () => {
    const doc = buildSampleDocument(new Y.Doc(), 3);
    const bg = await assetIdOf(new Uint8Array([1]));
    const sound = await assetIdOf(new Uint8Array([2]));
    const inline = await assetIdOf(new Uint8Array([3]));
    setSetting(doc, "core.background", { image: bg });
    const stop = addStop(doc, {
      view: { kind: "rect", space: null, x: 0, y: 0, w: 1, h: 1 },
    });
    setStopTransition(doc, stop, { kind: "fade", sound });
    edit(doc, () =>
      (dataMap(doc, SAMPLE.text).get("text") as Y.Text).insertEmbed(0, {
        image: inline,
      }),
    );
    const bytesOf = new Map([
      [bg, new Uint8Array([1])],
      [sound, new Uint8Array([2])],
      [inline, new Uint8Array([3])],
    ]);
    const names = [...readZip(writeGalatsaFile(doc, (id) => bytesOf.get(id))).keys()];
    for (const id of [bg, sound, inline]) expect(names).toContain(`assets/${id}`);
  });

  it("reports content of ydoc.bin that the format has no place for, and never shares it", async () => {
    const doc = buildSampleDocument(new Y.Doc(), 3);
    doc.getMap("secretRoot").set("payload", "not in document.json");
    edit(doc, () => {
      doc.getMap<Y.Map<unknown>>("elements").get(SAMPLE.text)!.set("smuggled", 1);
      doc.getMap("meta").set("extraMeta", 42);
    });
    const read = await readGalatsaFile(writeGalatsaFile(doc, () => undefined));
    // One odd key from a peer must not cost everyone their merge identity, so the
    // state is kept, and the user is told.
    expect(read.mergeIdentityKept).toBe(true);
    const warning = read.warnings.find((w) => w.code === "content-quarantined");
    expect(warning?.details).toEqual([
      `elements.${SAMPLE.text}.smuggled: unknown field, left out`,
      "root secretRoot: unknown root type",
      "meta.extraMeta: unknown field",
    ]);
    expect(JSON.stringify(read.snapshot)).not.toContain("smuggled");
    // An export for sharing carries only the JSON form.
    const shared = writeGalatsaFile(doc, () => undefined, { forSharing: true });
    expect([...readZip(shared).keys()]).not.toContain("ydoc.bin");
    expect((await readGalatsaFile(shared)).warnings.map((w) => w.code)).not.toContain(
      "content-quarantined",
    );
    // Tidy up removes what can be removed (root types cannot).
    tidyUp(read.doc);
    const tidy = await readGalatsaFile(writeGalatsaFile(read.doc, () => undefined));
    expect(tidy.warnings.find((w) => w.code === "content-quarantined")?.details).toEqual([
      "root secretRoot: unknown root type",
    ]);
  });

  it("uses ydoc.bin only as the manifest describes it", async () => {
    const doc = buildSampleDocument(new Y.Doc(), 3);
    const good = writeGalatsaFile(doc, () => undefined);
    const withManifest = (change: (m: Record<string, unknown>) => void) =>
      rewrite(good, (entries) => {
        const m = JSON.parse(fromUtf8(entries.get("manifest.json")!)) as Record<
          string,
          unknown
        >;
        change(m);
        entries.set("manifest.json", utf8(JSON.stringify(m)));
      });
    expect((await readGalatsaFile(good)).mergeIdentityKept).toBe(true);
    for (const change of [
      (m: Record<string, unknown>) => delete m.ydoc,
      (m: Record<string, unknown>) =>
        (m.ydoc = { encoding: "yjs-update-v2", lineage: lineageOf(doc) }),
      (m: Record<string, unknown>) =>
        (m.ydoc = { encoding: "yjs-update-v1", lineage: "someoneElse" }),
    ]) {
      const read = await readGalatsaFile(withManifest(change));
      expect(read.mergeIdentityKept).toBe(false);
      expect(read.warnings.map((w) => w.code)).toContain("ydoc-discarded");
    }
    const big = await readGalatsaFile(good, { maxYdocSize: 10 });
    expect(big.mergeIdentityKept).toBe(false);
  });

  it("opens a file with absurdly deep nesting: the deep part is cut, the rest is kept", async () => {
    const doc = buildSampleDocument(new Y.Doc(), 3);
    const good = writeGalatsaFile(doc, () => undefined, { includeYdoc: false });
    const depth = 200_000;
    const deep =
      '{"$y":"xmlFragment","children":[' +
      '{"$y":"xmlElement","name":"p","attributes":{},"children":['.repeat(depth) +
      "]}".repeat(depth) +
      "]}";
    const bytes = rewrite(good, (entries) => {
      const text = fromUtf8(entries.get("document.json")!).replace(
        '"fontFamily"',
        `"deep":${deep},"fontFamily"`,
      );
      entries.set("document.json", utf8(text));
    });
    const read = await readGalatsaSnapshot(bytes);
    expect(validateSnapshot(read.snapshot)).toEqual([]);
    expect(nestingDepth(read.snapshot, 1_000_000)).toBeLessThanOrEqual(MAX_DEPTH);
    expect(read.warnings.map((w) => w.code)).toContain("content-quarantined");
    expect(Object.keys(read.snapshot.elements)).toEqual(
      Object.keys(toSnapshot(doc).elements),
    );
  });
});
