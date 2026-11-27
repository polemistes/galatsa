// SPDX-License-Identifier: GPL-3.0-or-later

// Simple text: plain text broken into lines once, at a reference size, and drawn
// with fillText at its size on screen. Full text layout (rich text, the browser's
// line breaking, bundled fonts) and in-place editing come later behind the same
// DrawContext calls; see docs/adr/0004.
//
// Line breaks are computed from widths measured at REFERENCE_SIZE and scaled, so
// a text box wraps the same way at every zoom. Only spaces and tabs break lines;
// a word wider than the box breaks between grapheme clusters.
//
// Drawing: the font is set from a ladder of sizes (FONT_STEPS per octave) and the
// rest of the scale goes into the canvas matrix. The glyphs are still rasterised
// at their final size on screen, but the canvas sees only a few distinct font
// strings, however the zoom changes. A new font size on every frame was the slow
// drawing path in WebKitGTK (docs/adr/0004, "The slow drawing path in WebKitGTK").

import type { TextContent, TextLayout, TextStyle } from "@galatsa/extension-api";

/** Font size, in pixels, at which widths are measured. */
export const REFERENCE_SIZE = 100;
/** Distinct font sizes per doubling of size that the canvas is given. */
export const FONT_STEPS = 4;
/** Text whose font is smaller than this many device pixels is drawn as bars. */
export const BAR_BELOW_PX = 4;
/** Largest font size given to the canvas; larger text is scaled by the matrix. */
const MAX_FONT_PX = 1024;

/** Measures text widths. The renderer uses the canvas; tests use an estimate. */
export interface TextMeasurer {
  /** Width of `text` in `font` (a CSS font string at REFERENCE_SIZE), in pixels. */
  width(font: string, text: string): number;
}

/** A measurer over a 2D context's measureText. */
export function canvasMeasurer(ctx: {
  font: string;
  measureText(text: string): { width: number };
}): TextMeasurer {
  let current = "";
  return {
    width(font, text) {
      if (font !== current) {
        ctx.font = font;
        current = font;
      }
      return ctx.measureText(text).width;
    },
  };
}

/** An estimate for environments without a canvas: 0.55 em per character. */
export const estimateMeasurer: TextMeasurer = {
  width(font, text) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? REFERENCE_SIZE);
    return [...text].length * size * 0.55;
  },
};

/** Generic family names and the CSS families they stand for. */
export type FontFamilies = Readonly<Record<string, string>>;

export const DEFAULT_FAMILIES: FontFamilies = {
  sans: "sans-serif",
  "sans-serif": "sans-serif",
  serif: "serif",
  mono: "monospace",
  monospace: "monospace",
};

/** One laid-out line. */
export interface Line {
  readonly text: string;
  /** Left edge from the layout's left edge, after alignment, in world units. */
  readonly x: number;
  /** Width without trailing spaces, in world units. */
  readonly width: number;
}

/** The renderer's text layout. Element types see only the TextLayout fields. */
export class SimpleTextLayout implements TextLayout {
  readonly width: number;
  readonly height: number;
  readonly lineCount: number;
  readonly lines: readonly Line[];
  /** Start of the CSS font string: style and weight. */
  readonly fontPrefix: string;
  /** End of the CSS font string: the family. */
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  /** Baseline below the top of a line, in world units. */
  readonly baseline: number;
  readonly color: string;

  constructor(fields: {
    lines: readonly Line[];
    fontPrefix: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    baseline: number;
    color: string;
    boxWidth: number;
  }) {
    this.lines = fields.lines;
    this.fontPrefix = fields.fontPrefix;
    this.fontFamily = fields.fontFamily;
    this.fontSize = fields.fontSize;
    this.lineHeight = fields.lineHeight;
    this.baseline = fields.baseline;
    this.color = fields.color;
    this.lineCount = fields.lines.length;
    this.height = fields.lines.length * fields.lineHeight;
    this.width = fields.boxWidth;
  }

  /** The CSS font for a size in pixels. */
  font(px: number): string {
    return `${this.fontPrefix}${px}px ${this.fontFamily}`;
  }
}

/** Plain text of text content (rich text runs joined, embeds left out). */
export function plainText(content: TextContent): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const run of content.delta) if (typeof run.insert === "string") out += run.insert;
  return out;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Lays text out. Pure apart from measuring; the renderer caches the result. */
export function layoutText(
  measurer: TextMeasurer,
  families: FontFamilies,
  content: TextContent,
  style: TextStyle,
  boxWidth: number,
): SimpleTextLayout {
  const text = plainText(content);
  const family =
    families[style.fontFamily] ?? `"${style.fontFamily.replace(/"/g, "")}", sans-serif`;
  const prefix = `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} `;
  const referenceFont = `${prefix}${REFERENCE_SIZE}px ${family}`;
  const scale = style.fontSize / REFERENCE_SIZE;
  const cache = new Map<string, number>();
  const w = (s: string): number => {
    if (s.length === 0) return 0;
    let v = cache.get(s);
    if (v === undefined) {
      v = measurer.width(referenceFont, s) * scale;
      cache.set(s, v);
    }
    return v;
  };
  const raw: Array<{ text: string; width: number }> = [];
  for (const paragraph of text.split("\n")) {
    const parts = paragraph.match(/[^ \t]+[ \t]*|[ \t]+/g) ?? [];
    let line = "";
    let lineWidth = 0;
    for (const part of parts) {
      const word = part.replace(/[ \t]+$/, "");
      const wordWidth = w(word);
      if (line !== "" && w(line) + wordWidth > boxWidth) {
        raw.push({ text: line.replace(/[ \t]+$/, ""), width: lineWidth });
        line = "";
      }
      if (line === "" && wordWidth > boxWidth && word.length > 1) {
        // Wider than the box on its own: break between grapheme clusters.
        let chunk = "";
        for (const { segment } of graphemes.segment(word)) {
          if (chunk !== "" && w(chunk + segment) > boxWidth) {
            raw.push({ text: chunk, width: w(chunk) });
            chunk = "";
          }
          chunk += segment;
        }
        line = chunk + part.slice(word.length);
        lineWidth = w(chunk);
        continue;
      }
      lineWidth = w(line) + wordWidth;
      line += part;
    }
    raw.push({
      text: line.replace(/[ \t]+$/, ""),
      width: line.trim() === "" ? 0 : lineWidth,
    });
  }
  const lines: Line[] = raw.map(({ text: t, width }) => ({
    text: t,
    width,
    x:
      style.align === "center"
        ? (boxWidth - width) / 2
        : style.align === "right"
          ? boxWidth - width
          : 0,
  }));
  const lineHeight = style.fontSize * (style.lineHeight ?? 1.2);
  // Baseline: half the leading above an ascent of about 0.8 em.
  const baseline = (lineHeight - style.fontSize) / 2 + style.fontSize * 0.8;
  return new SimpleTextLayout({
    lines,
    fontPrefix: prefix,
    fontFamily: family,
    fontSize: style.fontSize,
    lineHeight,
    baseline,
    color: style.color,
    boxWidth,
  });
}

/**
 * The font size to give the canvas for text of `px` device pixels: the nearest
 * step of the ladder, capped. The caller scales by px / result.
 */
export function ladderSize(px: number): number {
  if (!(px > 0)) return 1;
  const step = 2 ** (Math.round(Math.log2(px) * FONT_STEPS) / FONT_STEPS);
  return Math.min(MAX_FONT_PX, Math.max(1, Math.round(step * 64) / 64));
}

/** A cache of layouts by content, style and width, bounded in size. */
export class LayoutCache {
  readonly #entries = new Map<
    TextContent,
    { readonly layouts: Map<string, SimpleTextLayout>; used: number }
  >();
  #size = 0;
  #clock = 0;
  readonly #limit: number;

  /**
   * Keeps at most `limit` layouts. When it is full, the quarter of the contents
   * used longest ago are dropped, so a document with more text boxes than the
   * limit still keeps what the current frames draw.
   */
  constructor(limit = 20000) {
    this.#limit = Math.max(1, limit);
  }

  get size(): number {
    return this.#size;
  }

  get(
    content: TextContent,
    style: TextStyle,
    width: number,
    make: () => SimpleTextLayout,
  ): SimpleTextLayout {
    const key = `${style.fontFamily}|${style.fontSize}|${style.lineHeight ?? ""}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${style.align}|${style.color}|${width}`;
    let entry = this.#entries.get(content);
    const hit = entry?.layouts.get(key);
    if (entry) entry.used = ++this.#clock;
    if (hit) return hit;
    if (this.#size >= this.#limit) {
      this.#evict();
      entry = this.#entries.get(content);
    }
    if (!entry) {
      entry = { layouts: new Map(), used: ++this.#clock };
      this.#entries.set(content, entry);
    }
    const layout = make();
    entry.layouts.set(key, layout);
    this.#size++;
    return layout;
  }

  /** Drops the quarter of the contents used longest ago. */
  #evict(): void {
    const byAge = [...this.#entries].sort((a, b) => a[1].used - b[1].used);
    const target = Math.floor((this.#limit * 3) / 4);
    for (const [content, entry] of byAge) {
      if (this.#size <= target) break;
      this.#entries.delete(content);
      this.#size -= entry.layouts.size;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#size = 0;
  }
}
