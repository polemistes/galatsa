// SPDX-License-Identifier: GPL-3.0-or-later

// Images and the asset store in a real browser (docs/adr/0012), on the
// editor's development page (apps/web) with an empty document:
//
// - the same image dropped five times and pasted five times is one asset,
//   with its reduced versions made once, and a file picked through the
//   context menu is imported too;
// - an image of 12 megapixels does not stall the frames while the camera zooms
//   into it and out again;
// - a file with 200 images opens and draws without reading or decoding any
//   original (the reduced versions stored in the file are drawn);
// - an image and a cropped image, and the crop tool, look as stored
//   (images.spec.ts-snapshots/), compared by the canvas's own pixels.
//
// Every test image is drawn here, in the page; nothing is downloaded. Runs in
// the "chromium" and "editor-firefox" projects.

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en&scene=empty`;
const IMAGE = "galatsa.image/image";

/** The parts of the page's program the tests use (window.galatsaDev). */
interface Dev {
  galatsaDev: {
    ready: Promise<{
      storage: {
        exportFile(slot: string): Promise<Uint8Array | null>;
        importFile(
          bytes: Uint8Array,
          from: { name?: string },
        ): Promise<{ ok: boolean; session: Session }>;
      };
      restore(slot: string): Promise<void>;
      imageStats: { originalReads: number };
      state: { document: { session: Session } | null };
    }>;
    editor(): Editor | null;
  };
  /** Draws a test picture and encodes it (installed below). */
  galatsaTestImage(
    width: number,
    height: number,
    seed: number,
    type: string,
  ): Promise<Blob>;
}

interface Session {
  slot: string;
  checkpoint(): Promise<void>;
  close(): Promise<unknown>;
  previewFacts(id: string): Promise<Array<{ width: number; height: number }>>;
  getPreviews(id: string): Promise<Array<{ width: number; bytes: Uint8Array }>>;
}

interface Editor {
  doc: unknown;
  live: {
    ids(): Iterable<string>;
    isGone(id: string): boolean;
  };
  scene: {
    element(id: string): { type: string; data: Record<string, unknown> } | undefined;
  };
  pan(dx: number, dy: number): void;
  selection: readonly string[];
  importing: boolean;
  importFiles(files: File[], at?: { x: number; y: number }): Promise<boolean>;
  clipboardPaste(content: {
    fragment: undefined;
    origin: null;
    problem: null;
    text: null;
    files: File[];
  }): boolean;
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  fit(rect: { x: number; y: number; w: number; h: number }): void;
  fitAll(): void;
  zoomAt(point: { x: number; y: number }, factor: number): void;
  renderNow(): void;
  services: {
    selection: { set(ids: string[]): void };
    camera: { set(view: { space: null; cx: number; cy: number; zoom: number }): void };
    scene: { bounds(id: string): { x: number; y: number; w: number; h: number } | null };
  };
  tools: { select(id: string): void; current: string | null };
  renderer: {
    stats: { lastFrameMs: number; imagesIncomplete: boolean };
    images: {
      busy: boolean;
      decoderKind: string;
      stats: {
        failures: number;
        decodes: number;
        originalDecodes: number;
        originalLevelDecodes: number;
      };
    } | null;
  };
}

/** Draws a picture of shapes from a seed, for test images of any size. */
function installTestImages(): void {
  (window as unknown as Dev).galatsaTestImage = async (width, height, seed, type) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    let s = seed * 2654435761 + 1;
    const random = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${(seed * 47) % 360} 70% 55%)`);
    gradient.addColorStop(1, `hsl(${(seed * 47 + 120) % 360} 70% 35%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = `hsl(${Math.floor(random() * 360)} 80% 60%)`;
      ctx.beginPath();
      ctx.arc(
        random() * width,
        random() * height,
        (0.04 + random() * 0.12) * width,
        0,
        7,
      );
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(height / 4)}px sans-serif`;
    ctx.fillText(String(seed), width * 0.05, height * 0.6);
    return canvas.convertToBlob({ type, quality: 0.9 });
  };
}

async function start(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(installTestImages);
  await page.goto(URL);
  await page.evaluate(async () => {
    await (window as unknown as Dev).galatsaDev.ready;
  });
  await page.waitForFunction(
    () => (window as unknown as Dev).galatsaDev.editor() !== null,
  );
  expect(errors).toEqual([]);
}

/** Images in the document that the user sees, with their assets. */
async function images(page: Page): Promise<{ id: string; asset: string }[]> {
  return page.evaluate((type) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    return [...editor.live.ids()]
      .filter((id) => !editor.live.isGone(id) && editor.scene.element(id)?.type === type)
      .map((id) => ({ id, asset: String(editor.scene.element(id)!.data["asset"]) }));
  }, IMAGE);
}

/** Draws frames until every image on screen is drawn from the version it needs. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    for (let i = 0; i < 600; i++) {
      editor.renderNow();
      if (!editor.renderer.stats.imagesIncomplete && !editor.renderer.images?.busy)
        return;
      await frame();
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `images did not settle: ${JSON.stringify(editor.renderer.images?.stats)} ` +
        `busy ${editor.renderer.images?.busy}`,
    );
  });
}

test("the same image dropped and pasted ten times is one asset, and a picked file is imported", async ({
  page,
}) => {
  await start(page);
  const outcome = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const blob = await dev.galatsaTestImage(1200, 800, 7, "image/png");
    const surface = document.querySelector<HTMLElement>(".galatsa-canvas")!;
    surface.focus();
    const rect = surface.getBoundingClientRect();
    const transfer = (): DataTransfer => {
      const data = new DataTransfer();
      data.items.add(new File([blob], "photo.png", { type: "image/png" }));
      return data;
    };
    const idle = async () => {
      while (editor.importing) await new Promise((r) => setTimeout(r, 20));
    };
    for (let i = 0; i < 5; i++) {
      const data = transfer();
      const over = new DragEvent("dragover", {
        dataTransfer: data,
        cancelable: true,
        bubbles: true,
      });
      surface.dispatchEvent(over);
      surface.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          cancelable: true,
          bubbles: true,
          clientX: rect.left + 100 + i * 60,
          clientY: rect.top + 100 + i * 40,
        }),
      );
      await idle();
    }
    // Firefox does not pass files given to a synthetic paste event on to its
    // listeners (a real paste carries them); there the editor gets the same
    // clipboard content directly.
    let carried = 0;
    const probe = (e: ClipboardEvent) => {
      carried = e.clipboardData?.files.length ?? 0;
    };
    document.addEventListener("paste", probe, { capture: true });
    for (let i = 0; i < 5; i++) {
      surface.focus();
      const data = transfer();
      surface.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          cancelable: true,
          bubbles: true,
        }),
      );
      if (carried === 0)
        editor.clipboardPaste({
          fragment: undefined,
          origin: null,
          problem: null,
          text: null,
          files: [...data.files],
        });
      await new Promise((r) => setTimeout(r, 0));
      await idle();
    }
    document.removeEventListener("paste", probe, { capture: true });
    return { dropAccepted: true, synthetic: carried > 0 };
  });
  expect(outcome.dropAccepted).toBe(true);
  const placed = await images(page);
  expect(placed.length).toBe(10);
  expect(new Set(placed.map((p) => p.asset)).size).toBe(1);
  const facts = await page.evaluate(async (asset) => {
    const app = await (window as unknown as Dev).galatsaDev.ready;
    const session = app.state.document!.session;
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const assets = (editor.doc as { getMap(name: string): { size: number } }).getMap(
      "assets",
    );
    return { previews: await session.previewFacts(asset), described: assets.size };
  }, placed[0]!.asset);
  expect(facts.described).toBe(1);
  // 1200 by 800: versions with long sides 256 and 512 (768 is not under 800 / 1.5).
  expect(facts.previews.map((p) => p.width)).toEqual([256, 512]);

  // A file picked through the context menu ("Insert a file…").
  const png = await page.evaluate(async () => {
    const blob = await (window as unknown as Dev).galatsaTestImage(
      300,
      200,
      3,
      "image/png",
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  });
  await page
    .locator(".galatsa-canvas")
    .click({ button: "right", position: { x: 40, y: 600 } });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Insert a file…" }).click();
  await (
    await chooser
  ).setFiles({
    name: "picked.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect.poll(async () => (await images(page)).length).toBe(11);
});

test("an image of 12 megapixels does not stall the frames while zooming", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await start(page);
  const result = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const blob = await dev.galatsaTestImage(4000, 3000, 12, "image/jpeg");
    await editor.importFiles([new File([blob], "twelve.jpg", { type: "image/jpeg" })]);
    const id = editor.selection[0]!;
    editor.services.selection.set([]);
    editor.fit(editor.services.scene.bounds(id)!);
    const surface = document.querySelector<HTMLElement>(".galatsa-canvas")!;
    const centre = { x: surface.clientWidth / 2, y: surface.clientHeight / 2 };
    const frame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));
    // Let the first version arrive, as a user would see it appear.
    for (let i = 0; i < 100 && editor.renderer.stats.imagesIncomplete; i++) {
      editor.renderNow();
      await frame();
    }
    const intervals: number[] = [];
    const renders: number[] = [];
    let last = await frame();
    // In by 2^5 (until the original is needed), a while there moving a little
    // (the original is decoded meanwhile), and out again: 300 frames.
    for (let i = 0; i < 300; i++) {
      if (i < 120) editor.zoomAt(centre, 2 ** (5 / 120));
      else if (i < 180) editor.pan(i % 2 === 0 ? 3 : -3, 0);
      else editor.zoomAt(centre, 2 ** (-5 / 120));
      const now = await frame();
      intervals.push(now - last);
      renders.push(editor.renderer.stats.lastFrameMs);
      last = now;
    }
    const stats = editor.renderer.images!.stats;
    // What the reduced versions cost beside the original.
    const app = await dev.galatsaDev.ready;
    const asset = String(editor.scene.element(id)!.data["asset"]);
    const versions = await app.state.document!.session.getPreviews(asset);
    return {
      originalBytes: blob.size,
      versions: versions.map((v) => `${v.width}:${v.bytes.length}`),
      intervals,
      renders,
      decoder: editor.renderer.images!.decoderKind,
      originalDecodes: stats.originalDecodes,
      decodes: stats.decodes,
    };
  });
  const over = (limit: number) => result.intervals.filter((t) => t > limit).length;
  const maxRender = Math.max(...result.renders);
  console.log(
    `12 MP zoom (${result.decoder}): frames over 33 ms ${over(33)}, over 50 ms ${over(50)}, ` +
      `over 100 ms ${over(100)} of ${result.intervals.length}; longest frame ` +
      `${Math.max(...result.intervals).toFixed(1)} ms; render() max ${maxRender.toFixed(1)} ms; ` +
      `decodes ${result.decodes}, of the original at full size ${result.originalDecodes}; ` +
      `original ${result.originalBytes} bytes, versions (long side:bytes) ${result.versions.join(" ")}`,
  );
  // Decoding happens off the main thread: no frame stalls while new versions
  // load, and drawing stays well within a frame.
  expect(over(100)).toBe(0);
  expect(over(50)).toBeLessThanOrEqual(3);
  expect(maxRender).toBeLessThan(25);
  expect(result.decodes).toBeGreaterThan(1);
});

test("a file with 200 images opens without reading or decoding an original", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await start(page);
  const made = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    for (let batch = 0; batch < 2; batch++) {
      const files: File[] = [];
      for (let i = 0; i < 100; i++) {
        const seed = batch * 100 + i;
        const blob = await dev.galatsaTestImage(800, 600, seed, "image/jpeg");
        files.push(new File([blob], `image-${seed}.jpg`, { type: "image/jpeg" }));
      }
      await editor.importFiles(files);
    }
    const app = await dev.galatsaDev.ready;
    const session = app.state.document!.session;
    await session.checkpoint();
    const bytes = await app.storage.exportFile(session.slot);
    if (bytes === null) throw new Error("not exported");
    // The file opens as a new stored document, shown in the editor.
    const opened = await app.storage.importFile(bytes, { name: "two-hundred.galatsa" });
    if (!opened.ok) throw new Error("not opened");
    const slot = opened.session.slot;
    await opened.session.close();
    await app.restore(slot);
    return { size: bytes.length };
  });
  expect(made.size).toBeGreaterThan(0);
  await page.waitForFunction(
    () => (window as unknown as Dev).galatsaDev.editor() !== null,
  );
  expect((await images(page)).length).toBe(200);
  await settle(page);
  const stats = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const app = await dev.galatsaDev.ready;
    return {
      reads: app.imageStats.originalReads,
      ...editor.renderer.images!.stats,
    };
  });
  console.log(
    `200 images: ${stats.decodes} versions decoded, originals read ${stats.reads}, ` +
      `originals decoded ${stats.originalLevelDecodes}`,
  );
  expect(stats.decodes).toBeGreaterThanOrEqual(200);
  expect(stats.reads).toBe(0);
  expect(stats.originalLevelDecodes).toBe(0);
});

/** The canvas's pixels as PNG. */
async function canvasPng(page: Page): Promise<Buffer> {
  const data = await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    editor.renderNow();
    const canvas = document.querySelector<HTMLCanvasElement>(".galatsa-canvas canvas")!;
    return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  });
  return Buffer.from(data, "base64");
}

test("an image, a cropped image and the crop tool look as stored", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 500 });
  await start(page);
  // The canvas 800 by 500, beside the toolbar and the properties (docs/adr/0016).
  const canvasSize = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>(".galatsa-canvas")!;
      return { w: canvas.clientWidth, h: canvas.clientHeight };
    });
  // The toolbar may wrap at one width and not at another, so adjust until the
  // canvas has the size asked for.
  let viewport = { width: 800, height: 500 };
  for (let i = 0; i < 4; i++) {
    const shown = await canvasSize();
    if (shown.w === 800 && shown.h === 500) break;
    viewport = {
      width: viewport.width + 800 - shown.w,
      height: viewport.height + 500 - shown.h,
    };
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
  }
  await expect.poll(canvasSize).toEqual({ w: 800, h: 500 });
  await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    // Small enough to need no reduced versions: the original is drawn.
    const blob = await dev.galatsaTestImage(300, 200, 5, "image/png");
    await editor.importFiles([new File([blob], "small.png", { type: "image/png" })]);
    const first = editor.selection[0]!;
    await editor.importFiles([new File([blob], "small.png", { type: "image/png" })]);
    const second = editor.selection[0]!;
    editor.run("galatsa.basics/move", { ids: [first], dx: -170, dy: 0 });
    editor.run("galatsa.basics/move", { ids: [second], dx: 170, dy: 0 });
    const cropped = editor.run("galatsa.image/crop", {
      id: second,
      crop: { x: 60, y: 30, w: 150, h: 120 },
    });
    if (!cropped.ok) throw new Error("not cropped");
    editor.services.selection.set([]);
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
  });
  await settle(page);
  const view = await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const ids = [...editor.live.ids()].filter((id) => !editor.live.isGone(id));
    return ids.map((id) => editor.services.scene.bounds(id));
  });
  expect(view.length).toBe(2);
  expect.soft(await canvasPng(page)).toMatchSnapshot("image-and-crop.png", {
    threshold: 0.01,
    maxDiffPixels: 16,
  });
  // The crop tool on the cropped image: the whole image outlined, the part
  // outside the crop shaded, the crop with its handles.
  await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const ids = [...editor.live.ids()].filter((id) => !editor.live.isGone(id));
    const cropped = ids.find((id) => editor.scene.element(id)!.data["crop"] !== null)!;
    editor.services.selection.set([cropped]);
    editor.tools.select("galatsa.image/crop-tool");
  });
  await settle(page);
  expect.soft(await canvasPng(page)).toMatchSnapshot("crop-tool.png", {
    threshold: 0.01,
    maxDiffPixels: 16,
  });
});

test("the crop tool crops by dragging an edge, as one undo step", async ({ page }) => {
  await start(page);
  const before = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    const blob = await dev.galatsaTestImage(400, 300, 9, "image/png");
    await editor.importFiles([new File([blob], "crop.png", { type: "image/png" })]);
    const id = editor.selection[0]!;
    editor.tools.select("galatsa.image/crop-tool");
    return { id, bounds: editor.services.scene.bounds(id)! };
  });
  const canvas = page.locator(".galatsa-canvas");
  const box = (await canvas.boundingBox())!;
  // The camera's centre is the middle of the canvas; drag the right edge left by 100.
  const x = box.x + box.width / 2 + before.bounds.x + before.bounds.w;
  const y = box.y + box.height / 2 + before.bounds.y + before.bounds.h / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 50, y, { steps: 4 });
  await page.mouse.move(x - 100, y, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate((id) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    return {
      crop: editor.scene.element(id)!.data["crop"],
      bounds: editor.services.scene.bounds(id)!,
    };
  }, before.id);
  expect(after.bounds.x).toBeCloseTo(before.bounds.x, 6);
  expect(after.bounds.w).toBeCloseTo(before.bounds.w - 100, 6);
  expect(after.crop).toMatchObject({ x: 0, y: 0, h: 300 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  const undone = await page.evaluate((id) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    return editor.scene.element(id)!.data["crop"];
  }, before.id);
  expect(undone).toBeNull();
});

test("WebP and SVG files are imported and drawn", async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    const webp = await dev.galatsaTestImage(1000, 800, 21, "image/webp");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">' +
      '<rect width="40" height="20" fill="#ff0000"/></svg>';
    await editor.importFiles([
      new File([webp], "picture.webp", { type: "image/webp" }),
      new File([svg], "red.svg", { type: "" }),
    ]);
    const [, svgId] = editor.selection;
    const element = editor.scene.element(svgId!)!;
    const bounds = editor.services.scene.bounds(svgId!)!;
    editor.services.selection.set([]);
    // The SVG, 40 by 20 by its viewBox, zoomed far in: drawn sharp from the vector.
    editor.services.camera.set({
      space: null,
      cx: bounds.x + bounds.w / 2,
      cy: bounds.y + bounds.h / 2,
      zoom: 16,
    });
    return { type: element.type, webpType: webp.type };
  });
  expect(result.type).toBe(IMAGE);
  expect(result.webpType).toBe("image/webp");
  await settle(page);
  const pixel = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".galatsa-canvas canvas")!;
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    editor.renderNow();
    const data = canvas
      .getContext("2d")!
      .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return {
      rgb: [data[0], data[1], data[2]],
      failures: editor.renderer.images!.stats.failures,
    };
  });
  expect(pixel.rgb).toEqual([255, 0, 0]);
  expect(pixel.failures).toBe(0);
});

test("the size of a PNG or WebP turned by EXIF is the size browsers show", async ({
  page,
}) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const editor = dev.galatsaDev.editor()!;
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (bytes: Uint8Array): number => {
      let c = 0xffffffff;
      for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    // A TIFF header with one entry: orientation 6 (turned a quarter).
    const tiff = new Uint8Array([
      0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0,
      0, 0,
    ]);
    const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
    const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const sizes: Record<string, unknown> = {};
    for (const type of ["image/png", "image/webp"]) {
      const plain = new Uint8Array(
        await (await dev.galatsaTestImage(400, 200, 8, type)).arrayBuffer(),
      );
      let bytes: Uint8Array;
      if (type === "image/png") {
        const body = new Uint8Array([...ascii("eXIf"), ...tiff]);
        const chunk = [...be32(tiff.length), ...body, ...be32(crc(body))];
        bytes = new Uint8Array([
          ...plain.subarray(0, 33),
          ...chunk,
          ...plain.subarray(33),
        ]);
      } else {
        const extended = String.fromCharCode(...plain.subarray(12, 16)) === "VP8X";
        const image = plain.subarray(extended ? 30 : 12);
        const vp8x = [
          ...ascii("VP8X"),
          ...le32(10),
          (extended ? plain[20]! : 0) | 0x08,
          0,
          0,
          0,
          ...le24(399),
          ...le24(199),
        ];
        const exif = [...ascii("EXIF"), ...le32(tiff.length), ...tiff];
        const chunks = [...vp8x, ...image, ...exif];
        bytes = new Uint8Array([
          ...ascii("RIFF"),
          ...le32(chunks.length + 4),
          ...ascii("WEBP"),
          ...chunks,
        ]);
      }
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
      const bitmap = await createImageBitmap(blob);
      await editor.importFiles([new File([blob], `turned.${type.slice(6)}`, { type })]);
      const asset = String(editor.scene.element(editor.selection[0]!)!.data["asset"]);
      const description = (
        editor.doc as { getMap(n: string): { get(k: string): unknown } }
      )
        .getMap("assets")
        .get(asset) as { width: number; height: number };
      sizes[type] = {
        browser: [bitmap.width, bitmap.height],
        described: [description.width, description.height],
      };
    }
    return sizes;
  });
  for (const type of ["image/png", "image/webp"]) {
    const { browser, described } = result[type] as {
      browser: number[];
      described: number[];
    };
    expect(described, type).toEqual(browser);
  }
});

/** Imports SVG text, shows it filling most of the view, and reads canvas pixels at fractions of its box. */
async function svgPixels(
  page: Page,
  svg: string,
  points: readonly (readonly [number, number])[],
): Promise<number[][]> {
  const id = await page.evaluate(async (text) => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    await editor.importFiles([new File([text], "test.svg", { type: "image/svg+xml" })]);
    const id = editor.selection[0]!;
    editor.services.selection.set([]);
    const b = editor.services.scene.bounds(id)!;
    editor.fit(b);
    return id;
  }, svg);
  await settle(page);
  return page.evaluate(
    ([id, at]) => {
      const dev = window as unknown as Dev;
      const editor = dev.galatsaDev.editor()!;
      editor.renderNow();
      const box = (
        editor.renderer as unknown as {
          screenBounds(id: string): { x: number; y: number; w: number; h: number };
        }
      ).screenBounds(id);
      const canvas = document.querySelector<HTMLCanvasElement>(".galatsa-canvas canvas")!;
      const ratio = canvas.width / canvas.clientWidth;
      const ctx = canvas.getContext("2d")!;
      return at.map(([fx, fy]) => {
        const d = ctx.getImageData(
          Math.round((box.x + box.w * fx) * ratio),
          Math.round((box.y + box.h * fy) * ratio),
          1,
          1,
        ).data;
        return [d[0]!, d[1]!, d[2]!];
      });
    },
    [id, points] as const,
  );
}

test("SVG without a viewBox is drawn at its size in cm, pt or %", async ({ page }) => {
  await start(page);
  const quadrants = (w: number, h: number, size: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${size}>` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
    `<rect width="${w / 2}" height="${h / 2}" fill="#ff0000"/>` +
    `<rect x="${w / 2}" y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#0000ff"/></svg>`;
  const cases = [
    quadrants((4 * 96) / 2.54, (2 * 96) / 2.54, 'width="4cm" height="2cm"'),
    quadrants(160, 80, 'width="120pt" height="60pt"'),
    quadrants(300, 150, 'width="100%" height="100%"'),
  ];
  for (const svg of cases) {
    const [topLeft, bottomRight, topRight] = await svgPixels(page, svg, [
      [0.25, 0.25],
      [0.75, 0.75],
      [0.75, 0.25],
    ]);
    expect(topLeft, svg).toEqual([255, 0, 0]);
    expect(bottomRight, svg).toEqual([0, 0, 255]);
    expect(topRight, svg).toEqual([255, 255, 255]);
  }
});

test("an SVG with HTML in it never makes the canvas unreadable", async ({ page }) => {
  await start(page);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
    '<rect width="200" height="100" fill="#ff0000"/>' +
    '<foreignObject width="200" height="50"><div xmlns="http://www.w3.org/1999/xhtml">' +
    "<p>HTML</p></div></foreignObject>" +
    '<image href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E" width="10" height="10"/>' +
    "</svg>";
  // getImageData on the document's canvas works after drawing it (it would
  // throw on a canvas made unreadable), and the red square is drawn.
  const [pixel] = await svgPixels(page, svg, [[0.5, 0.8]]);
  expect(pixel).toEqual([255, 0, 0]);
  const region = await page.evaluate(async () => {
    const editor = (window as unknown as Dev).galatsaDev.editor()!;
    const renderer = editor.renderer as unknown as {
      renderRegion(
        region: { space: null; rect: { x: number; y: number; w: number; h: number } },
        image: { width: number; height: number; mediaType: string },
      ): Promise<Uint8Array>;
    };
    const id = [...editor.live.ids()].find((i) => !editor.live.isGone(i))!;
    const bytes = await renderer.renderRegion(
      { space: null, rect: editor.services.scene.bounds(id)! },
      { width: 200, height: 100, mediaType: "image/png" },
    );
    return bytes.length;
  });
  expect(region).toBeGreaterThan(0);
});

test("an image pasted into another document brings its bytes along", async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const dev = window as unknown as Dev;
    const first = dev.galatsaDev.editor()!;
    const blob = await dev.galatsaTestImage(900, 600, 31, "image/png");
    await first.importFiles([new File([blob], "carried.png", { type: "image/png" })]);
    const asset = String(first.scene.element(first.selection[0]!)!.data["asset"]);
    const copied = (first as unknown as { clipboardCopy(): boolean }).clipboardCopy();
    const fragment = (first as unknown as { clipboard: unknown }).clipboard;
    // Another, new document.
    const app = await dev.galatsaDev.ready;
    const created = await (
      app.storage as unknown as { create(): Promise<Session> }
    ).create();
    const slot = created.slot;
    await created.close();
    await app.restore(slot);
    const second = dev.galatsaDev.editor()!;
    const pasted = (
      second as unknown as {
        clipboardPaste(content: unknown): boolean;
      }
    ).clipboardPaste({ fragment, origin: null, problem: null, text: null, files: [] });
    for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 20));
    const session = app.state.document!.session as unknown as {
      getAsset(id: string): Promise<Uint8Array | undefined>;
    };
    return {
      copied,
      pasted,
      bytes: (await session.getAsset(asset))?.length ?? 0,
      versions: (await app.state.document!.session.previewFacts(asset)).length,
      notice: (second as unknown as { notice: unknown }).notice,
    };
  });
  expect(result.copied && result.pasted).toBe(true);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.versions).toBe(2);
  expect(result.notice).toBeNull();
  await settle(page);
});
