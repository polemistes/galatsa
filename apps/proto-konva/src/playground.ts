// SPDX-License-Identifier: GPL-3.0-or-later

// A page to look at and edit the benchmark scene with the Konva engine: drag to
// pan, wheel to zoom, double-click a text box to edit it. Tests drive it through
// window.protoKonva.
//
// Query parameters:
//   x, y, zoom     initial camera (default: the whole scene)
//   edit           "screen" (default) or "scaled": how the edit overlay is sized
//   images         "fast" (default: small placeholder files, quick to make) or
//                  "full" (the benchmark's real 2 to 12 megapixel files, slow)
//   width, height  stage size in CSS pixels (default 1280 x 720)

import {
  type CameraPose,
  createCameraRun,
  type ImageSource,
  generateScene,
  prepareImages,
  type Scene,
} from "@galatsa/bench";
import { createKonvaEngine, type KonvaEngine } from "./engine.ts";
import type { EditMode } from "./text-editor.ts";

export interface PlaygroundApi {
  readonly ready: Promise<void>;
  readonly engine: KonvaEngine;
  readonly scene: Scene;
  /** Id of the text box the benchmark's camera run zooms in on. */
  readonly zoomTargetId: string;
  /** Moves the camera; resolves after the frame for it has been drawn twice (moving, then still). */
  setCamera(pose: CameraPose): Promise<void>;
  camera(): CameraPose;
  /** Resolves after the next animation frame has been rendered. */
  nextFrame(): Promise<void>;
  /** Client coordinates of a world point. */
  toClient(wx: number, wy: number): { x: number; y: number };
}

declare global {
  interface Window {
    protoKonva?: PlaygroundApi;
  }
}

/** Small JPEG files with the assets' aspect ratios, in place of the real ones. */
async function placeholderImages(scene: Scene): Promise<ImageSource> {
  const blobs = new Map<string, Blob>();
  for (const asset of scene.assets) {
    const w = 96;
    const h = Math.max(1, Math.round((w * asset.height) / asset.width));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("No 2D canvas context");
    const hue = asset.seed % 360;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, `hsl(${hue} 60% 70%)`);
    gradient.addColorStop(1, `hsl(${(hue + 120) % 360} 60% 40%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    blobs.set(asset.id, await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
  }
  return {
    getBlob(id) {
      const blob = blobs.get(id);
      if (blob === undefined) throw new Error(`Unknown image asset ${id}`);
      return blob;
    },
  };
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) ? value : fallback;
}

const params = new URLSearchParams(location.search);
const viewport = {
  width: numberParam(params, "width", 1280),
  height: numberParam(params, "height", 720),
  devicePixelRatio: window.devicePixelRatio || 1,
};
const scene = generateScene();
let camera: CameraPose = {
  x: numberParam(params, "x", scene.bounds.x + scene.bounds.width / 2),
  y: numberParam(params, "y", scene.bounds.y + scene.bounds.height / 2),
  zoom: numberParam(params, "zoom", 0.02),
};
const editMode: EditMode = params.get("edit") === "scaled" ? "scaled" : "screen";
const engine = createKonvaEngine({ editMode });

const stage = document.createElement("div");
stage.className = "stage";
Object.assign(stage.style, {
  position: "relative",
  overflow: "hidden",
  width: `${viewport.width}px`,
  height: `${viewport.height}px`,
});
(document.getElementById("app") ?? document.body).append(stage);

const frameWaiters: (() => void)[] = [];
function loop() {
  engine.render(camera);
  for (const resolve of frameWaiters.splice(0)) resolve();
  requestAnimationFrame(loop);
}
const nextFrame = () => new Promise<void>((resolve) => frameWaiters.push(resolve));

const ready = (async () => {
  const images =
    params.get("images") === "full"
      ? await prepareImages(scene)
      : await placeholderImages(scene);
  await engine.load({
    container: stage,
    viewport,
    scene,
    images,
    reportTextSharp: () => {},
  });
  requestAnimationFrame(loop);
  await nextFrame();
  stage.dataset["ready"] = "true";
})();

// Pan by dragging, zoom with the wheel around the pointer, double-click to edit.
let drag: { x: number; y: number } | undefined;
stage.addEventListener("pointerdown", (event) => {
  if (event.target instanceof HTMLTextAreaElement) return;
  drag = { x: event.clientX, y: event.clientY };
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
  if (drag === undefined) return;
  camera = {
    ...camera,
    x: camera.x - (event.clientX - drag.x) / camera.zoom,
    y: camera.y - (event.clientY - drag.y) / camera.zoom,
  };
  drag = { x: event.clientX, y: event.clientY };
});
stage.addEventListener("pointerup", () => {
  drag = undefined;
});
stage.addEventListener(
  "wheel",
  (event) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const sx = event.clientX - rect.left - viewport.width / 2;
    const sy = event.clientY - rect.top - viewport.height / 2;
    const factor = Math.exp(-event.deltaY * 0.002);
    const zoom = camera.zoom * factor;
    camera = {
      x: camera.x + sx / camera.zoom - sx / zoom,
      y: camera.y + sy / camera.zoom - sy / zoom,
      zoom,
    };
  },
  { passive: false },
);
stage.addEventListener("dblclick", (event) => {
  if (event.target instanceof HTMLTextAreaElement) return;
  const rect = stage.getBoundingClientRect();
  const id = engine.textAt(event.clientX - rect.left, event.clientY - rect.top);
  if (id !== undefined) engine.beginEdit(id);
});

// The first segment of the camera run is labelled "zoom in on <id>".
const zoomTargetId = createCameraRun(scene).segments[0]!.label.split(" ").pop()!;

window.protoKonva = {
  ready,
  engine,
  scene,
  zoomTargetId,
  async setCamera(pose) {
    camera = pose;
    await nextFrame();
    await nextFrame();
  },
  camera: () => camera,
  nextFrame,
  toClient(wx, wy) {
    const rect = stage.getBoundingClientRect();
    return {
      x: rect.left + (wx - camera.x) * camera.zoom + viewport.width / 2,
      y: rect.top + (wy - camera.y) * camera.zoom + viewport.height / 2,
    };
  },
};
