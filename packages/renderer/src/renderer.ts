// SPDX-License-Identifier: GPL-3.0-or-later

// The renderer: draws the resolved document through the camera on a Canvas 2D,
// and answers where things are on screen. See docs/adr/0004 for the requirements
// and the interface.

import type { CameraView, ElementId, Point, Rect } from "@galatsa/core";
import type { ElementBox, Label, ViewHost } from "@galatsa/extension-api";
import type { MessageValues } from "@galatsa/i18n";
import { CanvasState, type Canvas2D } from "./canvas.ts";
import { CanvasDrawContext, detailFor, type FrameCounters } from "./draw-context.ts";
import { ImageCache, type ImageCacheOptions, type ImageSource } from "./images.ts";
import { RecordedPath, paintPath } from "./path.ts";
import type { SceneAssets, SceneSource } from "./scene.ts";
import { SceneTree, type Container, type SceneNode } from "./scene-tree.ts";
import {
  canvasMeasurer,
  DEFAULT_FAMILIES,
  estimateMeasurer,
  LayoutCache,
  REFERENCE_SIZE,
  type FontFamilies,
  type TextMeasurer,
} from "./text.ts";
import {
  apply,
  elementMatrix,
  invert,
  spaceMap,
  spaceMatrix,
  visibleRect,
  type SpaceMap,
  type Viewport,
} from "./transform.ts";

/** An element's rectangle on screen, in CSS pixels of the drawing area. */
export interface ScreenRect {
  /** Axis-aligned bounds. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Rotation of the element's box, in radians (0 for frames and groups). */
  readonly rotation: number;
  /** Corners of the box: top-left, top-right, bottom-right, bottom-left (before rotation). */
  readonly corners: readonly [Point, Point, Point, Point];
}

export interface HitTestOptions {
  /** How far from an element a point still hits it, in CSS pixels. Default 0. */
  readonly tolerance?: number;
  /** Elements to pass over (locked ones, say); the search continues below them. */
  readonly accept?: (id: ElementId) => boolean;
}

/** A region of the document drawn to an image (docs/adr/0005, RegionRenderer). */
export interface Region {
  /** Container whose local space `rect` is in; null for the root. */
  readonly space: ElementId | null;
  readonly rect: Rect;
}

export interface RegionImage {
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

/** Placeholder for in-place text editing, which is not built yet. */
export interface TextEditSession {
  readonly id: ElementId;
  end(): void;
}

export interface RendererOptions {
  /** The extension host whose element types draw the elements. */
  readonly host: ViewHost;
  /** Image bytes and stored versions. Without it, images draw their stand-ins. */
  readonly images?: ImageSource;
  readonly imageOptions?: Omit<ImageCacheOptions, "onChange">;
  /** Natural pixel sizes of image assets (the document's asset descriptions). */
  readonly assets?: SceneAssets;
  /** Looks up text that elements draw themselves (placeholders, "missing image"). */
  readonly t?: (label: Label, values?: MessageValues) => string;
  /** CSS colour behind everything; null leaves the canvas transparent. Default white. */
  readonly background?: string | null;
  readonly families?: FontFamilies;
  /** Text measurement; default the canvas, or an estimate where there is none. */
  readonly measurer?: TextMeasurer;
  /** Called when something changed outside render(), so the host draws again. */
  readonly onInvalidate?: () => void;
}

/** Counters of the last frame. */
export interface RenderStats {
  frames: number;
  lastFrameMs: number;
  elementsDrawn: number;
  containersVisited: number;
  fillText: number;
  textBars: number;
  images: number;
  imagesIncomplete: boolean;
}

/** The drawing target of one frame. */
interface Target {
  readonly state: CanvasState;
  readonly viewport: Viewport;
  readonly camera: CameraView;
}

const DEFAULT_CAMERA: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
/** Visible area grown by this many device pixels when culling. */
const CULL_MARGIN = 2;

export class CanvasRenderer {
  readonly #host: ViewHost;
  readonly #options: RendererOptions;
  readonly #images: ImageCache | null;
  readonly #layouts = new LayoutCache();
  #measurer: TextMeasurer;
  #tree: SceneTree | null = null;
  #camera: CameraView = DEFAULT_CAMERA;
  #viewport: Viewport = { width: 0, height: 0, devicePixelRatio: 1 };
  #canvas: HTMLCanvasElement | null = null;
  #state: CanvasState | null = null;
  #unmount: (() => void) | null = null;
  readonly stats: RenderStats = {
    frames: 0,
    lastFrameMs: 0,
    elementsDrawn: 0,
    containersVisited: 0,
    fillText: 0,
    textBars: 0,
    images: 0,
    imagesIncomplete: false,
  };

  constructor(options: RendererOptions) {
    this.#host = options.host;
    this.#options = options;
    this.#measurer = options.measurer ?? estimateMeasurer;
    this.#images = options.images
      ? new ImageCache(options.images, {
          ...options.imageOptions,
          onChange: () => this.#options.onInvalidate?.(),
        })
      : null;
  }

  get images(): ImageCache | null {
    return this.#images;
  }

  get camera(): CameraView {
    return this.#camera;
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  /**
   * Adds a canvas to `container`, sized to it, and follows changes of its size
   * and of the device pixel ratio (calling onInvalidate after each).
   */
  mount(container: HTMLElement): void {
    this.#unmount?.();
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.append(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas context");
    this.#canvas = canvas;
    this.attach(ctx, {
      width: container.clientWidth,
      height: container.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    const update = (): void => {
      this.setViewport({
        width: container.clientWidth,
        height: container.clientHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
      this.#options.onInvalidate?.();
    };
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resize?.observe(container);
    // A change of device pixel ratio (another screen, browser zoom) ends the
    // media query that matched the old one.
    let media: MediaQueryList | null = null;
    const watchRatio = (): void => {
      media?.removeEventListener("change", onRatio);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      media.addEventListener("change", onRatio);
    };
    const onRatio = (): void => {
      watchRatio();
      update();
    };
    watchRatio();
    this.#unmount = () => {
      resize?.disconnect();
      media?.removeEventListener("change", onRatio);
      canvas.remove();
      canvas.width = 0;
      canvas.height = 0;
    };
  }

  /**
   * Draws into a 2D context of one's own (an OffscreenCanvas, a test's recording
   * context) instead of mounting. With a canvas element behind it, setViewport()
   * resizes that canvas.
   */
  attach(ctx: Canvas2D & Partial<CanvasText>, viewport: Viewport): void {
    this.#state = new CanvasState(ctx);
    if (!this.#options.measurer && typeof ctx.measureText === "function") {
      // Measure on a context of its own, so measuring never changes the drawing font.
      this.#measurer = makeMeasurer() ?? this.#measurer;
    }
    this.setViewport(viewport);
  }

  /** Sets the size of the drawing area and the device pixel ratio. */
  setViewport(viewport: Viewport): void {
    this.#viewport = viewport;
    const canvas = this.#canvas;
    if (canvas) {
      const w = Math.max(1, Math.round(viewport.width * viewport.devicePixelRatio));
      const h = Math.max(1, Math.round(viewport.height * viewport.devicePixelRatio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
  }

  /** Hands over a resolved document; replaces what was there. */
  setScene(source: SceneSource): void {
    this.#tree = new SceneTree(source, (node) => this.#area(node));
  }

  /**
   * Reads the given elements again: ids that one transaction added, changed or
   * removed. Pass the source when the document state is a new object (a new
   * Resolver); a live source can be left out.
   */
  applyChanges(ids: Iterable<ElementId>, source?: SceneSource): void {
    if (!this.#tree) {
      if (source) this.setScene(source);
      return;
    }
    this.#tree.apply(ids, source);
  }

  /** Sets the camera for the next frame. */
  setCamera(camera: CameraView): void {
    this.#camera = camera;
  }

  /** Draws one frame into the mounted or attached canvas. */
  render(): void {
    const state = this.#state;
    if (!state) return;
    const start = performance.now();
    this.#draw({ state, viewport: this.#viewport, camera: this.#camera });
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - start;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** The drawn area of an extension element in its local box. */
  #area(node: SceneNode): Rect {
    const box = { x: 0, y: 0, w: node.w, h: node.h };
    const record = node.record;
    try {
      const resolved = this.#host.resolve(record);
      if (resolved.status !== "known" || !resolved.type.definition.bounds) return box;
      const read = this.#host.read(record);
      if (!read) return box;
      return resolved.type.definition.bounds(read.model, {
        id: node.id,
        w: node.w,
        h: node.h,
      });
    } catch {
      return box;
    }
  }

  #draw(target: Target): void {
    const { state, viewport, camera } = target;
    const tree = this.#tree;
    const widthPx = Math.max(1, Math.round(viewport.width * viewport.devicePixelRatio));
    const heightPx = Math.max(1, Math.round(viewport.height * viewport.devicePixelRatio));
    state.reset();
    const ctx = state.ctx;
    const background =
      this.#options.background === undefined ? "#ffffff" : this.#options.background;
    if (background === null) ctx.clearRect(0, 0, widthPx, heightPx);
    else {
      state.fill(background);
      ctx.fillRect(0, 0, widthPx, heightPx);
    }
    this.stats.elementsDrawn = 0;
    this.stats.containersVisited = 0;
    if (!tree) return;
    const counters: FrameCounters = {
      fillText: 0,
      textBars: 0,
      images: 0,
      imagesIncomplete: false,
    };
    const images = this.#images;
    images?.beginFrame();
    const assets = this.#options.assets;
    const dc = new CanvasDrawContext(
      {
        state,
        view: [0, 0, widthPx, heightPx],
        images,
        imageSize: (asset) => assets?.imageSize(asset) ?? this.#naturalSize(asset),
        measurer: this.#measurer,
        families: this.#options.families ?? DEFAULT_FAMILIES,
        layouts: this.#layouts,
        t: (label, values) => this.#options.t?.(label, values) ?? label,
      },
      counters,
    );
    const maps = new Map<ElementId | null, SpaceMap>();
    const mapFor = (space: ElementId | null): SpaceMap => {
      let map = maps.get(space);
      if (!map) {
        map = spaceMap(camera, viewport, tree.source.offset(space, camera.space));
        maps.set(space, map);
      }
      return map;
    };
    const host = this.#host;
    const visit = (container: Container, map: SpaceMap): void => {
      this.stats.containersVisited++;
      const s = map.scale;
      const rect = grow(visibleRect(map, widthPx, heightPx, CULL_MARGIN));
      for (const node of tree.visibleChildren(container, rect, 0.5 / s)) {
        if (node.kind === "element") {
          const m = elementMatrix(map, node.x, node.y, node.w, node.h, node.rot);
          dc.begin(m, s, detailFor(Math.max(node.w, node.h) * s));
          host.drawElement(dc, node.record, node.id as ElementId);
          this.stats.elementsDrawn++;
          continue;
        }
        const inner = mapFor(node.id);
        if (node.kind === "frame" && !node.gone) {
          const data = node.record.data;
          const outline = new RecordedPath();
          outline.rect(0, 0, node.w, node.h);
          const m = spaceMatrix(inner, 0, 0);
          const view = [0, 0, widthPx, heightPx];
          if (typeof data["fill"] === "string")
            paintPath(state, outline, m, { kind: "fill", color: data["fill"] }, view);
          if (data["clip"] === true) {
            state.save();
            if (paintPath(state, outline, m, { kind: "clip" }, view))
              visit(node.container!, inner);
            state.restore();
          } else visit(node.container!, inner);
          if (typeof data["stroke"] === "string")
            paintPath(
              state,
              outline,
              m,
              { kind: "stroke", style: { color: data["stroke"], width: 1 / s } },
              view,
            );
        } else visit(node.container!, inner);
      }
    };
    visit(tree.root, mapFor(null));
    images?.endFrame();
    state.identity();
    this.stats.fillText = counters.fillText;
    this.stats.textBars = counters.textBars;
    this.stats.images = counters.images;
    this.stats.imagesIncomplete = counters.imagesIncomplete;
  }

  /** The natural size of an image from its stored versions (the last is the original). */
  #naturalSize(asset: string): { w: number; h: number } | undefined {
    const levels = this.#options.images?.levels(asset);
    const original = levels?.[levels.length - 1];
    return original ? { w: original.width, h: original.height } : undefined;
  }

  // -------------------------------------------------------------------------
  // Questions about the screen
  // -------------------------------------------------------------------------

  #map(space: ElementId | null): SpaceMap | null {
    if (!this.#tree) return null;
    return spaceMap(
      this.#camera,
      this.#viewport,
      this.#tree.source.offset(space, this.#camera.space),
    );
  }

  /**
   * The topmost element at a point (CSS pixels in the drawing area): an
   * extension element, or a frame where nothing inside it is hit. Groups are
   * never returned; the editor decides what a click inside a group selects.
   */
  hitTest(x: number, y: number, options: HitTestOptions = {}): ElementId | null {
    const tree = this.#tree;
    if (!tree) return null;
    const dpr = this.#viewport.devicePixelRatio;
    const px = x * dpr;
    const py = y * dpr;
    const tolPx = (options.tolerance ?? 0) * dpr;
    const accept = options.accept ?? (() => true);
    const search = (container: Container, space: ElementId | null): ElementId | null => {
      const map = this.#map(space)!;
      const s = map.scale;
      const lx = (px - map.ox) / s;
      const ly = (py - map.oy) / s;
      const tol = tolPx / s;
      const near = { x: lx - tol, y: ly - tol, w: 2 * tol, h: 2 * tol };
      const candidates = tree.visibleChildren(container, grow(near), 0);
      for (let i = candidates.length - 1; i >= 0; i--) {
        const node = candidates[i]!;
        if (node.kind === "element") {
          if (accept(node.id) && this.#hitsElement(node, map, px, py, tol))
            return node.id;
          continue;
        }
        const insideFrame =
          node.kind === "frame" &&
          !node.gone &&
          lx >= node.x - tol &&
          lx <= node.x + node.w + tol &&
          ly >= node.y - tol &&
          ly <= node.y + node.h + tol;
        const clips =
          node.kind === "frame" && !node.gone && node.record.data["clip"] === true;
        if (!clips || insideFrame) {
          const hit = search(node.container!, node.id);
          if (hit !== null) return hit;
        }
        if (insideFrame && accept(node.id)) return node.id;
      }
      return null;
    };
    return search(tree.root, null);
  }

  #hitsElement(
    node: SceneNode,
    map: SpaceMap,
    px: number,
    py: number,
    tol: number,
  ): boolean {
    const m = elementMatrix(map, node.x, node.y, node.w, node.h, node.rot);
    const p = invert(m, px, py);
    const box: ElementBox = { id: node.id, w: node.w, h: node.h };
    try {
      const resolved = this.#host.resolve(node.record);
      if (resolved.status === "known" && resolved.type.definition.hitTest) {
        const read = this.#host.read(node.record);
        if (read) return resolved.type.definition.hitTest(read.model, p, box, tol);
      }
    } catch {
      // A failing type is hit like a placeholder: by its box.
    }
    return p.x >= -tol && p.x <= node.w + tol && p.y >= -tol && p.y <= node.h + tol;
  }

  /** The screen rectangle of an element, or null if it is not in the scene or draws nothing. */
  screenBounds(id: ElementId): ScreenRect | null {
    const node = this.#tree?.nodes.get(id);
    if (!node?.bounds) return null;
    const map = this.#map(node.parent);
    if (!map) return null;
    const dpr = this.#viewport.devicePixelRatio;
    let corners: [Point, Point, Point, Point];
    let rotation = 0;
    if (node.kind === "element" || (node.kind === "frame" && !node.gone)) {
      const m = elementMatrix(map, node.x, node.y, node.w, node.h, node.rot);
      const at = (x: number, y: number): Point => {
        const p = apply(m, x, y);
        return { x: p.x / dpr, y: p.y / dpr };
      };
      corners = [at(0, 0), at(node.w, 0), at(node.w, node.h), at(0, node.h)];
      rotation = node.rot;
    } else {
      const b = node.bounds;
      const at = (x: number, y: number): Point => ({
        x: (x * map.scale + map.ox) / dpr,
        y: (y * map.scale + map.oy) / dpr,
      });
      corners = [
        at(b.x, b.y),
        at(b.x + b.w, b.y),
        at(b.x + b.w, b.y + b.h),
        at(b.x, b.y + b.h),
      ];
    }
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, rotation, corners };
  }

  /**
   * Elements whose screen bounds meet (or, with `inside`, lie within) a
   * rectangle in CSS pixels, at the top level of `space` (the root by default),
   * in drawing order. For rubber-band selection.
   */
  elementsInRect(
    rect: Rect,
    options: { space?: ElementId | null; inside?: boolean } = {},
  ): ElementId[] {
    const tree = this.#tree;
    const space = options.space ?? null;
    const container = tree?.container(space);
    const map = this.#map(space);
    if (!tree || !container || !map) return [];
    const dpr = this.#viewport.devicePixelRatio;
    const local = {
      x: (rect.x * dpr - map.ox) / map.scale,
      y: (rect.y * dpr - map.oy) / map.scale,
      w: (rect.w * dpr) / map.scale,
      h: (rect.h * dpr) / map.scale,
    };
    return tree
      .visibleChildren(container, local, 0)
      .filter((node) => {
        if (!options.inside) return true;
        const b = node.bounds!;
        return (
          b.x >= local.x &&
          b.y >= local.y &&
          b.x + b.w <= local.x + local.w &&
          b.y + b.h <= local.y + local.h
        );
      })
      .map((node) => node.id);
  }

  /** In-place text editing; not built yet (the interface keeps its place). */
  beginTextEdit(id: ElementId): TextEditSession {
    throw new Error(`In-place text editing is not available yet (element ${id})`);
  }

  // -------------------------------------------------------------------------
  // Region rendering
  // -------------------------------------------------------------------------

  /**
   * Draws a region of the document into an image of the given size and encodes
   * it, waiting for the image versions it needs. The region is fitted inside the
   * image and centred. Shape of RegionRenderer in docs/adr/0005.
   */
  async renderRegion(region: Region, image: RegionImage): Promise<Uint8Array> {
    const { canvas, ctx } = makeCanvas(image.width, image.height);
    const state = new CanvasState(ctx);
    const zoom = Math.min(image.width / region.rect.w, image.height / region.rect.h);
    const camera: CameraView = {
      space: region.space,
      cx: region.rect.x + region.rect.w / 2,
      cy: region.rect.y + region.rect.h / 2,
      zoom,
    };
    const target = {
      state,
      viewport: { width: image.width, height: image.height, devicePixelRatio: 1 },
      camera,
    };
    const saved = { ...this.stats };
    for (let round = 0; round < 20; round++) {
      this.#draw(target);
      if (!this.stats.imagesIncomplete || !this.#images?.busy) break;
      await this.#images.settle();
    }
    Object.assign(this.stats, saved);
    const blob = await encode(canvas, image.mediaType);
    return new Uint8Array(await blob.arrayBuffer());
  }

  dispose(): void {
    this.#unmount?.();
    this.#unmount = null;
    this.#canvas = null;
    this.#state = null;
    this.#tree = null;
    this.#images?.dispose();
    this.#layouts.clear();
  }
}

interface CanvasText {
  measureText(text: string): { width: number };
}

/** Grows a rectangle by a hair relative to its coordinates, against rounding. */
function grow(r: Rect): Rect {
  const eps = (Math.abs(r.x) + Math.abs(r.y) + r.w + r.h) * 2 ** -40;
  return { x: r.x - eps, y: r.y - eps, w: r.w + 2 * eps, h: r.h + 2 * eps };
}

function makeMeasurer(): TextMeasurer | null {
  try {
    const { ctx } = makeCanvas(1, 1);
    const c = ctx as unknown as {
      font: string;
      measureText(t: string): { width: number };
    };
    c.font = `400 ${REFERENCE_SIZE}px sans-serif`;
    return canvasMeasurer(c);
  } catch {
    return null;
  }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: Canvas2D } {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx: ctx as unknown as Canvas2D };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context");
  return { canvas, ctx };
}

function encode(canvas: AnyCanvas, type: string): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Encoding failed"))),
      type,
    ),
  );
}
