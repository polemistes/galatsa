// SPDX-License-Identifier: GPL-3.0-or-later

// Text layout: rich text broken into lines once per text box, at a reference
// size, and drawn with fillText at its size on screen. See docs/adr/0004 and
// docs/adr/0011-text.md.
//
// Two layout engines give the same structure (RichTextLayout):
//
// - The browser's (text-dom.ts): the text is laid out in a hidden element at
//   REFERENCE_SIZE, and the lines, their baselines and where each run starts
//   are read from it. The in-place editing element is the same element,
//   scaled, so editing shows the same line breaks. Used wherever there is a
//   document.
// - A simple one, here, for environments without a document (tests,
//   workers): widths measured at REFERENCE_SIZE and scaled, lines broken at
//   spaces and tabs, a word wider than the box between grapheme clusters.
//
// Drawing: the font is set from a ladder of sizes (FONT_STEPS per octave) and
// the rest of the scale goes into the canvas matrix. The glyphs are still
// rasterised at their final size on screen, but the canvas sees only a few
// distinct font strings, however the zoom changes. A new font size on every
// frame was the slow drawing path in WebKitGTK (docs/adr/0004).

import type { TextContent, TextLayout, TextStyle } from "@galatsa/extension-api";
import { BUNDLED_FAMILIES, cssFamily, type FontFamilies } from "./fonts.ts";
import {
  contentString,
  fontPrefix,
  LIST_GAP_EM,
  LIST_INDENT_EM,
  parseRichText,
} from "./rich-text.ts";

export type { FontFamilies } from "./fonts.ts";

/**
 * Font size, in pixels, at which text is laid out. Large, because Chromium
 * lays text out with glyph advances rounded to whole pixels: at 100 pixels a
 * line came out 0.3 % wider than the font says, which zoomed in moved glyphs
 * of the editing element several pixels from the drawn ones (measured
 * 2026-11-27, docs/adr/0011-text.md). At 1,000 pixels the rounding is a
 * tenth of that.
 */
export const REFERENCE_SIZE = 1000;
/** Distinct font sizes per doubling of size that the canvas is given. */
export const FONT_STEPS = 4;
/** Text whose font is smaller than this many device pixels is drawn as bars. */
export const BAR_BELOW_PX = 4;
/** Largest font size given to the canvas; larger text is scaled by the matrix. */
const MAX_FONT_PX = 1024;
/** Line height when the style gives none, as a multiple of the font size. */
export const DEFAULT_LINE_HEIGHT = 1.2;

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

/** The default family map: the bundled fonts. */
export const DEFAULT_FAMILIES: FontFamilies = BUNDLED_FAMILIES;

/** Text drawn in one font and colour, on one line. */
export interface LayoutFragment {
  readonly text: string;
  /** Left edge from the layout's left edge, in world units. */
  readonly x: number;
  /** Advance width, in world units. */
  readonly width: number;
  /** Start of the CSS font string: style and weight ("italic 700 "). */
  readonly prefix: string;
  /** End of the CSS font string: the family. */
  readonly family: string;
  readonly color: string;
}

/** One laid-out line. */
export interface Line {
  /** Top of the line box, from the layout's top, in world units. */
  readonly top: number;
  readonly height: number;
  /** Baseline, from the layout's top, in world units. */
  readonly baseline: number;
  /** The visible text's left and right edges (trailing spaces left out). */
  readonly x: number;
  readonly width: number;
  readonly fragments: readonly LayoutFragment[];
  /** A list marker drawn left of the line, on a paragraph's first line. */
  readonly marker: LayoutFragment | null;
  /** The line's characters, fragments joined (for tests and accessibility). */
  readonly text: string;
}

/** The renderer's text layout. Element types see only the TextLayout fields. */
export class RichTextLayout implements TextLayout {
  readonly width: number;
  readonly height: number;
  readonly lineCount: number;
  readonly lines: readonly Line[];
  readonly fontSize: number;
  readonly color: string;
  /** Laid out before its fonts had loaded; not kept, redone when they come. */
  readonly provisional: boolean;

  constructor(fields: {
    lines: readonly Line[];
    width: number;
    height: number;
    fontSize: number;
    color: string;
    provisional?: boolean;
  }) {
    this.lines = fields.lines;
    this.lineCount = fields.lines.length;
    this.width = fields.width;
    this.height = fields.height;
    this.fontSize = fields.fontSize;
    this.color = fields.color;
    this.provisional = fields.provisional ?? false;
  }
}

/** Plain text of text content (rich text runs joined, embeds as U+FFFC). */
export function plainText(content: TextContent): string {
  return contentString(content);
}

/** Line height of a style, in world units. */
export function lineHeightOf(style: TextStyle): number {
  const k = style.lineHeight;
  return (
    style.fontSize *
    (k !== undefined && Number.isFinite(k) && k > 0 ? k : DEFAULT_LINE_HEIGHT)
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A piece of a paragraph with one style, as the simple engine handles it. */
interface Piece {
  readonly text: string;
  readonly prefix: string;
  readonly color: string;
}

/**
 * Lays text out without a document: widths from `measurer` at REFERENCE_SIZE,
 * scaled; lines broken at spaces and tabs. Pure apart from measuring.
 */
export function layoutText(
  measurer: TextMeasurer,
  families: FontFamilies,
  content: TextContent,
  style: TextStyle,
  boxWidth: number,
): RichTextLayout {
  const rich = parseRichText(content);
  const family = cssFamily(families, style.fontFamily);
  const scale = style.fontSize / REFERENCE_SIZE;
  const lh = lineHeightOf(style);
  // Baseline: half the leading above an ascent of about 0.8 em.
  const baselineIn = (lh - style.fontSize) / 2 + style.fontSize * 0.8;
  const cache = new Map<string, number>();
  const w = (prefix: string, s: string): number => {
    if (s.length === 0) return 0;
    const key = prefix + "|" + s;
    let v = cache.get(key);
    if (v === undefined) {
      v = measurer.width(`${prefix}${REFERENCE_SIZE}px ${family}`, s) * scale;
      cache.set(key, v);
    }
    return v;
  };
  const lines: Line[] = [];
  for (const paragraph of rich.paragraphs) {
    const indent = paragraph.list ? LIST_INDENT_EM * style.fontSize : 0;
    const width = Math.max(0, boxWidth - indent);
    // Words with their style pieces; a word may span runs.
    type Word = { pieces: Piece[]; space: Piece[]; width: number; spaceWidth: number };
    const words: Word[] = [];
    let word: Word = { pieces: [], space: [], width: 0, spaceWidth: 0 };
    for (const run of paragraph.runs) {
      const prefix = fontPrefix(style, run);
      const color = run.color ?? style.color;
      for (const part of run.text.match(/[^ \t]+|[ \t]+/g) ?? []) {
        const isSpace = /^[ \t]/.test(part);
        if (!isSpace && word.space.length > 0) {
          words.push(word);
          word = { pieces: [], space: [], width: 0, spaceWidth: 0 };
        }
        const piece = { text: part, prefix, color };
        if (isSpace) {
          word.space.push(piece);
          word.spaceWidth += w(prefix, part);
        } else {
          word.pieces.push(piece);
          word.width += w(prefix, part);
        }
      }
    }
    if (word.pieces.length > 0 || word.space.length > 0 || words.length === 0)
      words.push(word);
    // Fill lines.
    type Pending = { pieces: Piece[]; width: number; trailing: number };
    const rows: Pending[] = [];
    let row: Pending = { pieces: [], width: 0, trailing: 0 };
    const flush = (): void => {
      rows.push(row);
      row = { pieces: [], width: 0, trailing: 0 };
    };
    for (const wd of words) {
      if (row.pieces.length > 0 && row.width + row.trailing + wd.width > width) flush();
      if (row.pieces.length === 0 && wd.width > width && wd.pieces.length > 0) {
        // Wider than the box on its own: break between grapheme clusters.
        for (const piece of wd.pieces) {
          let chunk = "";
          for (const { segment } of graphemes.segment(piece.text)) {
            const next = chunk + segment;
            if (
              row.width + w(piece.prefix, next) > width &&
              (chunk !== "" || row.pieces.length > 0)
            ) {
              if (chunk !== "") {
                row.pieces.push({ ...piece, text: chunk });
                row.width += w(piece.prefix, chunk);
              }
              flush();
              chunk = segment;
            } else chunk = next;
          }
          if (chunk !== "") {
            row.pieces.push({ ...piece, text: chunk });
            row.width += w(piece.prefix, chunk);
          }
        }
      } else {
        row.width += row.trailing + wd.width;
        row.pieces.push(...wd.pieces);
        row.trailing = 0;
      }
      row.pieces.push(...wd.space);
      row.trailing += wd.spaceWidth;
    }
    flush();
    rows.forEach((r, i) => {
      // Trailing spaces hang; alignment uses the visible width.
      const visible = r.width;
      const left =
        indent +
        (style.align === "center"
          ? (width - visible) / 2
          : style.align === "right"
            ? width - visible
            : 0);
      const fragments: LayoutFragment[] = [];
      let x = left;
      for (const piece of r.pieces) {
        const pw = w(piece.prefix, piece.text);
        const last = fragments[fragments.length - 1];
        if (last && last.prefix === piece.prefix && last.color === piece.color)
          fragments[fragments.length - 1] = {
            ...last,
            text: last.text + piece.text,
            width: last.width + pw,
          };
        else
          fragments.push({
            text: piece.text,
            x,
            width: pw,
            prefix: piece.prefix,
            family,
            color: piece.color,
          });
        x += pw;
      }
      const top = lines.length * lh;
      const marker =
        i === 0 && paragraph.marker !== null
          ? markerFragment(paragraph.marker, style, family, w, indent)
          : null;
      lines.push({
        top,
        height: lh,
        baseline: top + baselineIn,
        x: left,
        width: visible,
        fragments,
        marker,
        text: fragments.map((f) => f.text).join(""),
      });
    });
  }
  return new RichTextLayout({
    lines,
    width: boxWidth,
    height: lines.length * lh,
    fontSize: style.fontSize,
    color: style.color,
  });
}

/** A list marker, right-aligned in the indent. */
export function markerFragment(
  text: string,
  style: TextStyle,
  family: string,
  width: (prefix: string, s: string) => number,
  indent: number,
): LayoutFragment {
  const prefix = fontPrefix(style);
  const mw = width(prefix, text);
  return {
    text,
    x: indent - LIST_GAP_EM * style.fontSize - mw,
    width: mw,
    prefix,
    family,
    color: style.color,
  };
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

/** Layouts kept per content (other styles and widths: a resize being dragged). */
const LAYOUTS_PER_CONTENT = 4;
/** Contents kept per element (each edit of a text is a new content). */
const CONTENTS_PER_OWNER = 2;

/**
 * A cache of layouts by content, style and width, bounded in size: in all,
 * per content, and per element (`owner`), so that typing, which makes a new
 * content for every key, or dragging a width, does not fill it with layouts
 * nobody draws again (docs/adr/0011-text.md).
 */
export class LayoutCache {
  readonly #entries = new Map<
    TextContent,
    { readonly layouts: Map<string, RichTextLayout>; used: number }
  >();
  /** The contents of each element, oldest first, and its last layout. */
  readonly #owners = new Map<string, { contents: TextContent[]; last: RichTextLayout }>();
  #size = 0;
  #clock = 0;
  readonly #limit: number;

  /**
   * Keeps at most `limit` layouts. When it is full, the quarter of the contents
   * used longest ago are dropped, so a document with more text boxes than the
   * limit still keeps what the current frames draw. Provisional layouts (made
   * before their fonts loaded) are never kept.
   */
  constructor(limit = 20000) {
    this.#limit = Math.max(1, limit);
  }

  get size(): number {
    return this.#size;
  }

  /** The last layout made or found for an element, if any. */
  last(owner: string): RichTextLayout | undefined {
    return this.#owners.get(owner)?.last;
  }

  get(
    content: TextContent,
    style: TextStyle,
    width: number,
    make: () => RichTextLayout,
    owner?: string,
  ): RichTextLayout {
    const key = `${style.fontFamily}|${style.fontSize}|${style.lineHeight ?? ""}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${style.align}|${style.color}|${width}`;
    let entry = this.#entries.get(content);
    const hit = entry?.layouts.get(key);
    if (entry) entry.used = ++this.#clock;
    if (hit) {
      this.#own(owner, content, hit);
      return hit;
    }
    const layout = make();
    if (layout.provisional) return layout;
    if (this.#size >= this.#limit) {
      this.#evict();
      entry = this.#entries.get(content);
    }
    if (!entry) {
      entry = { layouts: new Map(), used: ++this.#clock };
      this.#entries.set(content, entry);
    }
    entry.layouts.set(key, layout);
    this.#size++;
    if (entry.layouts.size > LAYOUTS_PER_CONTENT) {
      const oldest = entry.layouts.keys().next().value!;
      entry.layouts.delete(oldest);
      this.#size--;
    }
    this.#own(owner, content, layout);
    return layout;
  }

  /** Notes that an element shows `content`; drops its contents beyond the last few. */
  #own(owner: string | undefined, content: TextContent, layout: RichTextLayout): void {
    if (owner === undefined) return;
    let own = this.#owners.get(owner);
    if (!own) {
      own = { contents: [], last: layout };
      this.#owners.set(owner, own);
    }
    own.last = layout;
    if (own.contents[own.contents.length - 1] === content) return;
    own.contents = own.contents.filter((c) => c !== content);
    own.contents.push(content);
    while (own.contents.length > CONTENTS_PER_OWNER) {
      const old = own.contents.shift()!;
      const entry = this.#entries.get(old);
      if (entry) {
        this.#entries.delete(old);
        this.#size -= entry.layouts.size;
      }
    }
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
    // Owners whose last layout went with it keep only a reference to it.
    if (this.#owners.size > this.#limit) this.#owners.clear();
  }

  clear(): void {
    this.#entries.clear();
    this.#owners.clear();
    this.#size = 0;
  }
}
