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
import type { DomTextEngine } from "./text-dom.ts";
import {
  BAR_BELOW_PX,
  ladderSize,
  layoutText,
  RichTextLayout,
  type FontFamilies,
  type LayoutCache,
  type LayoutFragment,
  type TextMeasurer,
} from "./text.ts";
import { intersection, localBoundsOf, translate, type Matrix } from "./transform.ts";

/** The last stretch of each fragment drawn (CanvasDrawContext.#fit). */
const fits = new WeakMap<LayoutFragment, { readonly px: number; readonly ratio: number }>();

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
  /** The browser's text layout, where there is a document (text-dom.ts). */
  readonly textEngine?: DomTextEngine | null;
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
  #skipText = false;
  readonly counters: FrameCounters;

  constructor(env: DrawEnvironment, counters: FrameCounters) {
    this.#env = env;
    this.counters = counters;
    this.#matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    this.#scale = 1;
    this.#detail = "full";
  }

  /** Prepares the context for the next element. */
  begin(matrix: Matrix, scale: number, detail: DetailLevel, skipText = false): void {
    this.#matrix = matrix;
    this.#scale = scale;
    this.#detail = detail;
    this.#skipText = skipText;
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
    // Width the whole image would have on screen at the larger of the two
    // scales (a squeezed image needs the version its taller side asks for).
    const naturalW = natural?.w ?? 0;
    const naturalH = natural?.h ?? 0;
    const shownW = dest.w * this.#scale;
    const shownH = dest.h * this.#scale;
    const pixels =
      naturalW > 0 && naturalH > 0
        ? Math.max(shownW / (crop?.w ?? naturalW), shownH / (crop?.h ?? naturalH)) *
          naturalW
        : shownW;
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
    if (!(style.fontSize > 0) || !Number.isFinite(style.fontSize))
      return new RichTextLayout({ lines: [], width, height: 0, fontSize: 0, color: style.color });
    return env.layouts.get(content, style, width, () =>
      env.textEngine
        ? env.textEngine.layout(content, style, width)
        : layoutText(env.measurer, env.families, content, style, width),
    );
  }

  drawText(layout: TextLayout, x: number, y: number): void {
    if (!(layout instanceof RichTextLayout) || layout.lineCount === 0) return;
    // The element's text is being edited in place: the editing element shows it.
    if (this.#skipText) return;
    const env = this.#env;
    const state = env.state;
    const ctx = state.ctx;
    const m = translate(this.#matrix, x, y);
    const s = this.#scale;
    const fontPx = layout.fontSize * s;
    if (fontPx < BAR_BELOW_PX) {
      this.#drawBars(layout, m);
      return;
    }
    // Lines that can be seen.
    const before = this.#matrix;
    this.#matrix = m;
    const view = this.#localView(fontPx);
    this.#matrix = before;
    // A font from the ladder; the rest of the scale goes into the matrix.
    const drawPx = ladderSize(fontPx);
    const k = fontPx / drawPx;
    const cos = (m.a / s) * k;
    const sin = (m.b / s) * k;
    const draw = (f: LayoutFragment, baseline: number): void => {
      if (f.x > view.x + view.w || f.x + f.width < view.x) return;
      state.font(`${f.prefix}${drawPx}px ${f.family}`);
      state.fill(f.color);
      const fit = this.#fit(f, drawPx, s, k);
      state.transform(
        cos * fit,
        sin * fit,
        -sin,
        cos,
        m.a * f.x + m.c * baseline + m.e,
        m.b * f.x + m.d * baseline + m.f,
      );
      ctx.fillText(f.text, 0, 0);
      this.counters.fillText++;
    };
    for (const line of layout.lines) {
      if (line.top > view.y + view.h || line.top + line.height < view.y) continue;
      if (line.marker) draw(line.marker, line.baseline);
      for (const f of line.fragments) draw(f, line.baseline);
    }
  }

  /**
   * How much wider a fragment must be drawn than the canvas sets it at
   * `drawPx`, so that it is as wide as the layout says. The canvas's glyph
   * advances at a small size are hinted and differ from the layout's (made at
   * the reference size), most at small sizes; stretching the fragment by that
   * keeps every fragment where the editing element shows it. Remembered per
   * fragment for the last font size.
   */
  #fit(f: LayoutFragment, drawPx: number, s: number, k: number): number {
    const known = fits.get(f);
    if (known !== undefined && known.px === drawPx) return known.ratio;
    const ctx = this.#env.state.ctx as Partial<{ measureText(t: string): { width: number } }>;
    let ratio = 1;
    if (typeof ctx.measureText === "function" && f.width > 0) {
      // measureText is at drawPx (the font just set); the matrix scales it by k.
      const drawn = ctx.measureText(f.text).width * k;
      if (drawn > 0) ratio = (f.width * s) / drawn;
    }
    if (!(ratio > 0.5 && ratio < 2)) ratio = 1;
    fits.set(f, { px: drawPx, ratio });
    return ratio;
  }

  /** Text too small to read: bars where the lines are, or one faint block. */
  #drawBars(layout: RichTextLayout, m: Matrix): void {
    const state = this.#env.state;
    const ctx = state.ctx;
    const s = this.#scale;
    this.counters.textBars++;
    state.fill(layout.color);
    state.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    const alpha = state.alpha;
    const lh = layout.lines[0]?.height ?? 0;
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
      for (const line of layout.lines)
        if (line.width > 0)
          ctx.fillRect(line.x, line.top + line.height * 0.3, line.width, line.height * 0.4);
    }
    state.setAlpha(alpha);
  }

  t(label: Label, values?: MessageValues): string {
    return this.#env.t(label, values);
  }
}
