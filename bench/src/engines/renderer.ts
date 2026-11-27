// SPDX-License-Identifier: GPL-3.0-or-later

// The real renderer (@galatsa/renderer) as a bench engine. The scene becomes a
// document snapshot of extension elements of three bench types (shape, text,
// image) that draw through the renderer's DrawContext, as extensions do in the
// program. Images use the reduced versions the bench generated with the
// originals (ImageSource.getReduced), so loading decodes only the smallest
// version of each image and never an original.

import type { Element, ElementData, ElementId } from "@galatsa/core";
import {
  defineElementView,
  defineViewExtension,
  EXTENSION_API_VERSION,
  ViewHost,
  type Label,
  type ViewExtension,
} from "@galatsa/extension-api";
import {
  CanvasRenderer,
  sceneFromSnapshot,
  type DecoderKind,
  type ImageCacheStats,
  type ImageSource as RendererImages,
  type RenderStats,
} from "@galatsa/renderer";
import type { BenchEngine, BenchViewport, ImageSource } from "../engine.ts";
import type { Scene } from "../scene.ts";

const SHAPE = "bench/shape";
const TEXT = "bench/text";
const IMAGE = "bench/image";
const LABEL = "common:bench" as Label;

function str(data: ElementData, key: string, fallback: string): string {
  const v = data[key];
  return typeof v === "string" ? v : fallback;
}
function num(data: ElementData, key: string, fallback: number): number {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function nullableColor(data: ElementData, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : null;
}

interface ShapeModel {
  readonly shape: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly opacity: number;
}

interface TextModel {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly lineHeight: number;
  readonly color: string;
  readonly align: "left" | "center" | "right";
  readonly opacity: number;
}

interface ImageModel {
  readonly asset: string;
  readonly opacity: number;
}

/** The bench's element types, as one viewing extension. */
export const benchExtension: ViewExtension = defineViewExtension({
  id: "bench",
  version: "0.0.0",
  api: EXTENSION_API_VERSION,
  elementTypes: [
    defineElementView<ShapeModel>({
      name: "shape",
      label: LABEL,
      typeVersion: 1,
      read: (data) => ({
        shape: str(data, "shape", "rect"),
        fill: nullableColor(data, "fill"),
        stroke: nullableColor(data, "stroke"),
        strokeWidth: num(data, "strokeWidth", 0),
        opacity: num(data, "opacity", 1),
      }),
      bounds: (m, box) => {
        const pad = m.stroke !== null ? m.strokeWidth / 2 : 0;
        return { x: -pad, y: -pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
      },
      draw(m, ctx, box) {
        const path = ctx.createPath();
        const { w, h } = box;
        switch (m.shape) {
          case "ellipse":
            path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
            break;
          case "triangle":
            path.moveTo(w / 2, 0);
            path.lineTo(w, h);
            path.lineTo(0, h);
            path.closePath();
            break;
          case "line":
            path.moveTo(0, 0);
            path.lineTo(w, h);
            break;
          default:
            path.rect(0, 0, w, h);
        }
        ctx.withOpacity(m.opacity, () => {
          if (m.fill !== null && m.shape !== "line") ctx.fill(path, m.fill);
          if (m.stroke !== null)
            ctx.stroke(path, { color: m.stroke, width: m.strokeWidth });
        });
      },
    }),
    defineElementView<TextModel>({
      name: "text",
      label: LABEL,
      typeVersion: 1,
      read: (data) => {
        const align = str(data, "align", "left");
        return {
          text: str(data, "text", ""),
          fontFamily: str(data, "fontFamily", "sans-serif"),
          fontSize: num(data, "fontSize", 16),
          bold: data["bold"] === true,
          lineHeight: num(data, "lineHeight", 1.2),
          color: str(data, "color", "#000"),
          align: align === "center" || align === "right" ? align : "left",
          opacity: num(data, "opacity", 1),
        };
      },
      draw(m, ctx, box) {
        const layout = ctx.layoutText(
          m.text,
          {
            fontFamily: m.fontFamily,
            fontSize: m.fontSize,
            color: m.color,
            align: m.align,
            lineHeight: m.lineHeight,
            bold: m.bold,
          },
          box.w,
        );
        ctx.withOpacity(m.opacity, () => ctx.drawText(layout, 0, 0));
      },
    }),
    defineElementView<ImageModel>({
      name: "image",
      label: LABEL,
      typeVersion: 1,
      read: (data) => ({
        asset: str(data, "asset", ""),
        opacity: num(data, "opacity", 1),
      }),
      draw(m, ctx, box) {
        let state = "missing";
        ctx.withOpacity(m.opacity, () => {
          state = ctx.drawImage(m.asset as `sha256-${string}`, {
            x: 0,
            y: 0,
            w: box.w,
            h: box.h,
          });
        });
        if (state !== "drawn") {
          const p = ctx.createPath();
          p.rect(0, 0, box.w, box.h);
          ctx.fill(p, "#d8d8d8");
        }
      },
    }),
  ],
});

/** The scene as document elements, in paint order. */
export function sceneElements(scene: Scene): { [id: ElementId]: Element } {
  const elements: { [id: ElementId]: Element } = {};
  scene.elements.forEach((e, index) => {
    let type: string;
    let data: ElementData;
    if (e.kind === "shape") {
      type = SHAPE;
      data = {
        shape: e.shape,
        fill: e.fill,
        stroke: e.stroke,
        strokeWidth: e.strokeWidth,
        opacity: e.opacity,
      };
    } else if (e.kind === "text") {
      type = TEXT;
      data = {
        text: e.text,
        fontFamily: e.fontFamily,
        fontSize: e.fontSize,
        bold: e.fontWeight === 700,
        lineHeight: e.lineHeight,
        color: e.color,
        align: e.align,
        opacity: e.opacity,
      };
    } else {
      type = IMAGE;
      data = { asset: e.assetId, opacity: e.opacity };
    }
    elements[e.id] = {
      type,
      typeVersion: 1,
      parent: null,
      order: `a${String(index).padStart(6, "0")}`,
      pos: { x: e.x, y: e.y, space: null },
      rebase: null,
      name: "",
      locked: false,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [],
      ext: {},
      data,
      size: { w: e.width, h: e.height },
      rot: (e.rotation * Math.PI) / 180,
    };
  });
  return elements;
}

/** The bench's images as the renderer's image source: reduced versions, then the original. */
function rendererImages(scene: Scene, images: ImageSource): RendererImages {
  const sizes = new Map(scene.assets.map((a) => [a.id, a] as const));
  return {
    levels(asset) {
      const original = sizes.get(asset);
      if (!original) return undefined;
      const reduced = images.getReduced?.(asset) ?? [];
      return [
        ...reduced.map((r) => ({ width: r.width, height: r.height })),
        { width: original.width, height: original.height },
      ];
    },
    blob(asset, level) {
      const reduced = images.getReduced?.(asset) ?? [];
      return level < reduced.length ? reduced[level]!.blob : images.getBlob(asset);
    },
  };
}

export interface RendererEngine extends BenchEngine {
  /** Counters of the last frame, kept after dispose(). */
  readonly stats: RenderStats | null;
  /** Image decoding counters, kept after dispose(). */
  readonly imageStats: ImageCacheStats | null;
  readonly decoder: string;
}

export interface RendererEngineOptions {
  /** How images are decoded; default what the browser supports best. */
  readonly decoder?: DecoderKind;
}

export function createRendererEngine(
  options: RendererEngineOptions = {},
): RendererEngine {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: CanvasRenderer | undefined;
  let viewport: BenchViewport = { width: 0, height: 0, devicePixelRatio: 1 };
  let reportTextSharp = (): void => {};
  let decoder = "";
  let lastStats: RenderStats | null = null;
  let lastImageStats: ImageCacheStats | null = null;

  return {
    name: "renderer",
    get stats() {
      return renderer ? { ...renderer.stats } : lastStats;
    },
    get imageStats() {
      const images = renderer?.images;
      return images ? { ...images.stats } : lastImageStats;
    },
    get decoder() {
      return decoder;
    },
    async load(setup) {
      viewport = setup.viewport;
      reportTextSharp = setup.reportTextSharp;
      const dpr = viewport.devicePixelRatio;
      canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.style.display = "block";
      setup.container.append(canvas);
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("No 2D canvas context");
      const host = new ViewHost();
      const problems = host.load([benchExtension]);
      if (problems.length > 0) throw new Error(problems.map((p) => p.detail).join("; "));
      renderer = new CanvasRenderer({
        host,
        images: rendererImages(setup.scene, setup.images),
        imageOptions: options.decoder ? { decoder: options.decoder } : {},
        background: "#ffffff",
      });
      decoder = renderer.images?.decoderKind ?? "";
      renderer.attach(ctx, viewport);
      renderer.setScene(sceneFromSnapshot({ elements: sceneElements(setup.scene) }));
      // The smallest version of every image, as a viewer that opens a document.
      await renderer.images?.preload(setup.scene.assets.map((a) => a.id));
    },
    render(camera) {
      if (!renderer) return;
      renderer.setCamera({ space: null, cx: camera.x, cy: camera.y, zoom: camera.zoom });
      renderer.render();
      // Text is drawn with fillText at its size on screen in every frame.
      reportTextSharp();
    },
    snapshot() {
      const source = canvas;
      if (source === undefined) return Promise.reject(new Error("Not loaded"));
      return new Promise<Blob>((resolve, reject) =>
        source.toBlob((blob) =>
          blob !== null ? resolve(blob) : reject(new Error("Snapshot failed")),
        ),
      );
    },
    dispose() {
      if (renderer) {
        lastStats = { ...renderer.stats };
        lastImageStats = renderer.images ? { ...renderer.images.stats } : null;
      }
      renderer?.dispose();
      renderer = undefined;
      canvas?.remove();
      if (canvas !== undefined) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas = undefined;
      reportTextSharp = () => {};
    },
  };
}
