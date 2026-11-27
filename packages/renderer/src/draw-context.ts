// SPDX-License-Identifier: GPL-3.0-or-later

// The DrawContext of docs/adr/0005 (section 3.3) over Canvas 2D. Element types
// draw in their local box; this object holds the box's matrix to device pixels
// (float64, relative to the camera), maps every point itself, clips large
// geometry before it reaches the canvas, picks image versions and draws text at
// its size on screen.

import type { Rect } from "@galatsa/core";
import type {
  Color,
  DetailLevel,
  DrawContext,
  ImageState,
  Label,
  Path,
  StrokeStyle,
  TextContent,
  TextLayout,
  TextStyle,
} from "@galatsa/extension-api";
import type { MessageValues } from "@galatsa/i18n";
import type { CanvasState } from "./canvas.ts";
import type { ImageCache } from "./images.ts";
import { paintPath, RecordedPath } from "./path.ts";
import {
  BAR_BELOW_PX,
  ladderSize,
  layoutText,
  SimpleTextLayout,
  type FontFamilies,
  type LayoutCache,
  type TextMeasurer,
} from "./text.ts";
import { intersection, localBoundsOf, translate, type Matrix } from "./transform.ts";

/** Elements smaller than this many device pixels get detail "box". */
export const BOX_BELOW_PX = 4;
/** Elements smaller than this many device pixels get detail "reduced". */
export const REDUCED_BELOW_PX = 16;

export function detailFor(devicePixels: number): DetailLevel {
  if (devicePixels < BOX_BELOW_PX) return "box";
  if (devicePixels < REDUCED_BELOW_PX) return "reduced";
  return "full";
}

/** What the context needs from the renderer, shared by all elements of a frame. */
export interface DrawEnvironment {
  readonly state: CanvasState;
  /** Visible device rectangle [x0, y0, x1, y1]. */
  readonly view: readonly number[];
  readonly images: ImageCache | null;
  /** Natural pixel size of an image asset, if known. */
  imageSize(asset: string): { w: number; h: number } | undefined;
  readonly measurer: TextMeasurer;
  readonly families: FontFamilies;
  readonly layouts: LayoutCache;
  t(label: Label, values?: MessageValues): string;
}

/** Counters for one frame. */
export interface FrameCounters {
  fillText: number;
  textBars: number;
  images: number;
  /** An image was drawn from another version than the right one, or not at all yet. */
  imagesIncomplete: boolean;
}

export class CanvasDrawContext implements DrawContext {
  readonly #env: DrawEnvironment;
  #matrix: Matrix;
  #scale: number;
  #detail: DetailLevel;
  readonly counters: FrameCounters;

  constructor(env: DrawEnvironment, counters: FrameCounters) {
    this.#env = env;
    this.counters = counters;
    this.#matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    this.#scale = 1;
    this.#detail = "full";
  }

  /** Prepares the context for the next element. */
  begin(matrix: Matrix, scale: number, detail: DetailLevel): void {
    this.#matrix = matrix;
    this.#scale = scale;
    this.#detail = detail;
  }

  get matrix(): Matrix {
    return this.#matrix;
  }

  get scale(): number {
    return this.#scale;
  }

  get detail(): DetailLevel {
    return this.#detail;
  }

  createPath(): Path {
    return new RecordedPath();
  }

  fill(path: Path, color: Color): void {
    if (!(path instanceof RecordedPath)) return;
    paintPath(
      this.#env.state,
      path,
      this.#matrix,
      { kind: "fill", color },
      this.#env.view,
    );
  }

  stroke(path: Path, style: StrokeStyle): void {
    if (!(path instanceof RecordedPath) || !(style.width > 0)) return;
    paintPath(
      this.#env.state,
      path,
      this.#matrix,
      { kind: "stroke", style },
      this.#env.view,
    );
  }

  withOpacity(alpha: number, draw: () => void): void {
    const state = this.#env.state;
    const before = state.alpha;
    const a = Math.min(1, Math.max(0, alpha));
    if (a === 0) return;
    state.setAlpha(before * a);
    try {
      draw();
    } finally {
      state.setAlpha(before);
    }
  }

  withClip(path: Path, draw: () => void): void {
    if (!(path instanceof RecordedPath)) return;
    const state = this.#env.state;
    state.save();
    try {
      // A clip path entirely outside the view leaves nothing to draw.
      if (paintPath(state, path, this.#matrix, { kind: "clip" }, this.#env.view)) draw();
    } finally {
      state.restore();
    }
  }

  withOffset(x: number, y: number, draw: () => void): void {
    const before = this.#matrix;
    this.#matrix = translate(before, x, y);
    try {
      draw();
    } finally {
      this.#matrix = before;
    }
  }

  /** The visible device rectangle in the current local coordinates. */
  #localView(margin: number): Rect {
    const v = this.#env.view;
    return localBoundsOf(this.#matrix, {
      x: v[0]! - margin,
      y: v[1]! - margin,
      w: v[2]! - v[0]! + 2 * margin,
      h: v[3]! - v[1]! + 2 * margin,
    });
  }

  drawImage(asset: string, dest: Rect, options?: { readonly crop?: Rect }): ImageState {
    const env = this.#env;
    if (!env.images || !(dest.w > 0) || !(dest.h > 0)) return "missing";
    const natural = env.imageSize(asset);
    const crop = options?.crop;
    // Width of the whole image on screen, which decides the version.
    const naturalW = natural?.w ?? 0;
    const shownW = dest.w * this.#scale;
    const pixels = crop && naturalW > 0 ? (shownW * naturalW) / crop.w : shownW;
    const picked = env.images.pick(asset, pixels);
    this.counters.images++;
    if (picked.state !== "drawn") {
      this.counters.imagesIncomplete = true;
      return picked.state;
    }
    if (!picked.exact) this.counters.imagesIncomplete = true;
    const d = picked.decoded;
    // The part of the image to show, in the decoded version's pixels.
    const fx = naturalW > 0 ? d.width / naturalW : 1;
    const fy = natural && natural.h > 0 ? d.height / natural.h : 1;
    const src = crop
      ? { x: crop.x * fx, y: crop.y * fy, w: crop.w * fx, h: crop.h * fy }
      : { x: 0, y: 0, w: d.width, h: d.height };
    // Only the part of the destination that can be seen, so the canvas never
    // gets a large rectangle at deep zoom.
    const visible = intersection(dest, this.#localView(2));
    if (!visible || !(visible.w > 0) || !(visible.h > 0)) return "drawn";
    const sx = src.x + ((visible.x - dest.x) / dest.w) * src.w;
    const sy = src.y + ((visible.y - dest.y) / dest.h) * src.h;
    const sw = (visible.w / dest.w) * src.w;
    const sh = (visible.h / dest.h) * src.h;
    if (!(sw > 0) || !(sh > 0)) return "drawn";
    const m = translate(this.#matrix, visible.x, visible.y);
    env.state.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    env.state.ctx.drawImage(d.image, sx, sy, sw, sh, 0, 0, visible.w, visible.h);
    return "drawn";
  }

  layoutText(content: TextContent, style: TextStyle, width: number): TextLayout {
    const env = this.#env;
    return env.layouts.get(content, style, width, () =>
      layoutText(env.measurer, env.families, content, style, width),
    );
  }

  drawText(layout: TextLayout, x: number, y: number): void {
    if (!(layout instanceof SimpleTextLayout) || layout.lineCount === 0) return;
    const env = this.#env;
    const state = env.state;
    const ctx = state.ctx;
    const m = translate(this.#matrix, x, y);
    const s = this.#scale;
    const fontPx = layout.fontSize * s;
    const lh = layout.lineHeight;
    state.fill(layout.color);
    if (fontPx < BAR_BELOW_PX) {
      // Too small to read: bars where the lines are, or one faint block.
      this.counters.textBars++;
      state.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      const alpha = state.alpha;
      if (lh * s < 2) {
        let left = Infinity;
        let right = -Infinity;
        for (const line of layout.lines) {
          if (line.width <= 0) continue;
          left = Math.min(left, line.x);
          right = Math.max(right, line.x + line.width);
        }
        if (right > left) {
          state.setAlpha(alpha * 0.2);
          ctx.fillRect(left, 0, right - left, layout.height);
        }
      } else {
        state.setAlpha(alpha * 0.35);
        layout.lines.forEach((line, i) => {
          if (line.width > 0)
            ctx.fillRect(line.x, i * lh + lh * 0.3, line.width, lh * 0.4);
        });
      }
      state.setAlpha(alpha);
      return;
    }
    // Lines that can be seen.
    const view = (() => {
      const before = this.#matrix;
      this.#matrix = m;
      const v = this.#localView(fontPx);
      this.#matrix = before;
      return v;
    })();
    const first = Math.max(0, Math.floor(view.y / lh));
    const last = Math.min(layout.lineCount - 1, Math.floor((view.y + view.h) / lh));
    if (last < first) return;
    // A font from the ladder; the rest of the scale goes into the matrix.
    const drawPx = ladderSize(fontPx);
    const k = fontPx / drawPx;
    const cos = (m.a / s) * k;
    const sin = (m.b / s) * k;
    state.font(layout.font(drawPx));
    for (let i = first; i <= last; i++) {
      const line = layout.lines[i]!;
      if (line.width <= 0 || line.x > view.x + view.w || line.x + line.width < view.x)
        continue;
      const ly = i * lh + layout.baseline;
      state.transform(
        cos,
        sin,
        -sin,
        cos,
        m.a * line.x + m.c * ly + m.e,
        m.b * line.x + m.d * ly + m.f,
      );
      ctx.fillText(line.text, 0, 0);
      this.counters.fillText++;
    }
  }

  t(label: Label, values?: MessageValues): string {
    return this.#env.t(label, values);
  }
}
