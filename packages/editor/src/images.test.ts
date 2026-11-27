// SPDX-License-Identifier: GPL-3.0-or-later

// The renderer's image source over the session (docs/adr/0012): stored reduced
// versions first and the original last; no original is read while reduced
// versions are there; an image without them is drawn from its original and
// gets them made in the background; the session's methods are called on the
// session itself.

import type { AssetId } from "@galatsa/core";
import { addAsset, initDocument } from "@galatsa/core/ydoc";
import type { AssetPreview, PreviewFacts } from "@galatsa/format";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AssetAccess } from "./assets.ts";
import { assetImages } from "./images.ts";

const ID = `sha256-${"12".repeat(32)}` as AssetId;

/** A session stand-in as a class, so a method called without its object fails as it would. */
class FakeSession implements AssetAccess {
  readonly #assets = new Map<AssetId, Uint8Array>();
  readonly #previews = new Map<AssetId, AssetPreview[]>();
  reads = 0;
  constructor(previews: AssetPreview[]) {
    this.#assets.set(ID, new Uint8Array([1, 2, 3]));
    if (previews.length > 0) this.#previews.set(ID, previews);
  }
  async putAsset(): Promise<AssetId> {
    return ID;
  }
  async getAsset(id: AssetId) {
    this.reads++;
    return this.#assets.get(id);
  }
  async putPreviews(id: AssetId, list: readonly AssetPreview[]) {
    this.#previews.set(id, [...list]);
  }
  async previewFacts(id: AssetId): Promise<PreviewFacts[]> {
    return (this.#previews.get(id) ?? []).map(({ width, height, mediaType }) => ({
      width,
      height,
      mediaType,
    }));
  }
  async getPreview(id: AssetId, facts: PreviewFacts) {
    return this.#previews.get(id)?.find((p) => p.width === facts.width)?.bytes;
  }
}

function doc(mediaType = "image/jpeg"): Y.Doc {
  const d = new Y.Doc();
  initDocument(d);
  addAsset(d, ID, { mediaType, byteLength: 3, width: 4000, height: 3000 });
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("images from the session", () => {
  it("lists the reduced versions and the original, and reads no original to list them", async () => {
    const session = new FakeSession([
      { width: 256, height: 192, mediaType: "image/webp", bytes: new Uint8Array([9]) },
      { width: 1024, height: 768, mediaType: "image/webp", bytes: new Uint8Array([8]) },
    ]);
    const arrived: string[] = [];
    const source = assetImages(doc(), session, (a) => arrived.push(...a));
    expect(source.levels(ID)).toBeUndefined();
    await tick();
    await tick();
    expect(arrived).toEqual([ID]);
    expect(source.levels(ID)).toEqual([
      { width: 256, height: 192 },
      { width: 1024, height: 768 },
      { width: 4000, height: 3000 },
    ]);
    const small = await source.blob(ID, 0);
    expect(small.type).toBe("image/webp");
    expect([...new Uint8Array(await small.arrayBuffer())]).toEqual([9]);
    expect(session.reads).toBe(0);
    const original = await source.blob(ID, 2);
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
        return [
          {
            width: 256,
            height: 192,
            mediaType: "image/webp",
            bytes: new Uint8Array([7]),
          },
        ];
      },
    });
    source.levels(ID);
    for (let i = 0; i < 10; i++) await tick();
    expect(made).toBe(1);
    // Told twice: when the original arrived, and when the versions were made.
    expect(arrived).toEqual([ID, ID]);
    source.levels(ID);
    for (let i = 0; i < 5; i++) await tick();
    expect(source.levels(ID)).toEqual([
      { width: 256, height: 192 },
      { width: 4000, height: 3000 },
    ]);
  });

  it("offers SVG as a scalable original", async () => {
    const session = new FakeSession([]);
    const source = assetImages(doc("image/svg+xml"), session, () => {}, {
      makePreviews: null,
    });
    source.levels(ID);
    for (let i = 0; i < 5; i++) await tick();
    expect(source.levels(ID)).toEqual([{ width: 4000, height: 3000, scalable: true }]);
  });
});
