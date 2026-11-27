// SPDX-License-Identifier: GPL-3.0-or-later

// The image extension against the real document model: reading data, the
// importer (the same file ten times is one asset), inserting, opacity, and
// cropping, which keeps the image where it is on the canvas, each one undo
// step; the crop geometry under rotation; drawing.

import type {
  AssetId,
  AssetInfo,
  ExtensionElement,
  ElementId,
  Rect,
} from "@galatsa/core";
import {
  createUndoManager,
  initDocument,
  setLocked,
  toSnapshot,
} from "@galatsa/core/ydoc";
import {
  EditorHost,
  type AssetStore,
  type CommandEnvironment,
  type ImportContext,
  type ImportSource,
  type ToolPointerEvent,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import {
  createRecordingDrawContext,
  createTestServices,
} from "@galatsa/extension-api/testing";
import { createI18n, memoryLocaleStorage } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { boxForCrop, dragCrop, fromBoxFrame, toBoxFrame, type CropBox } from "./crop.ts";
import {
  IMAGE_CROP,
  IMAGE_CROP_RESET,
  IMAGE_CROP_TOOL,
  IMAGE_IMPORTER,
  IMAGE_INSERT,
  IMAGE_SET_STYLE,
  IMAGE_TYPE,
  imageExtension,
  imageView,
  readImage,
} from "./index.ts";

/** ASCII text as bytes (TextEncoder is not in this package's environment). */
const asciiBytes = (text: string): Uint8Array =>
  new Uint8Array([...text].map((c) => c.charCodeAt(0)));

/** A PNG header of the given size (enough for the importer; never decoded here). */
function png(width: number, height: number, salt = 0): Uint8Array {
  const b = new Uint8Array(33 + 4);
  b.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[33] = salt;
  return b;
}

/** An asset store that keys by content, as the host's does (a stand-in hash). */
function memoryAssets(): AssetStore & { readonly stored: Map<AssetId, Uint8Array> } {
  const stored = new Map<AssetId, Uint8Array>();
  const hash = (bytes: Uint8Array): AssetId => {
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return `sha256-${h.toString(16).padStart(8, "0").repeat(8)}`;
  };
  return {
    stored,
    async put(bytes, facts) {
      const id = hash(bytes);
      stored.set(id, bytes);
      return { id, info: { ...facts, byteLength: bytes.length } as AssetInfo };
    },
    get: async (id) => stored.get(id),
  };
}

function source(name: string, bytes: Uint8Array, mediaType?: string): ImportSource {
  return {
    name,
    mediaType,
    size: bytes.length,
    bytes: async () => bytes,
    async *chunks() {
      yield bytes;
    },
  };
}

function setup() {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc);
  const i18n = createI18n({ dev: false, locale: "en", storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  expect(host.load([imageExtension])).toEqual([]);
  const services = createTestServices(doc);
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const run = (id: string, args?: unknown) => host.commands.execute(id, env(), args);
  const must = <R = unknown>(id: string, args?: unknown): R => {
    const outcome = host.commands.execute<R>(id, env(), args);
    if (!outcome.ok)
      throw new Error(`${id} failed: ${outcome.reason} ${String(outcome.error)}`);
    return outcome.value;
  };
  const element = (id: ElementId) => toSnapshot(doc).elements[id] as ExtensionElement;
  const assets = memoryAssets();
  const context: ImportContext = {
    assets,
    view: services.state.viewport,
    cancellation: { cancelled: false, onCancel: () => () => {} },
    progress: () => {},
  };
  const importer = host.importers().find((r) => r.id === IMAGE_IMPORTER)!.definition;
  return {
    doc,
    undo,
    host,
    services,
    env,
    run,
    must,
    element,
    assets,
    context,
    importer,
  };
}

const INFO: AssetInfo = {
  mediaType: "image/png",
  byteLength: 10,
  width: 4000,
  height: 3000,
  name: "photo.png",
};
const ASSET = `sha256-${"ab".repeat(32)}` as AssetId;

describe("data", () => {
  it("reads valid data without reports, and odd values as defaults", () => {
    const reports: string[] = [];
    const report = (path: string) => reports.push(path);
    expect(
      readImage({ asset: ASSET, crop: { x: 1, y: 2, w: 3, h: 4 }, opacity: 0.5 }, report),
    ).toEqual({
      asset: ASSET,
      crop: { x: 1, y: 2, w: 3, h: 4 },
      opacity: 0.5,
    });
    expect(readImage({}, report)).toEqual({ asset: null, crop: null, opacity: 1 });
    expect(reports).toEqual([]);
    // Lenient for growth: an opacity out of range is drawn clamped, unreported.
    expect(readImage({ opacity: 3 }, report).opacity).toBe(1);
    expect(reports).toEqual([]);
    readImage({ asset: "nope", crop: { x: 0, y: 0, w: 0, h: 1 }, opacity: "x" }, report);
    expect(reports).toEqual(["asset", "crop", "opacity"]);
  });
});

describe("import", () => {
  it("imports a PNG as an image sized to half the view, with its asset described", async () => {
    const t = setup();
    const result = await t.importer.read(source("photo.png", png(4000, 3000)), t.context);
    expect(result.notices).toEqual([]);
    const [root] = result.fragment.roots;
    const element = result.fragment.elements[root!] as ExtensionElement;
    expect(element.type).toBe(IMAGE_TYPE);
    // 1000 by 800 view: at most 500 by 400, proportions kept.
    expect(element.size).toEqual({ w: 500, h: 375 });
    const asset = element.data.asset as AssetId;
    expect(result.fragment.assets[asset]).toMatchObject({
      mediaType: "image/png",
      width: 4000,
      height: 3000,
      name: "photo.png",
    });
  });

  it("stores the same file imported ten times once", async () => {
    const t = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = await t.importer.read(source("same.png", png(800, 600)), t.context);
      const root = result.fragment.roots[0]!;
      ids.add((result.fragment.elements[root] as ExtensionElement).data.asset as string);
    }
    expect(ids.size).toBe(1);
    expect(t.assets.stored.size).toBe(1);
  });

  it("says when a file is not an image, or its size cannot be read", async () => {
    const t = setup();
    const text = await t.importer.read(
      source("notes.txt", asciiBytes("hello"), "text/plain"),
      t.context,
    );
    expect(text.fragment.roots).toEqual([]);
    expect(text.notices.map((n) => n.message)).toEqual([
      "galatsa.image:notice.not-image",
    ]);
    const odd = await t.importer.read(
      source("broken.png", new Uint8Array([1, 2])),
      t.context,
    );
    expect(odd.notices.map((n) => n.message)).toEqual([
      "galatsa.image:notice.size-unknown",
    ]);
    expect(t.importer.sniff!(png(1, 1))).toBe(true);
    expect(t.importer.sniff!(asciiBytes("<svg width='1'/>"))).toBe(true);
    expect(t.importer.sniff!(asciiBytes("plain"))).toBe(false);
  });
});

describe("commands", () => {
  it("inserts an image as one undo step, and changes its opacity", () => {
    const t = setup();
    const id = t.must<ElementId>(IMAGE_INSERT, { asset: ASSET, info: INFO });
    expect(t.element(id).size).toEqual({ w: 500, h: 375 });
    expect(toSnapshot(t.doc).assets[ASSET]).toMatchObject({ width: 4000 });
    expect(t.undo.undoStack.length).toBe(1);
    t.must(IMAGE_SET_STYLE, { ids: [id], key: "opacity", value: 0.25 });
    expect(t.element(id).data.opacity).toBe(0.25);
    // Out of range, or no change: refused.
    expect(t.run(IMAGE_SET_STYLE, { ids: [id], key: "opacity", value: 2 }).ok).toBe(
      false,
    );
    expect(t.run(IMAGE_SET_STYLE, { ids: [id], key: "opacity", value: 0.25 }).ok).toBe(
      false,
    );
    t.undo.undo();
    expect(t.element(id).data.opacity).toBe(1);
  });

  it("crops, keeping the shown part where it was on the canvas, and shows the whole image again", () => {
    const t = setup();
    const id = t.must<ElementId>(IMAGE_INSERT, {
      asset: ASSET,
      info: INFO,
      x: 100,
      y: 50,
      w: 400,
      h: 300,
    });
    // The image is 10 pixels per world unit. Keep its middle half.
    t.must(IMAGE_CROP, { id, crop: { x: 1000, y: 750, w: 2000, h: 1500 } });
    const cropped = t.element(id);
    expect(cropped.data.crop).toEqual({ x: 1000, y: 750, w: 2000, h: 1500 });
    expect(cropped.size).toEqual({ w: 200, h: 150 });
    expect(cropped.pos).toMatchObject({ x: 200, y: 125 });
    expect(t.undo.undoStack.length).toBe(2);
    // A crop is kept inside the image.
    t.must(IMAGE_CROP, { id, crop: { x: -500, y: 750, w: 3000, h: 1500 } });
    expect(t.element(id).data.crop).toEqual({ x: 0, y: 750, w: 2500, h: 1500 });
    expect(t.element(id).pos).toMatchObject({ x: 100, y: 125 });
    t.must(IMAGE_CROP_RESET, { ids: [id] });
    expect(t.element(id).data.crop).toBeNull();
    expect(t.element(id).size).toEqual({ w: 400, h: 300 });
    expect(t.element(id).pos).toMatchObject({ x: 100, y: 50 });
    // Nothing to change: refused, no step.
    expect(t.run(IMAGE_CROP_RESET, { ids: [id] }).ok).toBe(false);
    t.undo.undo();
    t.undo.undo();
    expect(t.element(id).size).toEqual({ w: 200, h: 150 });
  });

  it("refuses to crop locked images, other elements and images of unknown size", () => {
    const t = setup();
    const id = t.must<ElementId>(IMAGE_INSERT, { asset: ASSET, info: INFO });
    const crop: Rect = { x: 0, y: 0, w: 10, h: 10 };
    setLocked(t.doc, id, true);
    expect(t.run(IMAGE_CROP, { id, crop }).ok).toBe(false);
    const other = `sha256-${"cd".repeat(32)}` as AssetId;
    const unsized = t.must<ElementId>(IMAGE_INSERT, {
      asset: other,
      info: { mediaType: "image/png", byteLength: 3 },
    });
    expect(t.run(IMAGE_CROP, { id: unsized, crop }).ok).toBe(false);
    expect(t.run(IMAGE_CROP, { id: "nothing", crop }).ok).toBe(false);
  });
});

describe("crop geometry", () => {
  it("keeps every point of the image where it was, also when the image is turned", () => {
    const box: CropBox = { x: 10, y: 20, w: 300, h: 200, rot: 0.7 };
    const current: Rect = { x: 100, y: 50, w: 600, h: 400 };
    const next: Rect = { x: 250, y: 0, w: 300, h: 450 };
    const after = boxForCrop(box, current, next)!;
    const turned: CropBox = { ...after, rot: box.rot };
    // Image pixel (400, 200) before and after.
    const pixel = { x: 400, y: 200 };
    const before = fromBoxFrame(
      {
        x: ((pixel.x - current.x) * box.w) / current.w,
        y: ((pixel.y - current.y) * box.h) / current.h,
      },
      box,
    );
    const later = fromBoxFrame(
      {
        x: ((pixel.x - next.x) * turned.w) / next.w,
        y: ((pixel.y - next.y) * turned.h) / next.h,
      },
      turned,
    );
    expect(later.x).toBeCloseTo(before.x, 9);
    expect(later.y).toBeCloseTo(before.y, 9);
    // And the frames are each other's inverse.
    const p = toBoxFrame(fromBoxFrame({ x: 3, y: 4 }, box), box);
    expect(p.x).toBeCloseTo(3, 9);
    expect(p.y).toBeCloseTo(4, 9);
  });

  it("drags edges within the image", () => {
    const natural = { w: 1000, h: 500 };
    const shown: Rect = { x: 0, y: 0, w: 1000, h: 500 };
    // A box of 100 by 50: 10 pixels per unit.
    expect(dragCrop(shown, { w: 100, h: 50 }, natural, { h: -1, v: 0 }, 20, 0)).toEqual({
      x: 200,
      y: 0,
      w: 800,
      h: 500,
    });
    expect(dragCrop(shown, { w: 100, h: 50 }, natural, { h: 1, v: 1 }, 50, 50)).toEqual(
      shown,
    );
    expect(dragCrop(shown, { w: 100, h: 50 }, natural, { h: 1, v: 0 }, -500, 0)!.w).toBe(
      1,
    );
  });
});

describe("drawing", () => {
  it("draws the asset with its crop and opacity, and a stand-in while it is missing", () => {
    const model = { asset: ASSET, crop: { x: 1, y: 2, w: 3, h: 4 }, opacity: 0.5 };
    const ctx = createRecordingDrawContext();
    imageView.draw(model, ctx, { id: "e", w: 40, h: 30 });
    expect(ctx.calls.some((c) => c.op === "image")).toBe(true);
    const missing = createRecordingDrawContext({ missing: [ASSET] });
    imageView.draw(model, missing, { id: "e", w: 40, h: 30 });
    expect(missing.calls.some((c) => c.op === "text")).toBe(true);
    expect(imageView.assets!(model)).toEqual([ASSET]);
  });
});

function pointer(x: number, y: number): ToolPointerEvent {
  return {
    screen: { x, y },
    world: { x, y },
    pointerType: "mouse",
    button: 0,
    pressure: 0.5,
    modifiers: { shift: false, alt: false, ctrl: false, meta: false, mod: false },
  };
}

describe("the crop tool", () => {
  it("drags an edge of the selected image, previews without writing, and crops with one command", () => {
    const t = setup();
    const id = t.must<ElementId>(IMAGE_INSERT, {
      asset: ASSET,
      info: INFO,
      x: 0,
      y: 0,
      w: 400,
      h: 300,
    });
    t.services.selection.set([id]);
    const log = { done: 0, overlays: 0 };
    const session: ToolSession = {
      environment: t.env,
      run: (command, args) => t.host.commands.execute(command, t.env(), args),
      isEnabled: (command, args) => t.host.commands.isEnabled(command, t.env(), args),
      extensions: t.host,
      gesture: () => t.host.commands.beginGesture(t.env()),
      scale: () => 1,
      requestOverlay: () => (log.overlays += 1),
      editText: () => {},
      setCursor: () => {},
      done: () => (log.done += 1),
    };
    const tool = t.host.tools().find((r) => r.id === IMAGE_CROP_TOOL)!.definition;
    expect(tool.shortcuts).toEqual(["c"]);
    const handler = tool.start(session);
    const steps = t.undo.undoStack.length;
    // The right edge, from 400 to 300: a quarter of the image cut away.
    handler.pointerDown!(pointer(400, 150));
    handler.pointerMove!(pointer(350, 150));
    expect(t.element(id).data.crop).toBeNull();
    const overlay = createRecordingDrawContext();
    handler.drawOverlay!(overlay);
    expect(overlay.calls.some((c) => c.op === "image")).toBe(true);
    handler.pointerUp!(pointer(300, 150));
    expect(t.element(id).data.crop).toEqual({ x: 0, y: 0, w: 3000, h: 3000 });
    expect(t.element(id).size).toEqual({ w: 300, h: 300 });
    expect(t.undo.undoStack.length).toBe(steps + 1);
    // Escape leaves the tool; a click beside any image too.
    expect(
      handler.keyDown!({
        key: "Escape",
        modifiers: pointer(0, 0).modifiers,
        repeat: false,
      }),
    ).toBe(true);
    expect(log.done).toBe(1);
    handler.pointerDown!(pointer(900, 900));
    expect(log.done).toBe(2);
  });
});
