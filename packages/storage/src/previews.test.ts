// SPDX-License-Identifier: GPL-3.0-or-later

// Reduced versions of image assets in the store (docs/adr/0012): stored beside
// the asset, carried into and out of files, kept in memory when the store
// fails, and gone with the slot.

import type { AssetId } from "@galatsa/core";
import { addAsset, addElement } from "@galatsa/core/ydoc";
import { readGalatsaFile, type AssetPreview } from "@galatsa/format";
import { describe, expect, it } from "vitest";
import { memoryFile } from "./files.ts";
import { keys } from "./layout.ts";
import type { StorageSession } from "./session.ts";
import type { OpenResult } from "./storage.ts";
import { machine, program } from "./test-helpers.ts";

function opened(result: OpenResult): StorageSession {
  if (!result.ok) throw new Error(`not opened: ${result.problem.code}`);
  return result.session;
}

const ORIGINAL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7, 7]);

function preview(width: number, height: number, fill: number): AssetPreview {
  return { width, height, mediaType: "image/webp", bytes: new Uint8Array(32).fill(fill) };
}

async function withImage(session: StorageSession): Promise<AssetId> {
  const id = await session.putAsset(ORIGINAL);
  addAsset(session.doc, id, {
    mediaType: "image/png",
    byteLength: ORIGINAL.length,
    width: 3000,
    height: 2000,
  });
  addElement(session.doc, {
    type: "galatsa.image/image",
    x: 0,
    y: 0,
    size: { w: 300, h: 200 },
    data: { asset: id, crop: null, opacity: 1 },
  });
  return id;
}

describe("previews in the store", () => {
  it("stores previews beside the asset and hands out their sizes and bytes", async () => {
    const m = machine();
    const session = await program(m).storage.create();
    const id = await withImage(session);
    await session.putPreviews(id, [preview(1024, 683, 2), preview(256, 171, 1)]);
    const prefix = `${keys.previews(session.slot)}${id}/`;
    expect([...m.store.data.keys()].filter((k) => k.startsWith(prefix)).sort()).toEqual([
      `${prefix}1024x683.webp`,
      `${prefix}256x171.webp`,
    ]);
    expect(await session.previewFacts(id)).toEqual([
      { width: 256, height: 171, mediaType: "image/webp" },
      { width: 1024, height: 683, mediaType: "image/webp" },
    ]);
    expect(
      await session.getPreview(id, { width: 1024, height: 683, mediaType: "image/webp" }),
    ).toEqual(preview(1024, 683, 2).bytes);
    // Another program opening the stored document finds them in the store.
    await session.close();
    const again = opened(await program(m).storage.open(session.slot));
    expect((await again.previewFacts(id)).map((f) => f.width)).toEqual([256, 1024]);
    expect((await again.getPreviews(id)).map((p) => p.bytes[0])).toEqual([1, 2]);
    await again.close();
  });

  it("saves previews into files, and a file's previews into the store", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const id = await withImage(session);
    await session.putPreviews(id, [preview(256, 171, 1), preview(1024, 683, 2)]);
    const file = memoryFile("talk.galatsa");
    expect((await session.saveToFile(file)).ok).toBe(true);
    const read = await readGalatsaFile(file.bytes!);
    expect(read.previews.get(id)!.map((x) => x.width)).toEqual([256, 1024]);
    await session.close();

    const reopened = opened(await program(m).storage.openFile(file));
    const prefix = `${keys.previews(reopened.slot)}${id}/`;
    expect([...m.store.data.keys()].filter((k) => k.startsWith(prefix)).length).toBe(2);
    expect((await reopened.previewFacts(id)).map((f) => f.width)).toEqual([256, 1024]);
    await reopened.close();

    const exported = await program(m).storage.exportFile(reopened.slot);
    expect((await readGalatsaFile(exported!)).previews.get(id)!.length).toBe(2);
  });

  it("keeps previews in memory when the store cannot take them, and stores them later", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const id = await withImage(session);
    m.store.failWrites(1);
    await session.putPreviews(id, [preview(256, 171, 1)]);
    expect((await session.previewFacts(id)).map((f) => f.width)).toEqual([256]);
    const file = memoryFile("a.galatsa");
    expect((await session.saveToFile(file)).ok).toBe(true);
    expect((await readGalatsaFile(file.bytes!)).previews.get(id)!.length).toBe(1);
    await session.flush();
    const prefix = `${keys.previews(session.slot)}${id}/`;
    expect([...m.store.data.keys()].filter((k) => k.startsWith(prefix))).toEqual([
      `${prefix}256x171.webp`,
    ]);
    await session.close();
  });

  it("removes previews with the slot", async () => {
    const m = machine();
    const p = program(m);
    const session = await p.storage.create();
    const id = await withImage(session);
    await session.putPreviews(id, [preview(256, 171, 1)]);
    await session.close();
    expect(await p.storage.deleteDocument(session.slot)).toBe(true);
    expect(
      [...m.store.data.keys()].filter((k) => k.startsWith(keys.slot(session.slot))),
    ).toEqual([]);
  });

  it("ignores keys under an asset's preview folder that are not previews", async () => {
    const m = machine();
    const session = await program(m).storage.create();
    const id = await withImage(session);
    m.store.data.set(`${keys.previews(session.slot)}${id}/junk.txt`, new Uint8Array([1]));
    m.store.data.set(`${keys.previews(session.slot)}${id}/0x5.png`, new Uint8Array([1]));
    expect(await session.previewFacts(id)).toEqual([]);
    await session.close();
  });
});
