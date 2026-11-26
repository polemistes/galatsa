// SPDX-License-Identifier: GPL-3.0-or-later

// Prototype rendering engine on Konva (https://konvajs.org). One Konva node per scene
// element, all in one layer; the camera is the layer's position and scale. Konva
// composes each node's transform in JavaScript (float64) and hands the canvas only
// the final matrix, and every node draws in its own local coordinates.
//
// What the engine adds on top of Konva:
// - culling: each frame, nodes outside the view or smaller than half a device pixel
//   are hidden (Konva itself draws every visible node);
// - text level of detail: while the camera moves, text smaller than a few device
//   pixels is drawn as bars in place of its lines (layout from Konva's own wrapping).
//   On the first frame with a still camera everything is redrawn with glyphs down to
//   one device pixel, and only then is the text reported sharp;
// - image level of detail (image-lod.ts);
// - in-place editing with a textarea overlay (text-editor.ts).

import type {
  BenchEngine,
  BenchViewport,
  CameraPose,
  EngineSetup,
  SceneElement,
  TextElement,
} from "@galatsa/bench";
import Konva from "konva";
import { ImageLod, type ImageLodStats } from "./image-lod.ts";
import { type EditMode, TextEditor } from "./text-editor.ts";

type SceneContext = Parameters<Konva.Text["_sceneFunc"]>[0];

/** Text whose font is at least this many device pixels is drawn with glyphs while moving. */
export const MOVING_GLYPH_MIN_PX = 4;
/** ... and when the camera stands still. Smaller text is drawn as bars or a block. */
export const STILL_GLYPH_MIN_PX = 1;
/** Elements whose bounding box on screen is smaller than this (device pixels) are skipped. */
export const MIN_ELEMENT_PX = 0.5;
/** Below this line height (device pixels), a text box is drawn as one faint block. */
const BLOCK_LINE_PX = 1.5;

export interface KonvaEngineOptions {
  readonly editMode?: EditMode;
  readonly movingGlyphMinPx?: number;
  readonly stillGlyphMinPx?: number;
  readonly imageBudgetBytes?: number;
}

export interface EngineStats {
  readonly framesDrawn: number;
  readonly stillFramesDrawn: number;
  readonly framesSkipped: number;
  /** Most nodes drawn in one frame. */
  readonly maxVisibleNodes: number;
  /** Most text boxes drawn with glyphs in one frame. */
  readonly maxGlyphBoxes: number;
  readonly images: ImageLodStats | null;
  readonly pixelRatio: number;
}

export interface KonvaEngine extends BenchEngine {
  /** Id of the topmost text box at a point of the view (CSS pixels), if any. */
  textAt(x: number, y: number): string | undefined;
  /** Starts editing a text box in place. */
  beginEdit(id: string): void;
  /** Ends editing, keeping the text. */
  endEdit(): void;
  /** Current text of a text box. */
  textOf(id: string): string | undefined;
  /** The lines Konva wrapped a text box into, with their widths in world units. */
  textLines(id: string): { text: string; width: number }[];
  /** The textarea used for editing, once loaded. */
  readonly textarea: HTMLTextAreaElement | undefined;
  /** Draws again on the next render() even if nothing changed. */
  invalidate(): void;
  stats(): EngineStats;
}

interface Item {
  readonly element: SceneElement;
  readonly node: Konva.Shape;
  /** World bounding box of what the node draws, rotation and stroke included. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  visible: boolean;
}

/** Bounding box of the rectangle (x, y, w, h) rotated by `degrees` around (cx, cy). */
function rotatedBounds(
  x: number,
  y: number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  degrees: number,
  margin: number,
): [number, number, number, number] {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const) {
    const dx = px - cx;
    const dy = py - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

export function createKonvaEngine(options: KonvaEngineOptions = {}): KonvaEngine {
  const movingGlyphMin = options.movingGlyphMinPx ?? MOVING_GLYPH_MIN_PX;
  const stillGlyphMin = options.stillGlyphMinPx ?? STILL_GLYPH_MIN_PX;

  let stage: Konva.Stage | undefined;
  let layer: Konva.Layer | undefined;
  let images: ImageLod | undefined;
  /** Image statistics kept from dispose(), so they can be read after a run. */
  let finalImageStats: ImageLodStats | null = null;
  let editor: TextEditor | undefined;
  let viewport: BenchViewport = { width: 0, height: 0, devicePixelRatio: 1 };
  let reportTextSharp = (): void => {};
  let items: Item[] = [];
  const byId = new Map<string, Item>();

  let last: CameraPose | undefined;
  let dirty = true;
  /** The last drawn frame used still-camera quality for the current pose. */
  let sharp = false;

  // Read by the text scene function while a frame is drawn.
  const lod = { scale: 1, glyphMinPx: movingGlyphMin, glyphBoxes: 0 };
  const counters = {
    framesDrawn: 0,
    stillFramesDrawn: 0,
    framesSkipped: 0,
    maxVisibleNodes: 0,
    maxGlyphBoxes: 0,
  };

  function textScene(e: TextElement) {
    return (context: Konva.Context, shape: Konva.Shape) => {
      const text = shape as Konva.Text;
      const fontPx = e.fontSize * lod.scale;
      if (fontPx >= lod.glyphMinPx) {
        lod.glyphBoxes++;
        Konva.Text.prototype._sceneFunc.call(text, context as SceneContext);
        return;
      }
      const ctx = context._context;
      const lineHeight = e.fontSize * e.lineHeight;
      const lines = text.textArr;
      ctx.fillStyle = e.color;
      if (lineHeight * lod.scale < BLOCK_LINE_PX) {
        // Lines closer than a pixel or so: one faint block for the whole box.
        ctx.globalAlpha *= 0.25;
        ctx.fillRect(0, 0, e.width, lines.length * lineHeight);
        return;
      }
      ctx.globalAlpha *= 0.45;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const x =
          e.align === "right"
            ? e.width - line.width
            : e.align === "center"
              ? (e.width - line.width) / 2
              : 0;
        ctx.fillRect(x, i * lineHeight + lineHeight * 0.3, line.width, lineHeight * 0.4);
      }
    };
  }

  function createNode(e: SceneElement): Konva.Shape {
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    const common = {
      x: cx,
      y: cy,
      rotation: e.rotation,
      opacity: e.opacity,
      listening: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
      visible: false,
    };
    if (e.kind === "text") {
      return new Konva.Text({
        ...common,
        offsetX: e.width / 2,
        offsetY: e.height / 2,
        width: e.width,
        text: e.text,
        fontFamily: e.fontFamily,
        fontSize: e.fontSize,
        fontStyle: e.fontWeight === 700 ? "bold" : "normal",
        lineHeight: e.lineHeight,
        align: e.align,
        fill: e.color,
        wrap: "word",
        sceneFunc: textScene(e),
      });
    }
    if (e.kind === "image") {
      return new Konva.Image({
        ...common,
        offsetX: e.width / 2,
        offsetY: e.height / 2,
        width: e.width,
        height: e.height,
        image: undefined,
        fill: "#d8d8d8",
      });
    }
    const paint = {
      ...(e.fill !== null ? { fill: e.fill } : {}),
      ...(e.stroke !== null ? { stroke: e.stroke, strokeWidth: e.strokeWidth } : {}),
    };
    const hw = e.width / 2;
    const hh = e.height / 2;
    switch (e.shape) {
      case "rect":
        return new Konva.Rect({
          ...common,
          ...paint,
          offsetX: hw,
          offsetY: hh,
          width: e.width,
          height: e.height,
        });
      case "ellipse":
        return new Konva.Ellipse({ ...common, ...paint, radiusX: hw, radiusY: hh });
      case "triangle":
        return new Konva.Line({
          ...common,
          ...paint,
          points: [0, -hh, hw, hh, -hw, hh],
          closed: true,
        });
      case "line":
        return new Konva.Line({ ...common, ...paint, points: [-hw, -hh, hw, hh] });
    }
  }

  function updateBounds(item: Item): void {
    const e = item.element;
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    let h = e.height;
    let margin = 0;
    if (e.kind === "text") h = Math.max(e.height, item.node.height());
    if (e.kind === "shape" && e.stroke !== null) margin = e.strokeWidth / 2;
    [item.minX, item.minY, item.maxX, item.maxY] = rotatedBounds(
      e.x,
      e.y,
      e.width,
      h,
      cx,
      cy,
      e.rotation,
      margin,
    );
  }

  function toWorld(camera: CameraPose, sx: number, sy: number): [number, number] {
    return [
      (sx - viewport.width / 2) / camera.zoom + camera.x,
      (sy - viewport.height / 2) / camera.zoom + camera.y,
    ];
  }

  function commitEdit(id: string, text: string): void {
    const item = byId.get(id);
    if (item === undefined) return;
    const node = item.node as Konva.Text;
    if (node.text() !== text) {
      node.text(text);
      updateBounds(item);
    }
    dirty = true;
  }

  const engine: KonvaEngine = {
    name: "konva",

    async load(setup: EngineSetup) {
      viewport = setup.viewport;
      reportTextSharp = setup.reportTextSharp;
      // Konva redraws on attribute changes by default; this engine draws explicitly.
      Konva.autoDrawEnabled = false;
      Konva.pixelRatio = viewport.devicePixelRatio;
      stage = new Konva.Stage({
        container: setup.container as HTMLDivElement,
        width: viewport.width,
        height: viewport.height,
        listening: false,
      });
      layer = new Konva.Layer({ listening: false });
      stage.add(layer);

      items = setup.scene.elements.map((element) => {
        const node = createNode(element);
        const item: Item = {
          element,
          node,
          minX: 0,
          minY: 0,
          maxX: 0,
          maxY: 0,
          visible: false,
        };
        updateBounds(item);
        byId.set(element.id, item);
        return item;
      });
      layer.add(...items.map((i) => i.node));

      images = new ImageLod(
        setup.images,
        setup.scene.assets,
        () => {
          dirty = true;
        },
        options.imageBudgetBytes,
      );
      await images.loadBase();

      editor = new TextEditor(
        setup.container,
        viewport,
        options.editMode ?? "screen",
        commitEdit,
      );
      dirty = true;
    },

    render(camera: CameraPose) {
      if (layer === undefined || images === undefined) return;
      const moved =
        last === undefined ||
        camera.x !== last.x ||
        camera.y !== last.y ||
        camera.zoom !== last.zoom;
      last = camera;
      editor?.update(camera);
      if (!moved && !dirty && sharp) {
        counters.framesSkipped++;
        reportTextSharp();
        return;
      }

      const dpr = viewport.devicePixelRatio;
      const z = camera.zoom;
      const scale = z * dpr;
      layer.setAttrs({
        x: viewport.width / 2 - camera.x * z,
        y: viewport.height / 2 - camera.y * z,
        scaleX: z,
        scaleY: z,
      });

      // Culling.
      const halfW = viewport.width / 2 / z;
      const halfH = viewport.height / 2 / z;
      const left = camera.x - halfW;
      const right = camera.x + halfW;
      const top = camera.y - halfH;
      const bottom = camera.y + halfH;
      const minWorld = MIN_ELEMENT_PX / scale;
      const editingId = editor?.editingId;
      images.beginFrame();
      let visibleCount = 0;
      for (const item of items) {
        const visible =
          item.maxX >= left &&
          item.minX <= right &&
          item.maxY >= top &&
          item.minY <= bottom &&
          Math.max(item.maxX - item.minX, item.maxY - item.minY) >= minWorld &&
          item.element.id !== editingId;
        if (visible !== item.visible) {
          item.visible = visible;
          item.node.visible(visible);
        }
        if (!visible) continue;
        visibleCount++;
        const e = item.element;
        if (e.kind === "image") {
          const node = item.node as Konva.Image;
          const bitmap = images.bitmapFor(e.assetId, Math.max(e.width, e.height) * scale);
          if (bitmap !== node.image()) {
            node.image(bitmap);
            node.fill(bitmap === undefined ? "#d8d8d8" : "");
          }
        }
      }

      lod.scale = scale;
      lod.glyphMinPx = moved ? movingGlyphMin : stillGlyphMin;
      lod.glyphBoxes = 0;
      layer.draw();

      counters.framesDrawn++;
      counters.maxVisibleNodes = Math.max(counters.maxVisibleNodes, visibleCount);
      counters.maxGlyphBoxes = Math.max(counters.maxGlyphBoxes, lod.glyphBoxes);
      dirty = false;
      sharp = !moved;
      if (sharp) {
        counters.stillFramesDrawn++;
        reportTextSharp();
      }
    },

    dispose() {
      editor?.dispose();
      editor = undefined;
      finalImageStats = images?.stats() ?? finalImageStats;
      images?.dispose();
      images = undefined;
      stage?.destroy();
      stage = undefined;
      layer = undefined;
      items = [];
      byId.clear();
      last = undefined;
      reportTextSharp = () => {};
    },

    textAt(x, y) {
      if (last === undefined) return undefined;
      const [wx, wy] = toWorld(last, x, y);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        const e = item.element;
        if (e.kind !== "text") continue;
        if (wx < item.minX || wx > item.maxX || wy < item.minY || wy > item.maxY)
          continue;
        // Into the box's own frame: undo the rotation around its centre.
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        const a = (-e.rotation * Math.PI) / 180;
        const dx = wx - cx;
        const dy = wy - cy;
        const lx = cx + dx * Math.cos(a) - dy * Math.sin(a);
        const ly = cy + dx * Math.sin(a) + dy * Math.cos(a);
        const h = Math.max(e.height, item.node.height());
        if (lx >= e.x && lx <= e.x + e.width && ly >= e.y && ly <= e.y + h) return e.id;
      }
      return undefined;
    },

    beginEdit(id) {
      const item = byId.get(id);
      if (item === undefined || item.element.kind !== "text" || editor === undefined)
        return;
      if (last === undefined) throw new Error("render() must run before editing");
      editor.open(
        { element: item.element, text: (item.node as Konva.Text).text() },
        last,
      );
      dirty = true;
    },

    endEdit() {
      editor?.close();
    },

    textOf(id) {
      const item = byId.get(id);
      return item?.element.kind === "text" ? (item.node as Konva.Text).text() : undefined;
    },

    textLines(id) {
      const item = byId.get(id);
      if (item?.element.kind !== "text") return [];
      return (item.node as Konva.Text).textArr.map(({ text, width }) => ({
        text,
        width,
      }));
    },

    get textarea() {
      return editor?.textarea;
    },

    invalidate() {
      dirty = true;
    },

    stats() {
      return {
        ...counters,
        images: images?.stats() ?? finalImageStats,
        pixelRatio: Konva.pixelRatio,
      };
    },
  };
  return engine;
}
