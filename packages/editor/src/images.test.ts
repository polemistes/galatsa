// SPDX-License-Identifier: GPL-3.0-or-later

// The renderer's image source over the session (docs/adr/0012): stored reduced
// versions first and the original last; no original is read while every
// version is there; versions that are missing (all, or the larger ones of a
// file shared with the smallest only) are made in the background and stored;
// a version that does not decode is made again over the stored one; versions
// that do not fit the image are not offered; the session's methods are called
// on the session itself.

import type { AssetId } from "@galatsa/core";
import { addAsset, initDocument } from "@galatsa/core/ydoc";
import type { AssetPreview, PreviewFacts } from "@galatsa/format";
import { previewSizes } from "@galatsa/renderer";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AssetAccess } from "./assets.ts";
import { assetImages } from "./images.ts";

const ID = `sha256-${"12".repeat(32)}` as AssetId;

function version(width: number, height: number, fill: number): AssetPreview {
  return { width, height, mediaType: "image/webp", bytes: new Uint8Array([fill]) };
}

/** The whole set of versions of a 4000 by 3000 image (256, 512, 1024, 2048). */
function fullSet(fill = 1): AssetPreview[] {
  return previewSizes(4000, 3000).map((s) => version(s.width, s.height, fill));
}

/** A session stand-in as a class, so a method called without its object fails as it would. */
class FakeSession implements AssetAccess {
  readonly #assets = new Map<AssetId, Uint8Array>();
  readonly previews = new Map<AssetId, AssetPreview[]>();
  reads = 0;
  replaced = 0;
  constructor(previews: AssetPreview[]) {
    this.#assets.set(ID, new Uint8Array([1, 2, 3]));
    if (previews.length > 0) this.previews.set(ID, previews);
  }
  async putAsset(): Promise<AssetId> {
    return ID;
  }
  async getAsset(id: AssetId) {
    this.reads++;
    return this.#assets.get(id);
  }
  async putPreviews(
    id: AssetId,
    list: readonly AssetPreview[],
    options?: { readonly replace?: boolean },
  ) {
    if (options?.replace) this.replaced++;
    const old = this.previews.get(id) ?? [];
    // As the store does: a size already stored keeps its bytes unless replaced.
    const [first, second] = options?.replace ? [list, old] : [old, list];
    this.previews.set(id, [
      ...first,
      ...second.filter((n) => !first.some((p) => p.width === n.width)),
    ]);
  }
  async previewFacts(id: AssetId): Promise<PreviewFacts[]> {
    return (this.previews.get(id) ?? [])
      .map(({ width, height, mediaType }) => ({ width, height, mediaType }))
      .sort((a, b) => a.width - b.width);
  }
  async getPreview(id: AssetId, facts: PreviewFacts) {
    return this.previews.get(id)?.find((p) => p.width === facts.width)?.bytes;
  }
}

function doc(mediaType = "image/jpeg"): Y.Doc {
  const d = new Y.Doc();
  initDocument(d);
  addAsset(d, ID, { mediaType, byteLength: 3, width: 4000, height: 3000 });
  return d;
}

const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("images from the session", () => {
  it("lists the reduced versions and the original, and reads no original to list them", async () => {
    const session = new FakeSession(fullSet(9));
    const arrived: string[] = [];
    let made = 0;
    const source = assetImages(doc(), session, (a) => arrived.push(...a), {
      makePreviews: async () => {
        made++;
        return [];
      },
    });
    expect(source.levels(ID)).toBeUndefined();
    await ticks();
    expect(arrived).toEqual([ID]);
    expect(source.levels(ID)).toEqual([
      { width: 256, height: 192 },
      { width: 512, height: 384 },
      { width: 1024, height: 768 },
      { width: 2048, height: 1536 },
      { width: 4000, height: 3000 },
    ]);
    const small = await source.blob(ID, 0);
    expect(small.type).toBe("image/webp");
    expect([...new Uint8Array(await small.arrayBuffer())]).toEqual([9]);
    expect(session.reads).toBe(0);
    expect(made).toBe(0);
    const original = await source.blob(ID, 4);
    expect(original.type).toBe("image/jpeg");
    expect(session.reads).toBe(1);
  });

  it("draws an image without reduced versions from its original and makes them in the background", async () => {
    const session = new FakeSession([]);
    const arrived: string[] = [];
    let made = 0;
    const source = assetImages(doc(), session, (a) => arrived.push(...a), {
      makePreviews: async () => {
        made++;
        return fullSet(7);
      },
    });
    source.levels(ID);
    await ticks();
    expect(made).toBe(1);
    // Told twice: when the original arrived, and when the versions were made.
    expect(arrived).toEqual([ID, ID]);
    source.levels(ID);
    await ticks();
    expect(source.levels(ID)!.map((l) => l.width)).toEqual([256, 512, 1024, 2048, 4000]);
  });

  it("makes the missing larger versions of an image that has only the smallest (a shared file), and stores them", async () => {
    const session = new FakeSession([version(256, 192, 5)]);
    let made = 0;
    const source = assetImages(doc(), session, () => {}, {
      makePreviews: async () => {
        made++;
        return fullSet(6);
      },
    });
    source.levels(ID);
    await ticks();
    expect(made).toBe(1);
    expect((await session.previewFacts(ID)).map((f) => f.width)).toEqual([
      256, 512, 1024, 2048,
    ]);
    // The stored smallest one is kept as it was.
    expect([
      ...(await session.getPreview(ID, {
        width: 256,
        height: 192,
        mediaType: "image/webp",
      }))!,
    ]).toEqual([5]);
    source.levels(ID);
    await ticks();
    expect(source.levels(ID)!.length).toBe(5);
    expect(made).toBe(1);
  });

  it("makes the versions again over the stored ones when one does not decode, once", async () => {
    const session = new FakeSession(fullSet(1));
    let made = 0;
    const source = assetImages(doc(), session, () => {}, {
      makePreviews: async () => {
        made++;
        return fullSet(2);
      },
    });
    source.levels(ID);
    await ticks();
    expect(made).toBe(0);
    source.failed!(ID, 1);
    await ticks();
    expect(made).toBe(1);
    expect(session.replaced).toBe(1);
    expect([
      ...(await session.getPreview(ID, {
        width: 512,
        height: 384,
        mediaType: "image/webp",
      }))!,
    ]).toEqual([2]);
    source.levels(ID);
    await ticks();
    // A failure of the original, or a second one, makes nothing again.
    source.failed!(ID, 4);
    source.failed!(ID, 0);
    await ticks();
    expect(made).toBe(1);
  });

  it("tries a maker that gives other sizes than asked for only once", async () => {
    const session = new FakeSession([]);
    let made = 0;
    const source = assetImages(doc(), session, () => {}, {
      makePreviews: async () => {
        made++;
        return [version(300, 225, 3)];
      },
    });
    for (let round = 0; round < 3; round++) {
      source.levels(ID);
      await ticks();
    }
    expect(made).toBe(1);
  });

  it("offers no stored version that does not fit the image", async () => {
    const session = new FakeSession([
      ...fullSet(1),
      version(4096, 4096, 8),
      version(500, 500, 8),
    ]);
    const source = assetImages(doc(), session, () => {}, { makePreviews: null });
    source.levels(ID);
    await ticks();
    expect(source.levels(ID)!.map((l) => l.width)).toEqual([256, 512, 1024, 2048, 4000]);
  });

  it("offers SVG as a scalable original", async () => {
    const session = new FakeSession([]);
    const source = assetImages(doc("image/svg+xml"), session, () => {}, {
      makePreviews: null,
    });
    source.levels(ID);
    await ticks(5);
    expect(source.levels(ID)).toEqual([{ width: 4000, height: 3000, scalable: true }]);
  });
});
