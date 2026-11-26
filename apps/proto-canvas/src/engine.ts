// SPDX-License-Identifier: GPL-3.0-or-later

// Prototype engine B: the whole scene is drawn on one 2D canvas by our own code.
//
// - Culling: a uniform grid over the elements' rotated bounding boxes; elements
//   smaller than half a device pixel are skipped.
// - Shapes and images: one canvas transform per element (rotation and scale), built
//   in double precision relative to the camera, so that local coordinates stay small.
// - Text: laid out once in world units (text-layout.ts); drawn line by line with
//   fillText at the font size in device pixels, under a transform without scale, so
//   glyphs are rasterised at screen resolution in every frame. Text smaller than a
//   few device pixels is drawn as grey bars ("greeking"). Lines outside the view are
//   skipped.
// - Images: decoded at reduced size (image-cache.ts).
// - Editing: editor.ts; the engine draws the selection, composition and caret.
//
// No WebGL (see docs/adr/0002 on WebGL in WebKitGTK), no worker, no OffscreenCanvas.

import type {
  BenchEngine,
  BenchViewport,
  CameraPose,
  EngineSetup,
  ImageElement,
  SceneElement,
  ShapeElement,
  TextElement,
} from "@galatsa/bench";
import { type EditHost, type EditState, TextEditor } from "./editor.ts";
import { ImageCache, type ImageCacheStats } from "./image-cache.ts";
import { GridIndex } from "./spatial.ts";
import {
  applyTextRendering,
  caretX,
  fontString,
  layoutText,
  lineIndexOf,
  Measurer,
  offsetAtPoint,
  type TextLayout,
} from "./text-layout.ts";

/** Text whose font is smaller than this many device pixels is drawn as bars. */
export const GREEK_BELOW_DEVICE_PX = 4;
/** Elements smaller than this many device pixels are not drawn. */
const SKIP_BELOW_DEVICE_PX = 0.5;
const GRID_CELL = 1200;
/** Decoded image levels (other than thumbnails) kept, in bytes. */
const IMAGE_BUDGET_BYTES = 384 * 1024 * 1024;

interface Item {
  readonly el: SceneElement;
  readonly index: number;
  readonly cx: number;
  readonly cy: number;
  readonly cos: number;
  readonly sin: number;
  layout: TextLayout | undefined;
}

export interface EngineStats {
  frames: number;
  loadLayoutMs: number;
  loadThumbnailsMs: number;
  measureCalls: number;
  maxVisible: number;
  /** Per-frame maxima. */
  maxFillTextCalls: number;
  maxGreekedTexts: number;
  maxImagesDrawn: number;
  /** Frames where some visible image was drawn from a coarser or finer level than wanted. */
  images: ImageCacheStats | null;
}

export interface CanvasEngineOptions {
  /** Called when something changes outside render() (a decode finished, an edit). */
  readonly onInvalidate?: () => void;
}

export interface CanvasEngine extends BenchEngine {
  readonly stats: EngineStats;
  readonly editor: TextEditor | null;
  /** The text under a point (CSS pixels in the container), and the caret offset there. */
  hitTestText(x: number, y: number): { id: string; offset: number } | null;
  beginEdit(id: string, offset?: number): TextEditor;
  endEdit(): void;
  editState(): EditState | null;
  textElement(id: string): TextElement | undefined;
  /** The current text of a text element (after edits). */
  textOf(id: string): string | undefined;
  /** CSS pixels in the container for a caret offset of a text (middle of the line). */
  caretScreenPoint(id: string, offset: number): { x: number; y: number } | null;
  /** True while image decodes are running or waiting. */
  imagesBusy(): boolean;
}

export function createCanvasEngine(options: CanvasEngineOptions = {}): CanvasEngine {
  let canvas: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | undefined;
  let container: HTMLElement | undefined;
  let viewport: BenchViewport = { width: 0, height: 0, devicePixelRatio: 1 };
  let items: Item[] = [];
  const byId = new Map<string, Item>();
  let boxes = new Float64Array(0);
  let grid: GridIndex | undefined;
  let images: ImageCache | undefined;
  let measurer: Measurer | undefined;
  let reportTextSharp = (): void => {};
  let camera: CameraPose = { x: 0, y: 0, zoom: 1 };
  let editor: TextEditor | null = null;
  let currentFont = "";
  const invalidate = () => options.onInvalidate?.();

  const stats: EngineStats = {
    frames: 0,
    loadLayoutMs: 0,
    loadThumbnailsMs: 0,
    measureCalls: 0,
    maxVisible: 0,
    maxFillTextCalls: 0,
    maxGreekedTexts: 0,
    maxImagesDrawn: 0,
    images: null,
  };

  /** Writes the rotated bounding box of an item into `boxes`. */
  function updateBox(item: Item): void {
    const e = item.el;
    let pad = 0;
    let bottom = e.height / 2;
    if (e.kind === "shape" && e.stroke !== null) pad = e.strokeWidth / 2;
    if (item.layout !== undefined)
      bottom = Math.max(bottom, -e.height / 2 + item.layout.height);
    const xs = [-e.width / 2 - pad, e.width / 2 + pad];
    const ys = [-e.height / 2 - pad, bottom + pad];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const lx of xs) {
      for (const ly of ys) {
        const wx = item.cx + lx * item.cos - ly * item.sin;
        const wy = item.cy + lx * item.sin + ly * item.cos;
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
      }
    }
    boxes.set([minX, minY, maxX, maxY], item.index * 4);
  }

  function layoutOf(item: Item, text: string): TextLayout {
    const e = item.el as TextElement;
    return layoutText(
      measurer!,
      text,
      { family: e.fontFamily, weight: e.fontWeight },
      e.fontSize,
      e.width,
      e.lineHeight,
      e.align,
    );
  }

  function setFont(font: string): void {
    if (font !== currentFont) {
      ctx!.font = font;
      currentFont = font;
    }
  }

  // Per-frame transform helpers. Screen (device px) position of a world point:
  // ((w - camera) * zoom + viewport / 2) * dpr, computed in double precision.
  function deviceX(wx: number): number {
    return (
      ((wx - camera.x) * camera.zoom + viewport.width / 2) * viewport.devicePixelRatio
    );
  }
  function deviceY(wy: number): number {
    return (
      ((wy - camera.y) * camera.zoom + viewport.height / 2) * viewport.devicePixelRatio
    );
  }

  function drawShape(item: Item, e: ShapeElement, s: number): void {
    const c = ctx!;
    c.setTransform(
      item.cos * s,
      item.sin * s,
      -item.sin * s,
      item.cos * s,
      deviceX(item.cx),
      deviceY(item.cy),
    );
    const hw = e.width / 2;
    const hh = e.height / 2;
    c.beginPath();
    switch (e.shape) {
      case "rect":
        c.rect(-hw, -hh, e.width, e.height);
        break;
      case "ellipse":
        c.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
        break;
      case "triangle":
        c.moveTo(0, -hh);
        c.lineTo(hw, hh);
        c.lineTo(-hw, hh);
        c.closePath();
        break;
      case "line":
        c.moveTo(-hw, -hh);
        c.lineTo(hw, hh);
        break;
    }
    if (e.fill !== null) {
      c.fillStyle = e.fill;
      c.fill();
    }
    if (e.stroke !== null) {
      c.strokeStyle = e.stroke;
      c.lineWidth = e.strokeWidth;
      c.stroke();
    }
  }

  function drawImage(item: Item, e: ImageElement, s: number): void {
    const c = ctx!;
    const bitmap = images?.pick(e.assetId, e.width * s) ?? null;
    c.setTransform(
      item.cos * s,
      item.sin * s,
      -item.sin * s,
      item.cos * s,
      deviceX(item.cx),
      deviceY(item.cy),
    );
    if (bitmap === null) {
      c.fillStyle = "#d8d8d8";
      c.fillRect(-e.width / 2, -e.height / 2, e.width, e.height);
    } else {
      c.drawImage(bitmap, -e.width / 2, -e.height / 2, e.width, e.height);
    }
  }

  /** Returns the number of fillText calls, or -1 if the text was greeked. */
  function drawText(item: Item, e: TextElement, s: number): number {
    const c = ctx!;
    const layout = item.layout!;
    const lines = layout.lines;
    const fontPx = e.fontSize * s;
    const editing = editor !== null && editor.id === e.id;
    const tx = deviceX(item.cx);
    const ty = deviceY(item.cy);
    if (fontPx < GREEK_BELOW_DEVICE_PX && !editing) {
      c.setTransform(item.cos * s, item.sin * s, -item.sin * s, item.cos * s, tx, ty);
      c.fillStyle = e.color;
      const left = -e.width / 2;
      const top = -e.height / 2;
      if (layout.lineHeight * s < 2) {
        // Lines closer than two device pixels: one block of average ink.
        c.globalAlpha = e.opacity * 0.2;
        const x =
          e.align === "left"
            ? 0
            : e.align === "center"
              ? (e.width - layout.maxLineWidth) / 2
              : e.width - layout.maxLineWidth;
        c.fillRect(left + x, top, layout.maxLineWidth, layout.height);
      } else {
        c.globalAlpha = e.opacity * 0.35;
        const lh = layout.lineHeight;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          c.fillRect(left + line.x, top + i * lh + lh * 0.3, line.width, lh * 0.4);
        }
      }
      return -1;
    }
    // Device-pixel frame, rotated but not scaled: local (u, v) -> screen.
    c.setTransform(item.cos, item.sin, -item.sin, item.cos, tx, ty);
    const left = (-e.width / 2) * s;
    const top = (-e.height / 2) * s;
    const lh = layout.lineHeight * s;
    // Visible range of v: the viewport corners in the local frame.
    let vMin = Infinity;
    let vMax = -Infinity;
    const W = viewport.width * viewport.devicePixelRatio;
    const H = viewport.height * viewport.devicePixelRatio;
    for (const [px, py] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ] as const) {
      const v = -(px - tx) * item.sin + (py - ty) * item.cos;
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    const first = Math.max(0, Math.floor((vMin - top) / lh));
    const last = Math.min(lines.length - 1, Math.floor((vMax - top) / lh));
    if (editing) drawSelection(layout, s, left, top, first, last);
    setFont(fontString(layout.font, fontPx));
    c.fillStyle = e.color;
    const baseline = layout.baseline * s;
    let calls = 0;
    for (let i = first; i <= last; i++) {
      const line = lines[i]!;
      if (line.width === 0) continue;
      c.fillText(line.text, left + line.x * s, top + i * lh + baseline);
      calls++;
    }
    if (editing) drawCaret(layout, s, left, top, e.color);
    return calls;
  }

  /** Fills `[from, to)` on every line in `first..last` with the current fill style. */
  function fillRange(
    layout: TextLayout,
    s: number,
    left: number,
    top: number,
    first: number,
    last: number,
    from: number,
    to: number,
    y0: number,
    y1: number,
  ): void {
    const c = ctx!;
    const lh = layout.lineHeight * s;
    for (let i = first; i <= last; i++) {
      const line = layout.lines[i]!;
      const nextStart = layout.lines[i + 1]?.start ?? layout.text.length + 1;
      if (to <= line.start || from >= nextStart) continue;
      const a = caretX(measurer!, layout, i, Math.max(from, line.start)) * s;
      // A selection that runs past the end of the line shows a little extra.
      const past = to > line.end;
      const b =
        caretX(measurer!, layout, i, Math.min(to, line.end)) * s +
        (past ? layout.fontSize * 0.3 * s : 0);
      c.fillRect(left + a, top + i * lh + y0 * lh, Math.max(b - a, 0), (y1 - y0) * lh);
    }
  }

  function drawSelection(
    layout: TextLayout,
    s: number,
    left: number,
    top: number,
    first: number,
    last: number,
  ): void {
    const state = editor!.state();
    if (state.selectionStart === state.selectionEnd || editor!.composing !== null) return;
    const c = ctx!;
    c.save();
    c.globalAlpha = 1;
    c.fillStyle = state.focused ? "rgba(51, 120, 255, 0.35)" : "rgba(128, 128, 128, 0.3)";
    fillRange(
      layout,
      s,
      left,
      top,
      first,
      last,
      state.selectionStart,
      state.selectionEnd,
      0,
      1,
    );
    c.restore();
  }

  function drawCaret(
    layout: TextLayout,
    s: number,
    left: number,
    top: number,
    color: string,
  ): void {
    const c = ctx!;
    const ed = editor!;
    const lh = layout.lineHeight * s;
    const composition = ed.composing;
    c.save();
    c.globalAlpha = 1;
    if (composition !== null && composition.end > composition.start) {
      c.fillStyle = color;
      const thickness = Math.max(1, layout.fontSize * s * 0.06);
      const y = (layout.baseline * s + thickness * 1.5) / lh;
      fillRange(
        layout,
        s,
        left,
        top,
        0,
        layout.lines.length - 1,
        composition.start,
        composition.end,
        y,
        y + thickness / lh,
      );
    }
    const state = ed.state();
    if (state.selectionStart === state.selectionEnd || composition !== null) {
      if (ed.caretVisible(performance.now())) {
        const offset =
          state.direction === "backward" ? state.selectionStart : state.selectionEnd;
        const index = lineIndexOf(layout, offset);
        const x = caretX(measurer!, layout, index, offset) * s;
        const width = Math.max(
          1,
          Math.min(4 * viewport.devicePixelRatio, layout.fontSize * s * 0.07),
        );
        c.fillStyle = "#000";
        c.fillRect(left + x - width / 2, top + index * lh, width, lh);
      }
    }
    c.restore();
  }

  function itemAt(
    x: number,
    y: number,
    pick: (item: Item) => boolean,
  ): { item: Item; bx: number; by: number } | null {
    // Screen (CSS px) to world.
    const wx = (x - viewport.width / 2) / camera.zoom + camera.x;
    const wy = (y - viewport.height / 2) / camera.zoom + camera.y;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (!pick(item)) continue;
      const b = item.index * 4;
      if (
        wx < boxes[b]! ||
        wx > boxes[b + 2]! ||
        wy < boxes[b + 1]! ||
        wy > boxes[b + 3]!
      )
        continue;
      const e = item.el;
      // World to box coordinates (from the unrotated box's top-left).
      const dx = wx - item.cx;
      const dy = wy - item.cy;
      const bx = dx * item.cos + dy * item.sin + e.width / 2;
      const by = -dx * item.sin + dy * item.cos + e.height / 2;
      const height = Math.max(e.height, item.layout?.height ?? 0);
      if (bx >= 0 && bx <= e.width && by >= 0 && by <= height) return { item, bx, by };
    }
    return null;
  }

  function boxToScreen(id: string, bx: number, by: number): { x: number; y: number } {
    const item = byId.get(id)!;
    const lx = bx - item.el.width / 2;
    const ly = by - item.el.height / 2;
    const wx = item.cx + lx * item.cos - ly * item.sin;
    const wy = item.cy + lx * item.sin + ly * item.cos;
    return {
      x: (wx - camera.x) * camera.zoom + viewport.width / 2,
      y: (wy - camera.y) * camera.zoom + viewport.height / 2,
    };
  }

  const editHost: EditHost = {
    get container() {
      return container!;
    },
    get measurer() {
      return measurer!;
    },
    layoutOf: (id) => byId.get(id)!.layout!,
    setText(id, text) {
      const item = byId.get(id)!;
      item.layout = layoutOf(item, text);
      updateBox(item);
    },
    boxToScreen,
    zoom: () => camera.zoom,
    invalidate,
    requestExit: () => engine.endEdit(),
  };

  const engine: CanvasEngine = {
    name: "canvas2d",
    stats,
    get editor() {
      return editor;
    },

    async load(setup: EngineSetup) {
      viewport = setup.viewport;
      container = setup.container;
      reportTextSharp = setup.reportTextSharp;
      const dpr = viewport.devicePixelRatio;
      canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.style.display = "block";
      setup.container.append(canvas);
      const context = canvas.getContext("2d", { alpha: false });
      if (context === null) throw new Error("No 2D canvas context");
      ctx = context;
      applyTextRendering(ctx);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";

      const t0 = performance.now();
      measurer = new Measurer();
      items = setup.scene.elements.map((el, index) => {
        const angle = (el.rotation * Math.PI) / 180;
        return {
          el,
          index,
          cx: el.x + el.width / 2,
          cy: el.y + el.height / 2,
          cos: Math.cos(angle),
          sin: Math.sin(angle),
          layout: undefined,
        };
      });
      boxes = new Float64Array(items.length * 4);
      for (const item of items) {
        byId.set(item.el.id, item);
        if (item.el.kind === "text") item.layout = layoutOf(item, item.el.text);
        updateBox(item);
      }
      grid = new GridIndex(boxes, GRID_CELL);
      stats.loadLayoutMs = performance.now() - t0;
      stats.measureCalls = measurer.calls;

      images = new ImageCache(setup.images, setup.scene.assets, {
        budgetBytes: IMAGE_BUDGET_BYTES,
        maxInFlight: 2,
        onDecoded: invalidate,
      });
      stats.images = images.stats;
      const t1 = performance.now();
      await images.loadThumbnails(4);
      stats.loadThumbnailsMs = performance.now() - t1;
    },

    render(pose: CameraPose) {
      if (ctx === undefined || grid === undefined) return;
      camera = pose;
      const c = ctx;
      const dpr = viewport.devicePixelRatio;
      const s = camera.zoom * dpr;
      stats.frames++;
      images?.beginFrame();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, c.canvas.width, c.canvas.height);

      const halfW = viewport.width / 2 / camera.zoom;
      const halfH = viewport.height / 2 / camera.zoom;
      const visible = grid.query(
        camera.x - halfW,
        camera.y - halfH,
        camera.x + halfW,
        camera.y + halfH,
      );
      let order: ArrayLike<number> = visible;
      if (editor !== null) {
        // The edited text may have grown past the box the grid knows; always draw it.
        const index = byId.get(editor.id)!.index;
        if (!visible.includes(index)) order = Int32Array.from([...visible, index]).sort();
      }
      let fillTextCalls = 0;
      let greeked = 0;
      let imagesDrawn = 0;
      for (let k = 0; k < order.length; k++) {
        const item = items[order[k]!]!;
        const e = item.el;
        if (
          Math.max(e.width, e.height) * s < SKIP_BELOW_DEVICE_PX &&
          item !== (editor && byId.get(editor.id))
        )
          continue;
        c.globalAlpha = e.opacity;
        if (e.kind === "shape") {
          drawShape(item, e, s);
        } else if (e.kind === "image") {
          drawImage(item, e, s);
          imagesDrawn++;
        } else {
          const calls = drawText(item, e, s);
          if (calls < 0) greeked++;
          else fillTextCalls += calls;
        }
      }
      images?.endFrame();
      editor?.placeInput();
      stats.maxVisible = Math.max(stats.maxVisible, order.length);
      stats.maxFillTextCalls = Math.max(stats.maxFillTextCalls, fillTextCalls);
      stats.maxGreekedTexts = Math.max(stats.maxGreekedTexts, greeked);
      stats.maxImagesDrawn = Math.max(stats.maxImagesDrawn, imagesDrawn);
      stats.measureCalls = measurer?.calls ?? 0;
      // Every text at or above the greeking size was just drawn with fillText at its
      // font size in device pixels, so text is sharp in every frame.
      reportTextSharp();
    },

    hitTestText(x, y) {
      const hit = itemAt(x, y, (item) => item.el.kind === "text");
      if (hit === null) return null;
      return {
        id: hit.item.el.id,
        offset: offsetAtPoint(measurer!, hit.item.layout!, hit.bx, hit.by),
      };
    },

    beginEdit(id, offset) {
      const item = byId.get(id);
      if (item === undefined || item.layout === undefined)
        throw new Error(`No text ${id}`);
      engine.endEdit();
      editor = new TextEditor(editHost, id, offset ?? item.layout.text.length);
      invalidate();
      return editor;
    },

    endEdit() {
      if (editor === null) return;
      editor.dispose();
      editor = null;
      // The text may have grown or shrunk: rebuild the index.
      grid = new GridIndex(boxes, GRID_CELL);
      invalidate();
    },

    editState: () => editor?.state() ?? null,

    textElement(id) {
      const item = byId.get(id);
      return item?.el.kind === "text" ? item.el : undefined;
    },

    textOf: (id) => byId.get(id)?.layout?.text,

    caretScreenPoint(id, offset) {
      const item = byId.get(id);
      if (item?.layout === undefined) return null;
      const index = lineIndexOf(item.layout, offset);
      return boxToScreen(
        id,
        caretX(measurer!, item.layout, index, offset),
        (index + 0.5) * item.layout.lineHeight,
      );
    },

    imagesBusy: () => images?.busy ?? false,

    dispose() {
      editor?.dispose();
      editor = null;
      images?.dispose();
      images = undefined;
      canvas?.remove();
      if (canvas !== undefined) canvas.width = 0;
      canvas = undefined;
      ctx = undefined;
      items = [];
      byId.clear();
      grid = undefined;
      reportTextSharp = () => {};
    },
  };
  return engine;
}
