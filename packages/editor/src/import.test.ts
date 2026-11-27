// SPDX-License-Identifier: GPL-3.0-or-later

// Importing files (docs/adr/0012): the importer is chosen by type or by the
// first bytes; several files are pasted as one undo step, centred where they
// were dropped; files on the clipboard are imported; the same file imported
// ten times is one asset; the asset store makes an image's reduced versions
// once.

import type { AssetId, ExtensionElement } from "@galatsa/core";
import { toSnapshot } from "@galatsa/core/ydoc";
import type { AssetPreview, PreviewFacts } from "@galatsa/format";
import { previewSizes } from "@galatsa/renderer";
import { describe, expect, it } from "vitest";
import { ensurePreviews, sessionAssetStore, type AssetAccess } from "./assets.ts";
import { readClipboard } from "./clipboard.ts";
import { chooseImporter, importSource, type ImportFile } from "./import.ts";
import { testEditor } from "./test-support.ts";

function png(width: number, height: number, salt = 0): Uint8Array {
  const b = new Uint8Array(40);
  b.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  b[36] = salt;
  return b;
}

function file(name: string, bytes: Uint8Array, type = ""): ImportFile {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

/** A session stand-in: assets by real SHA-256, previews in memory. */
function memoryAccess(): AssetAccess & {
  readonly assets: Map<AssetId, Uint8Array>;
  readonly previews: Map<AssetId, AssetPreview[]>;
} {
  const assets = new Map<AssetId, Uint8Array>();
  const previews = new Map<AssetId, AssetPreview[]>();
  return {
    assets,
    previews,
    async putAsset(bytes) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
      );
      const id =
        `sha256-${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}` as AssetId;
      assets.set(id, bytes);
      return id;
    },
    getAsset: async (id) => assets.get(id),
    async putPreviews(id, list) {
      previews.set(id, [...list]);
    },
    previewFacts: async (id): Promise<PreviewFacts[]> =>
      (previews.get(id) ?? []).map(({ width, height, mediaType }) => ({
        width,
        height,
        mediaType,
      })),
    getPreview: async (id, facts) =>
      previews.get(id)?.find((p) => p.width === facts.width)?.bytes,
  };
}

/** The whole set of versions an image of that size gets. */
const fakePreviews = async (
  _blob: Blob,
  natural: { width: number; height: number },
): Promise<AssetPreview[]> =>
  previewSizes(natural.width, natural.height).map((size) => ({
    ...size,
    mediaType: "image/webp" as const,
    bytes: new Uint8Array([1, 2, 3]),
  }));

function editorWithStore() {
  const access = memoryAccess();
  let made = 0;
  const store = sessionAssetStore(access, async (blob, natural) => {
    made++;
    return fakePreviews(blob, natural);
  });
  const { editor } = testEditor({ assetStore: store });
  return { editor, access, made: () => made };
}

describe("choosing an importer", () => {
  it("by media type or extension, else by the first bytes, else none", async () => {
    const { editor } = testEditor();
    const byName = await chooseImporter(
      editor.host,
      importSource(file("a.png", png(1, 1))),
      "quick",
    );
    expect(byName?.id).toBe("examples.image/files");
    const bySniff = await chooseImporter(
      editor.host,
      importSource(file("noname", png(1, 1))),
      "quick",
    );
    expect(bySniff?.id).toBe("examples.image/files");
    const none = await chooseImporter(
      editor.host,
      importSource(file("noname", new Uint8Array([1, 2, 3]))),
      "quick",
    );
    expect(none).toBeNull();
  });
});

describe("importing files", () => {
  it("pastes several files as one undo step, centred where they were dropped, and selects them", async () => {
    const { editor } = editorWithStore();
    const steps = editor.undo.undoStack.length;
    const pasted = await editor.importFiles(
      [file("a.png", png(100, 50, 1)), file("b.png", png(100, 50, 2))],
      { x: 300, y: 200 },
    );
    expect(pasted).toBe(true);
    expect(editor.undo.undoStack.length).toBe(steps + 1);
    expect(editor.selection.length).toBe(2);
    const first = toSnapshot(editor.doc).elements[
      editor.selection[0]!
    ] as ExtensionElement;
    // A screen pixel is a world unit at (x, y): the first is centred on the drop.
    expect(first.pos.x + first.size.w / 2).toBeCloseTo(300, 6);
    expect(first.pos.y + first.size.h / 2).toBeCloseTo(200, 6);
    const ids = [...editor.selection];
    editor.undo.undo();
    expect(ids.every((id) => editor.live.isGone(id))).toBe(true);
  });

  it("stores the same image imported ten times once, and makes its reduced versions once", async () => {
    const { editor, access, made } = editorWithStore();
    for (let i = 0; i < 10; i++)
      await editor.importFiles([file("same.png", png(2000, 1000))]);
    const snapshot = toSnapshot(editor.doc);
    const elements = Object.values(snapshot.elements) as ExtensionElement[];
    expect(elements.length).toBe(10);
    expect(new Set(elements.map((e) => e.data.asset)).size).toBe(1);
    expect(Object.keys(snapshot.assets).length).toBe(1);
    expect(access.assets.size).toBe(1);
    expect(made()).toBe(1);
    expect(access.previews.get(elements[0]!.data.asset as AssetId)!.length).toBe(3);
  });

  it("says which files no importer takes", async () => {
    const { editor } = editorWithStore();
    const pasted = await editor.importFiles([file("notes.bin", new Uint8Array([7, 7]))]);
    expect(pasted).toBe(false);
    expect(editor.notice).toEqual({
      message: "editor:import.unsupported",
      values: { name: "notes.bin" },
    });
  });

  it("imports image files on the clipboard", async () => {
    const { editor } = editorWithStore();
    const content = readClipboard({
      types: ["Files"],
      getData: () => "",
      files: [file("copied.png", png(64, 64), "image/png")],
    });
    expect(editor.clipboardPaste(content)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.keys(toSnapshot(editor.doc).elements).length).toBe(1);
  });

  it("does not import without an asset store", async () => {
    const { editor } = testEditor();
    expect(editor.canImport).toBe(false);
    expect(await editor.importFiles([file("a.png", png(1, 1))])).toBe(false);
  });
});

describe("reduced versions", () => {
  it("are made for images large enough to need them, once", async () => {
    const access = memoryAccess();
    const id = await access.putAsset(png(4000, 3000));
    let calls = 0;
    const make = async (blob: Blob, natural: { width: number; height: number }) => {
      calls++;
      return fakePreviews(blob, natural);
    };
    const facts = { mediaType: "image/png", width: 4000, height: 3000 };
    expect(await ensurePreviews(access, id, png(4000, 3000), facts, make)).toBe(true);
    expect(await ensurePreviews(access, id, png(4000, 3000), facts, make)).toBe(false);
    expect(calls).toBe(1);
    // Small images, other media and unknown sizes get none.
    const small = { mediaType: "image/png", width: 200, height: 100 };
    expect(await ensurePreviews(access, id, png(1, 1), small, make)).toBe(false);
    expect(
      await ensurePreviews(
        access,
        id,
        png(1, 1),
        { mediaType: "video/mp4", width: 4000, height: 3000 },
        make,
      ),
    ).toBe(false);
    expect(
      await ensurePreviews(access, id, png(1, 1), { mediaType: "image/png" }, make),
    ).toBe(false);
    // A maker that fails costs the versions, nothing else.
    const other = await access.putAsset(png(5000, 3000));
    expect(
      await ensurePreviews(access, other, png(1, 1), facts, async () => {
        throw new Error("cannot decode");
      }),
    ).toBe(false);
  });
});
