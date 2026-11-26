// SPDX-License-Identifier: GPL-3.0-or-later

// An interactive page for the engine: wheel to zoom, drag to pan, double-click a text
// to edit it, Escape or a click outside to stop. Renders on demand. Scripts (the
// Playwright tests) drive it through window.protoCanvas.
//
// Query parameters: width, height (CSS px, default 1280 x 720); images=1 to generate
// the bench images (takes a while; by default images are grey boxes); x, y, zoom for
// the first camera.

import {
  type CameraPose,
  generateScene,
  type ImageSource,
  prepareImages,
  type Scene,
} from "@galatsa/bench";
import { type CanvasEngine, createCanvasEngine } from "./engine.ts";

const STRINGS = {
  title: "Galatsa canvas prototype",
  help: "Wheel: zoom. Drag: pan. Double-click a text: edit. Escape: stop editing.",
  generating: (done: number, total: number) => `Generating images ${done}/${total}…`,
};

export interface DemoApi {
  readonly engine: CanvasEngine;
  readonly scene: Scene;
  readonly ready: Promise<void>;
  camera: CameraPose;
  /** Sets the camera and draws at once. */
  setCamera(pose: CameraPose): void;
  /** Draws now. */
  draw(): void;
  /** Number of frames drawn so far. */
  readonly frames: number;
}

declare global {
  interface Window {
    protoCanvas?: DemoApi;
  }
}

function number(params: URLSearchParams, name: string, fallback: number): number {
  const v = Number(params.get(name));
  return params.has(name) && Number.isFinite(v) ? v : fallback;
}

const params = new URLSearchParams(location.search);
const width = number(params, "width", 1280);
const height = number(params, "height", 720);
const help = document.getElementById("help")!;
const stage = document.getElementById("stage")!;
document.title = STRINGS.title;
help.textContent = STRINGS.help;
stage.style.width = `${width}px`;
stage.style.height = `${height}px`;

const scene = generateScene();
let camera: CameraPose = {
  x: number(params, "x", scene.bounds.width / 2),
  y: number(params, "y", scene.bounds.height / 2),
  zoom: number(params, "zoom", 0.02),
};
let frames = 0;
let scheduled = false;
let loaded = false;

const draw = () => {
  scheduled = false;
  if (!loaded) return;
  engine.render(camera);
  frames++;
};
const invalidate = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(draw);
};

const engine = createCanvasEngine({ onInvalidate: invalidate });

// Without images=1 the engine gets no image files and draws grey boxes.
const noImages: ImageSource = {
  getBlob: () => {
    throw new Error("Images are off on this page (add ?images=1)");
  },
};

async function start(): Promise<void> {
  let images: ImageSource = noImages;
  if (params.get("images") === "1") {
    images = await prepareImages(scene, (done, total) => {
      help.textContent = STRINGS.generating(done, total);
    });
    help.textContent = STRINGS.help;
  }
  await engine.load({
    container: stage,
    viewport: { width, height, devicePixelRatio: window.devicePixelRatio || 1 },
    scene,
    images,
    reportTextSharp: () => {},
  });
  loaded = true;
  draw();
}

const ready = start();

// Caret blinking.
setInterval(() => {
  if (engine.editor !== null) invalidate();
}, 265);

function local(e: MouseEvent): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = local(e);
    const factor = Math.exp(-e.deltaY * 0.002);
    const zoom = Math.min(400, Math.max(0.005, camera.zoom * factor));
    // Keep the world point under the pointer in place.
    const wx = (p.x - width / 2) / camera.zoom + camera.x;
    const wy = (p.y - height / 2) / camera.zoom + camera.y;
    camera = {
      x: wx - (p.x - width / 2) / zoom,
      y: wy - (p.y - height / 2) / zoom,
      zoom,
    };
    invalidate();
  },
  { passive: false },
);

let drag: { mode: "pan" | "select"; x: number; y: number; camera: CameraPose } | null =
  null;

stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const p = local(e);
  const editor = engine.editor;
  if (editor !== null) {
    const hit = engine.hitTestText(p.x, p.y);
    if (hit !== null && hit.id === editor.id) {
      // Keep the focus in the hidden textarea.
      e.preventDefault();
      if (e.detail === 2) editor.selectWordAt(hit.offset);
      else if (e.shiftKey) editor.extendTo(hit.offset);
      else editor.setSelection(hit.offset, hit.offset);
      drag = { mode: "select", x: p.x, y: p.y, camera };
      stage.setPointerCapture(e.pointerId);
      return;
    }
    engine.endEdit();
  }
  drag = { mode: "pan", x: p.x, y: p.y, camera };
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
  if (drag === null) return;
  const p = local(e);
  if (drag.mode === "pan") {
    camera = {
      x: drag.camera.x - (p.x - drag.x) / camera.zoom,
      y: drag.camera.y - (p.y - drag.y) / camera.zoom,
      zoom: camera.zoom,
    };
    invalidate();
  } else {
    const editor = engine.editor;
    const hit = engine.hitTestText(p.x, p.y);
    if (editor !== null && hit !== null && hit.id === editor.id)
      editor.extendTo(hit.offset);
  }
});

const endDrag = () => {
  drag = null;
};
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

stage.addEventListener("dblclick", (e) => {
  if (engine.editor !== null) return;
  const p = local(e);
  const hit = engine.hitTestText(p.x, p.y);
  if (hit !== null) engine.beginEdit(hit.id, hit.offset);
});

window.protoCanvas = {
  engine,
  scene,
  ready,
  get camera() {
    return camera;
  },
  set camera(pose: CameraPose) {
    camera = pose;
    invalidate();
  },
  setCamera(pose) {
    camera = pose;
    draw();
  },
  draw,
  get frames() {
    return frames;
  },
};
