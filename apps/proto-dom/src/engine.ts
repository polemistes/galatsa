// SPDX-License-Identifier: GPL-3.0-or-later

// Prototype rendering engine C: the browser's own elements, positioned with CSS
// transforms. Throwaway code, written to be measured and judged, not reused.
//
// Every scene element becomes one element: a <div> for rectangles, ellipses, lines
// and text, an inline <svg> for triangles (CSS cannot stroke a non-rectangular
// outline; a clip-path cuts the border off), and an <img> for images.
//
// Three ways to place them, chosen by `mode`:
//
// - "element" (the candidate): the engine computes, in float64, where each visible
//   element lands on screen relative to the camera and writes one matrix() per
//   element. The browser only ever sees screen-sized numbers, so precision does not
//   depend on how far the camera is from the world origin. Shapes and images are
//   laid out once in world units and scaled by their matrix (scaling is exact for
//   them). Text is laid out at a "base zoom": font size and box width in screen
//   pixels for that zoom. While the camera moves, the matrix scales text from its
//   base zoom, and text whose scale drifts beyond a factor of two is laid out again
//   within a time budget. When the camera stops, all visible text is laid out at the
//   exact zoom, again within a time budget per frame, and the engine reports sharp
//   text one frame after the last of it was laid out.
// - "screen": like "element", but all visible text is laid out at the exact zoom in
//   every frame. Always as sharp as the browser can make it; the most layout work.
// - "layer": the usual approach of web whiteboards. One world <div> carries a single
//   transform (translate and scale) and the elements are laid out inside it in
//   world units. One style write per frame; precision and text quality are left to
//   the browser. With `willChange: "motion"`, the world <div> gets
//   `will-change: transform` while the camera moves (the browser keeps one raster
//   and scales it) and loses it when the camera stops (the browser rasterises again).
//
// Culling, chosen by `cull`: "detach" removes elements that are off screen from the
// document, "display" sets display: none on them, "none" keeps all 2,000 attached
// (the browser culls when it paints).

import type {
  BenchEngine,
  BenchViewport,
  CameraPose,
  EngineSetup,
  ImageAsset,
  SceneElement,
  ShapeElement,
  TextElement,
} from "@galatsa/bench";
import { ImageLevels, wantedLevel } from "./image-levels.ts";

export type PlacementMode = "element" | "screen" | "layer";
export type CullMode = "detach" | "display" | "none";

export interface DomEngineOptions {
  readonly name: string;
  readonly mode: PlacementMode;
  readonly cull: CullMode;
  /** "layer" mode only. */
  readonly willChange?: "none" | "motion";
  /** Milliseconds per frame for laying out text again ("element" mode). */
  readonly relayoutBudgetMs?: number;
  /** Wait for the images of the first pose in load(). Default true. */
  readonly awaitFirstImages?: boolean;
}

/** Extra methods for the lab page and the tests. Not part of the bench interface. */
export interface DomEngine extends BenchEngine {
  /** Makes a text element editable and focuses it. Returns its element. */
  beginEdit(id: string): HTMLElement | undefined;
  endEdit(): void;
  /** The current text of a text element, with edits. */
  textOf(id: string): string | undefined;
  /** Counters for the report. */
  stats(): Record<string, number>;
}

interface Item {
  readonly el: SceneElement;
  readonly index: number;
  readonly cos: number;
  readonly sin: number;
  /** Bounding radius around the centre, for culling (world units). */
  readonly radius: number;
  readonly cx: number;
  readonly cy: number;
  node: HTMLElement | SVGSVGElement | undefined;
  attached: boolean;
  visible: boolean;
  /** Text: the zoom the text is laid out at (0 = not yet). */
  baseZoom: number;
  /** Image: level shown, or -1. */
  shownLevel: number;
  /** Image: level the img is loading. */
  loadingLevel: number;
  /** The last matrix written, to skip identical writes. */
  matrix: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function sameCamera(a: CameraPose | undefined, b: CameraPose): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function setShapeStyle(node: HTMLElement, e: ShapeElement): void {
  const s = node.style;
  if (e.shape === "line") {
    // A bar from the top-left to the bottom-right corner of the box.
    const length = Math.hypot(e.width, e.height);
    const angle = (Math.atan2(e.height, e.width) * 180) / Math.PI;
    s.width = `${length}px`;
    s.height = `${e.strokeWidth}px`;
    s.left = `${e.width / 2 - length / 2}px`;
    s.top = `${e.height / 2 - e.strokeWidth / 2}px`;
    s.background = e.stroke ?? "#000";
    s.transform = `rotate(${angle}deg)`;
    return;
  }
  // The stroke is centred on the outline, as in canvas and SVG: the box grows by
  // half the stroke width on each side and the border fills it.
  const half = e.stroke !== null ? e.strokeWidth / 2 : 0;
  s.left = `${-half}px`;
  s.top = `${-half}px`;
  s.width = `${e.width + 2 * half}px`;
  s.height = `${e.height + 2 * half}px`;
  if (e.fill !== null) s.background = e.fill;
  if (e.stroke !== null) s.border = `${e.strokeWidth}px solid ${e.stroke}`;
  if (e.shape === "ellipse") s.borderRadius = "50%";
}

export function createDomEngine(options: DomEngineOptions): DomEngine {
  const { mode, cull } = options;
  const budgetMs = options.relayoutBudgetMs ?? 6;
  let container: HTMLElement | undefined;
  let world: HTMLElement | undefined;
  let viewport: BenchViewport = { width: 0, height: 0, devicePixelRatio: 1 };
  let items: Item[] = [];
  const byId = new Map<string, Item>();
  const assets = new Map<string, ImageAsset>();
  const texts = new Map<string, string>();
  let images: ImageLevels | undefined;
  let reportTextSharp = (): void => {};
  let previous: CameraPose | undefined;
  let lastCamera: CameraPose | undefined;
  let editing: Item | undefined;
  let frame = 0;
  // Sharpness bookkeeping: the first frame in which the camera stood still and no
  // text was left to lay out (in "layer" mode with will-change: the frame that
  // removed it), or -1.
  let settledFrame = -1;
  let worldMoving = false;
  const counters = {
    relayouts: 0,
    attaches: 0,
    detaches: 0,
    creates: 0,
    imageSwaps: 0,
    maxVisible: 0,
  };

  const layoutText = (item: Item, zoom: number) => {
    const e = item.el as TextElement;
    const node = item.node as HTMLElement;
    const s = node.style;
    s.fontSize = `${e.fontSize * zoom}px`;
    s.width = `${e.width * zoom}px`;
    item.baseZoom = zoom;
    counters.relayouts++;
  };

  const createNode = (item: Item): HTMLElement | SVGSVGElement => {
    const e = item.el;
    counters.creates++;
    let node: HTMLElement | SVGSVGElement;
    if (e.kind === "shape" && e.shape === "triangle") {
      const svg = document.createElementNS(SVG_NS, "svg");
      // Room for a stroke centred on the outline; overflow is visible anyway.
      svg.setAttribute("width", String(e.width));
      svg.setAttribute("height", String(e.height));
      svg.setAttribute("viewBox", `0 0 ${e.width} ${e.height}`);
      svg.style.overflow = "visible";
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.setAttribute(
        "points",
        `${e.width / 2},0 ${e.width},${e.height} 0,${e.height}`,
      );
      polygon.setAttribute("fill", e.fill ?? "none");
      if (e.stroke !== null) {
        polygon.setAttribute("stroke", e.stroke);
        polygon.setAttribute("stroke-width", String(e.strokeWidth));
        polygon.setAttribute("stroke-linejoin", "miter");
      }
      svg.append(polygon);
      node = svg;
    } else if (e.kind === "shape") {
      // An outer box of the element's size, so that every kind shares one matrix,
      // and an inner box for the visible shape.
      const outer = document.createElement("div");
      outer.style.width = `${e.width}px`;
      outer.style.height = `${e.height}px`;
      const inner = document.createElement("div");
      inner.style.position = "absolute";
      inner.style.boxSizing = "border-box";
      setShapeStyle(inner, e);
      outer.append(inner);
      node = outer;
    } else if (e.kind === "text") {
      const div = document.createElement("div");
      const s = div.style;
      s.fontFamily = e.fontFamily;
      s.fontWeight = String(e.fontWeight);
      s.lineHeight = String(e.lineHeight);
      s.color = e.color;
      s.textAlign = e.align;
      s.whiteSpace = "pre-wrap";
      s.overflowWrap = "break-word";
      s.contain = "layout style";
      div.textContent = texts.get(e.id) ?? e.text;
      div.dataset["id"] = e.id;
      node = div;
    } else {
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      img.style.width = `${e.width}px`;
      img.style.height = `${e.height}px`;
      img.style.background = "#bbb"; // until a level has arrived
      node = img;
    }
    const s = node.style;
    s.position = "absolute";
    s.left = "0";
    s.top = "0";
    s.transformOrigin = "0 0";
    s.zIndex = String(item.index);
    if (e.opacity < 1) s.opacity = String(e.opacity);
    if (e.kind === "text") {
      if (mode === "layer") layoutText(item, 1);
    }
    if (mode === "layer") {
      // Static matrix in world units: rotate around the element's centre.
      const m = `matrix(${item.cos},${item.sin},${-item.sin},${item.cos},${
        item.cx - (item.cos * e.width - item.sin * e.height) / 2
      },${item.cy - (item.sin * e.width + item.cos * e.height) / 2})`;
      s.transform = m;
    }
    return node;
  };

  const attach = (item: Item) => {
    item.node ??= createNode(item);
    if (item.attached) {
      if (cull === "display") item.node.style.display = "";
      return;
    }
    (world ?? container)!.append(item.node);
    item.attached = true;
    counters.attaches++;
  };

  const detach = (item: Item) => {
    if (item === editing || item.node === undefined) return;
    if (cull === "display") {
      item.node.style.display = "none";
    } else if (cull === "detach" && item.attached) {
      item.node.remove();
      item.attached = false;
      counters.detaches++;
    }
  };

  /** Swap in a better image level if one is cached; ask for the wanted one. */
  const updateImage = (item: Item, zoom: number, priority: number) => {
    if (images === undefined || item.node === undefined) return;
    const e = item.el;
    if (e.kind !== "image") return;
    const asset = assets.get(e.assetId)!;
    const k = wantedLevel(asset, e.width * zoom * viewport.devicePixelRatio);
    if (!images.has(asset.id, k)) images.request(asset, k, priority);
    const level = images.best(asset.id, k);
    if (level === undefined || level.k === item.shownLevel) return;
    if (level.k === item.loadingLevel) return;
    // Decode off-screen first, then swap, so the old level stays until the new one
    // is ready (no flash of the placeholder).
    const img = item.node as HTMLImageElement;
    item.loadingLevel = level.k;
    const probe = new Image();
    probe.src = level.url;
    probe
      .decode()
      .catch(() => {})
      .finally(() => {
        if (item.loadingLevel !== level.k) return;
        img.src = level.url;
        item.shownLevel = level.k;
        item.loadingLevel = -1;
        img.style.background = "";
        counters.imageSwaps++;
      });
  };

  const isVisible = (item: Item, camera: CameraPose): boolean => {
    const halfW = viewport.width / 2 / camera.zoom;
    const halfH = viewport.height / 2 / camera.zoom;
    return (
      item.cx + item.radius >= camera.x - halfW &&
      item.cx - item.radius <= camera.x + halfW &&
      item.cy + item.radius >= camera.y - halfH &&
      item.cy - item.radius <= camera.y + halfH
    );
  };

  /** Writes the matrix that puts the item on screen for the camera. */
  const place = (item: Item, camera: CameraPose) => {
    const e = item.el;
    const z = camera.zoom;
    // Scale from the item's layout units to screen pixels.
    const base = e.kind === "text" ? item.baseZoom : 1;
    const s = z / base;
    const a = item.cos * s;
    const b = item.sin * s;
    // Centre on screen, computed relative to the camera in float64.
    const sx = (item.cx - camera.x) * z + viewport.width / 2;
    const sy = (item.cy - camera.y) * z + viewport.height / 2;
    const w = e.width * base;
    const h = e.height * base;
    const tx = sx - (a * w - b * h) / 2;
    const ty = sy - (b * w + a * h) / 2;
    const m = `matrix(${a},${b},${-b},${a},${tx},${ty})`;
    if (m !== item.matrix) {
      item.node!.style.transform = m;
      item.matrix = m;
    }
  };

  const engine: DomEngine = {
    name: options.name,

    async load(setup: EngineSetup) {
      container = setup.container;
      viewport = setup.viewport;
      reportTextSharp = setup.reportTextSharp;
      for (const asset of setup.scene.assets) assets.set(asset.id, asset);
      images = new ImageLevels(setup.images);
      items = setup.scene.elements.map((el, index) => {
        const angle = (el.rotation * Math.PI) / 180;
        const item: Item = {
          el,
          index,
          cos: Math.cos(angle),
          sin: Math.sin(angle),
          radius: Math.hypot(el.width, el.height) / 2,
          cx: el.x + el.width / 2,
          cy: el.y + el.height / 2,
          node: undefined,
          attached: false,
          visible: false,
          baseZoom: 0,
          shownLevel: -1,
          loadingLevel: -1,
          matrix: "",
        };
        byId.set(el.id, item);
        return item;
      });
      if (mode === "layer") {
        world = document.createElement("div");
        world.style.position = "absolute";
        world.style.left = "0";
        world.style.top = "0";
        world.style.transformOrigin = "0 0";
        container.append(world);
      }
      if (cull !== "detach") {
        // Everything attached from the start; "display" hides what is off screen.
        for (const item of items) {
          attach(item);
          if (cull === "display") item.node!.style.display = "none";
        }
      }
      if (options.awaitFirstImages ?? true) {
        // The first pose of the camera run shows the whole scene: decode the small
        // levels of every visible image before the run starts, as a real program
        // would show thumbnails before it starts presenting.
        const first = setup.scene.bounds;
        const pose: CameraPose = {
          x: first.x + first.width / 2,
          y: first.y + first.height / 2,
          zoom: Math.min(viewport.width / first.width, viewport.height / first.height),
        };
        for (const item of items) {
          if (item.el.kind !== "image") continue;
          const asset = assets.get(item.el.assetId)!;
          images.request(
            asset,
            wantedLevel(asset, item.el.width * pose.zoom * viewport.devicePixelRatio),
            0,
          );
        }
        await images.idle();
      }
      images.onLevel = () => {
        // Picked up in the next render(); nothing to do here.
      };
    },

    render(camera: CameraPose) {
      if (container === undefined || images === undefined) return;
      frame++;
      images.tick();
      const moving = !sameCamera(previous, camera);
      previous = camera;
      lastCamera = camera;
      const z = camera.zoom;
      let visibleCount = 0;
      const wantedAssets = new Set<string>();

      if (mode === "layer" && world !== undefined) {
        const tx = viewport.width / 2 - camera.x * z;
        const ty = viewport.height / 2 - camera.y * z;
        world.style.transform = `matrix(${z},0,0,${z},${tx},${ty})`;
        if (options.willChange === "motion") {
          if (moving && !worldMoving) {
            world.style.willChange = "transform";
            worldMoving = true;
          } else if (!moving && worldMoving) {
            world.style.willChange = "";
            worldMoving = false;
          }
        }
      }

      // Visibility, attach and detach, placement.
      const pendingText: Item[] = [];
      for (const item of items) {
        const visible = isVisible(item, camera) || item === editing;
        if (visible) {
          visibleCount++;
          attach(item);
          const e = item.el;
          if (mode !== "layer") {
            if (e.kind === "text") {
              if (mode === "screen" || item.baseZoom === 0) {
                if (item.baseZoom !== z) layoutText(item, z);
              } else if (item.baseZoom !== z) {
                pendingText.push(item);
              }
            }
            place(item, camera);
          }
          if (e.kind === "image") {
            wantedAssets.add(e.assetId);
            // Images nearer the centre of the view first.
            const dx = (item.cx - camera.x) * z;
            const dy = (item.cy - camera.y) * z;
            updateImage(item, z, Math.hypot(dx, dy));
          }
        } else if (item.visible) {
          detach(item);
        }
        item.visible = visible;
      }
      images.prune(wantedAssets);
      counters.maxVisible = Math.max(counters.maxVisible, visibleCount);

      // "element" mode: lay out text again, within the time budget. Moving: only
      // text scaled by more than a factor of two from its layout. Still: all.
      let textLeft = 0;
      if (mode === "element" && pendingText.length > 0) {
        const start = performance.now();
        const due = moving
          ? pendingText.filter((item) => {
              const ratio = z / item.baseZoom;
              return ratio > 2 || ratio < 0.5;
            })
          : pendingText;
        // Largest on screen first: they show blur most.
        due.sort(
          (a, b) =>
            (b.el as TextElement).fontSize * b.el.width -
            (a.el as TextElement).fontSize * a.el.width,
        );
        let done = 0;
        for (const item of due) {
          if (done > 0 && performance.now() - start > budgetMs) break;
          layoutText(item, z);
          place(item, camera);
          done++;
        }
        textLeft = due.length - done;
      }
      if (moving || textLeft > 0) settledFrame = -1;
      else if (settledFrame === -1) settledFrame = frame;

      // Report sharp text one frame after the frame that left it laid out at the
      // final zoom (or, in "layer" mode, that removed will-change): by the time
      // this callback runs, the browser has painted and committed that frame. The
      // engine cannot see rasterisation, so this is a proxy; the screenshots in
      // the results check it.
      if (!moving && settledFrame >= 0 && frame > settledFrame) reportTextSharp();
    },

    dispose() {
      // Keep the counters for scripts that read them after a benchmark run.
      (globalThis as { protoDomLastStats?: Record<string, number> }).protoDomLastStats =
        engine.stats();
      images?.dispose();
      images = undefined;
      for (const item of items) item.node?.remove();
      world?.remove();
      world = undefined;
      items = [];
      byId.clear();
      container = undefined;
      editing = undefined;
      reportTextSharp = () => {};
    },

    beginEdit(id: string) {
      const item = byId.get(id);
      if (item === undefined || item.el.kind !== "text") return undefined;
      if (editing !== undefined && editing !== item) engine.endEdit();
      if (item.node === undefined) attach(item);
      const node = item.node as HTMLElement;
      // plaintext-only keeps pasted text plain; Firefox before 136 lacks it.
      node.contentEditable = "plaintext-only";
      if (node.contentEditable !== "plaintext-only") node.contentEditable = "true";
      node.style.outline = "none";
      node.style.cursor = "text";
      node.spellcheck = false;
      node.addEventListener("input", onInput);
      editing = item;
      node.focus();
      if (lastCamera !== undefined && mode !== "layer") {
        layoutText(item, lastCamera.zoom);
        place(item, lastCamera);
      }
      return node;
    },

    endEdit() {
      if (editing === undefined) return;
      const node = editing.node as HTMLElement;
      node.removeEventListener("input", onInput);
      texts.set(editing.el.id, node.innerText);
      node.contentEditable = "false";
      node.blur();
      editing = undefined;
    },

    textOf(id: string) {
      const item = byId.get(id);
      if (item === undefined || item.el.kind !== "text") return undefined;
      if (item === editing) return (item.node as HTMLElement).innerText;
      return texts.get(id) ?? item.el.text;
    },

    stats() {
      return {
        ...counters,
        imageDecodes: images?.stats.decodes ?? 0,
        imageDecodeMs: Math.round(images?.stats.decodeMs ?? 0),
        imageEvictions: images?.stats.evictions ?? 0,
        imageCachedPixels: images?.pixels ?? 0,
        imagePending: images?.pending ?? 0,
        attached: items.filter((i) => i.attached).length,
      };
    },
  };

  function onInput(this: HTMLElement) {
    const id = this.dataset["id"];
    if (id !== undefined) texts.set(id, this.innerText);
  }

  return engine;
}
