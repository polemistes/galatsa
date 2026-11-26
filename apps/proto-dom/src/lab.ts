// SPDX-License-Identifier: GPL-3.0-or-later

// A page for looking at the DOM engine outside the benchmark: small scenes, a camera
// that scripts can set or animate, and text editing. The Playwright tests in e2e/
// drive it through window.protoLab. Double-click a text to edit it.

import type { CameraPose, Scene, SceneElement, TextElement } from "@galatsa/bench";
import { createDomEngine, type DomEngine } from "./engine.ts";
import { VARIANTS } from "./engines.ts";

export type LabScene = "text" | "precision";

export interface LabApi {
  init(variant: string, scene: LabScene): Promise<void>;
  /** The camera to render from the next frame on; stops any animation. */
  setCamera(pose: CameraPose): void;
  /** Resolves after n animation frames. */
  frames(n: number): Promise<void>;
  /**
   * Animates from the current camera to `to` over `frames` frames (zoom
   * geometric, position linear). With keepMoving, the camera keeps moving by a
   * millionth of a pixel back and forth at `to`, so the engine stays in its moving
   * state, until stop() is called.
   */
  play(to: CameraPose, frames: number, keepMoving: boolean): Promise<void>;
  /** Holds the camera still at its current target. */
  stop(): void;
  /** Milliseconds until the engine's next reportTextSharp(), or null on timeout. */
  waitSharp(timeoutMs: number): Promise<number | null>;
  beginEdit(id: string): boolean;
  endEdit(): void;
  textOf(id: string): string | undefined;
  stats(): Record<string, number>;
  /**
   * Finds the first light-to-dark edge along row `y` of a PNG screenshot (base64),
   * between x0 and x1, with sub-pixel interpolation. Returns null if none.
   */
  findEdge(png: string, y: number, x0: number, x1: number): Promise<number | null>;
  /**
   * Mean absolute difference in brightness (0 to 255) between neighbouring pixels
   * of a PNG screenshot (base64): higher is sharper for the same content.
   */
  sharpness(png: string): Promise<number>;
}

async function decodePng(png: string): Promise<ImageData> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

declare global {
  interface Window {
    protoLab?: LabApi;
  }
}

export const VIEWPORT = { width: 1280, height: 720 } as const;

function text(
  id: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  extra: Partial<TextElement>,
  content: string,
): TextElement {
  return {
    kind: "text",
    id,
    x,
    y,
    width,
    height: Math.ceil(fontSize * 1.25 * 6),
    rotation: 0,
    opacity: 1,
    text: content,
    fontFamily: "sans-serif",
    fontSize,
    fontWeight: 400,
    lineHeight: 1.25,
    color: "#111111",
    align: "left",
    ...extra,
  };
}

/** World position of the lab texts; the same as the middle of the bench scene. */
export const ORIGIN = { x: 28800, y: 6600 } as const;

function labScene(kind: LabScene): Scene {
  const elements: SceneElement[] = [];
  if (kind === "text") {
    elements.push({
      kind: "shape",
      id: "backdrop",
      shape: "rect",
      x: ORIGIN.x - 100,
      y: ORIGIN.y - 100,
      width: 700,
      height: 520,
      rotation: 0,
      opacity: 1,
      fill: "#f4f1e8",
      stroke: "#8a6d3b",
      strokeWidth: 2,
    });
    elements.push(
      text(
        "heading",
        ORIGIN.x,
        ORIGIN.y,
        500,
        40,
        { fontFamily: "serif", fontWeight: 700 },
        "Galatsa – første stopp",
      ),
      text(
        "body",
        ORIGIN.x,
        ORIGIN.y + 70,
        500,
        16,
        {},
        "Kameraet flyr over et uendelig lerret. Teksten skal være skarp ved hver zoom: æ ø å é ü. The quick brown fox jumps over the lazy dog 0123456789.",
      ),
      text(
        "fine",
        ORIGIN.x,
        ORIGIN.y + 200,
        500,
        3,
        { fontFamily: "monospace", color: "#444444" },
        "Fine print at three world units: readable only when zoomed in. Liten skrift – les meg med zoom 8 eller mer. ".repeat(
          4,
        ),
      ),
    );
  } else {
    elements.push(
      text("glyph", ORIGIN.x, ORIGIN.y, 40, 12, { lineHeight: 1, color: "#000000" }, "H"),
      {
        kind: "shape",
        id: "rect",
        shape: "rect",
        x: ORIGIN.x + 100,
        y: ORIGIN.y,
        width: 100,
        height: 100,
        rotation: 0,
        opacity: 1,
        fill: "#000000",
        stroke: null,
        strokeWidth: 0,
      },
    );
  }
  return {
    version: 0,
    seed: 0,
    bounds: { x: ORIGIN.x - 100, y: ORIGIN.y - 100, width: 700, height: 520 },
    clusters: [],
    elements,
    assets: [],
  };
}

function start(): void {
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.style.position = "relative";
  stage.style.overflow = "hidden";
  stage.style.width = `${VIEWPORT.width}px`;
  stage.style.height = `${VIEWPORT.height}px`;
  document.body.append(stage);

  let engine: DomEngine | undefined;
  let camera: CameraPose = { x: ORIGIN.x, y: ORIGIN.y, zoom: 1 };
  let animation:
    | {
        from: CameraPose;
        to: CameraPose;
        frames: number;
        frame: number;
        done: () => void;
      }
    | undefined;
  let wobble = false;
  let wobbleSign = 1;
  let frameWaiters: { at: number; resolve: () => void }[] = [];
  let sharpWaiters: (() => void)[] = [];
  let frame = 0;

  const loop = () => {
    frame++;
    let pose = camera;
    if (animation !== undefined) {
      const a = animation;
      a.frame++;
      const t = Math.min(1, a.frame / a.frames);
      const zoom = a.from.zoom * (a.to.zoom / a.from.zoom) ** t;
      pose = {
        x: a.from.x + (a.to.x - a.from.x) * t,
        y: a.from.y + (a.to.y - a.from.y) * t,
        zoom,
      };
      camera = pose;
      if (t >= 1) {
        camera = a.to;
        animation = undefined;
        a.done();
      }
    } else if (wobble) {
      wobbleSign = -wobbleSign;
      pose = { ...camera, x: camera.x + (wobbleSign * 1e-6) / camera.zoom };
    }
    engine?.render(pose);
    const due = frameWaiters.filter((w) => w.at <= frame);
    frameWaiters = frameWaiters.filter((w) => w.at > frame);
    for (const w of due) w.resolve();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  stage.addEventListener("dblclick", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const id = target?.dataset["id"];
    if (id !== undefined) engine?.beginEdit(id);
  });

  const api: LabApi = {
    async init(variant, sceneKind) {
      engine?.dispose();
      stage.replaceChildren();
      const options = VARIANTS.find((v) => v.name === variant);
      if (options === undefined) throw new Error(`Unknown variant ${variant}`);
      engine = createDomEngine({ ...options, awaitFirstImages: false });
      const scene = labScene(sceneKind);
      await engine.load({
        container: stage,
        viewport: { ...VIEWPORT, devicePixelRatio: window.devicePixelRatio },
        scene,
        images: {
          getBlob: () => {
            throw new Error("The lab scenes have no images");
          },
        },
        reportTextSharp: () => {
          const waiters = sharpWaiters;
          sharpWaiters = [];
          for (const w of waiters) w();
        },
      });
    },
    setCamera(pose) {
      animation = undefined;
      wobble = false;
      camera = pose;
    },
    frames(n) {
      return new Promise((resolve) => frameWaiters.push({ at: frame + n, resolve }));
    },
    play(to, frames, keepMoving) {
      wobble = false;
      return new Promise((resolve) => {
        animation = {
          from: camera,
          to,
          frames,
          frame: 0,
          done: () => {
            wobble = keepMoving;
            resolve();
          },
        };
      });
    },
    stop() {
      animation = undefined;
      wobble = false;
    },
    waitSharp(timeoutMs) {
      const start = performance.now();
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        sharpWaiters.push(() => {
          clearTimeout(timer);
          resolve(performance.now() - start);
        });
      });
    },
    beginEdit(id) {
      return engine?.beginEdit(id) !== undefined;
    },
    endEdit() {
      engine?.endEdit();
    },
    textOf(id) {
      return engine?.textOf(id);
    },
    stats() {
      return engine?.stats() ?? {};
    },
    async findEdge(png, y, x0, x1) {
      const image = await decodePng(png);
      const row = image.data.subarray(4 * y * image.width, 4 * (y + 1) * image.width);
      const darkness = (x: number) =>
        1 - (row[4 * x]! + row[4 * x + 1]! + row[4 * x + 2]!) / (3 * 255);
      for (let x = Math.max(1, x0); x < Math.min(x1, image.width); x++) {
        const d = darkness(x);
        if (d >= 0.5) {
          const p = darkness(x - 1);
          // Pixel centres are at x + 0.5; interpolate where darkness crosses 0.5.
          return x - 1 + 0.5 + (0.5 - p) / (d - p);
        }
      }
      return null;
    },
    async sharpness(png) {
      const { data, width, height } = await decodePng(png);
      const lum = (i: number) => (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      let sum = 0;
      let count = 0;
      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
          const i = 4 * (y * width + x);
          const v = lum(i);
          sum += Math.abs(v - lum(i + 4)) + Math.abs(v - lum(i + 4 * width));
          count += 2;
        }
      }
      return sum / count;
    },
  };
  window.protoLab = api;
  document.body.dataset["ready"] = "true";
}

start();
