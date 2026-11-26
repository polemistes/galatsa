// SPDX-License-Identifier: GPL-3.0-or-later

// Text layout in world units, done once per text (and again when it is edited), not
// per frame. Lines are broken greedily at spaces; a word longer than the box is
// broken between grapheme clusters. Widths are measured with canvas measureText at
// a fixed reference size and scaled, so the line breaks do not depend on the zoom
// level: the text wraps the same way at zoom 0.02 and at zoom 40.
//
// Not handled (prototype): bidirectional text (the caret mapping assumes
// left-to-right), the Unicode line breaking algorithm (only spaces and tabs break),
// hyphenation, kerning across word boundaries in the width sum, font fallback
// metrics, and text shaping differences between measureText and fillText at small
// sizes.

/** Font size used for measuring. Widths are scaled linearly from it. */
const REFERENCE_SIZE = 100;

export interface FontSpec {
  readonly family: string;
  readonly weight: number;
}

export interface Line {
  /** Offsets into the full text; `end` includes trailing spaces, not the "\n". */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Left edge from the box's left edge, after alignment (world units). */
  readonly x: number;
  /** Width without trailing spaces (world units). */
  readonly width: number;
}

export interface TextLayout {
  readonly text: string;
  readonly font: FontSpec;
  readonly fontSize: number;
  readonly boxWidth: number;
  readonly align: "left" | "center" | "right";
  readonly lines: readonly Line[];
  /** Distance between baselines (world units). */
  readonly lineHeight: number;
  /** Baseline offset from the top of a line (world units). */
  readonly baseline: number;
  readonly height: number;
  readonly maxLineWidth: number;
}

export function fontString(font: FontSpec, sizePx: number): string {
  return `${font.weight} ${sizePx}px ${font.family}`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Measures strings at the reference size and caches the results. */
export class Measurer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly caches = new Map<string, Map<string, number>>();
  private readonly metrics = new Map<string, { ascent: number; descent: number }>();
  private currentFont = "";
  calls = 0;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("No 2D canvas context");
    applyTextRendering(ctx);
    this.ctx = ctx;
  }

  private use(font: FontSpec): string {
    const key = fontString(font, REFERENCE_SIZE);
    if (key !== this.currentFont) {
      this.ctx.font = key;
      this.currentFont = key;
    }
    return key;
  }

  /** Width of `s` at font size 1 (multiply by the font size). */
  width(font: FontSpec, s: string): number {
    if (s.length === 0) return 0;
    const key = this.use(font);
    let cache = this.caches.get(key);
    if (cache === undefined) {
      cache = new Map();
      this.caches.set(key, cache);
    }
    let w = cache.get(s);
    if (w === undefined) {
      this.calls++;
      w = this.ctx.measureText(s).width / REFERENCE_SIZE;
      // Do not let editing fill the cache with every prefix ever measured.
      if (s.length <= 64) cache.set(s, w);
    }
    return w;
  }

  /** Ascent and descent at font size 1. */
  fontMetrics(font: FontSpec): { ascent: number; descent: number } {
    const key = this.use(font);
    let m = this.metrics.get(key);
    if (m === undefined) {
      const t = this.ctx.measureText("Hg");
      const ascent =
        (t.fontBoundingBoxAscent ?? t.actualBoundingBoxAscent) / REFERENCE_SIZE;
      const descent =
        (t.fontBoundingBoxDescent ?? t.actualBoundingBoxDescent) / REFERENCE_SIZE;
      m = { ascent: ascent || 0.8, descent: descent || 0.2 };
      this.metrics.set(key, m);
    }
    return m;
  }
}

/**
 * Asks for unhinted glyph outlines and fractional advances where the browser
 * supports it, so that widths scale linearly with the font size and the text drawn
 * at screen size matches the layout made at the reference size.
 */
export function applyTextRendering(ctx: CanvasRenderingContext2D): void {
  if ("textRendering" in ctx) ctx.textRendering = "geometricPrecision";
  if ("fontKerning" in ctx) ctx.fontKerning = "normal";
}

interface Segment {
  start: number;
  /** End of the word (before trailing spaces). */
  wordEnd: number;
  end: number;
}

function segmentsOf(text: string, from: number, to: number): Segment[] {
  const out: Segment[] = [];
  const re = /[^ \t]+[ \t]*|[ \t]+/g;
  const part = text.slice(from, to);
  let m: RegExpExecArray | null;
  while ((m = re.exec(part)) !== null) {
    const start = from + m.index;
    const end = start + m[0].length;
    const trimmed = m[0].replace(/[ \t]+$/, "");
    out.push({ start, wordEnd: start + trimmed.length, end });
  }
  return out;
}

export function layoutText(
  measurer: Measurer,
  text: string,
  font: FontSpec,
  fontSize: number,
  boxWidth: number,
  lineHeightFactor: number,
  align: "left" | "center" | "right",
): TextLayout {
  const raw: { start: number; end: number; width: number }[] = [];
  const w = (a: number, b: number) => measurer.width(font, text.slice(a, b)) * fontSize;
  let paraStart = 0;
  while (paraStart <= text.length) {
    let paraEnd = text.indexOf("\n", paraStart);
    if (paraEnd < 0) paraEnd = text.length;
    const segs = segmentsOf(text, paraStart, paraEnd);
    let lineStart = paraStart;
    let advance = 0; // width up to the end of the last segment, with its spaces
    let contentWidth = 0; // width without trailing spaces
    let lineHasContent = false;
    for (const seg of segs) {
      const wordWidth = w(seg.start, seg.wordEnd);
      if (lineHasContent && advance + wordWidth > boxWidth) {
        raw.push({ start: lineStart, end: seg.start, width: contentWidth });
        lineStart = seg.start;
        advance = 0;
        lineHasContent = false;
      }
      if (!lineHasContent && wordWidth > boxWidth && seg.wordEnd > seg.start) {
        // A word wider than the box: break it between grapheme clusters.
        let chunkStart = seg.start;
        let chunkWidth = 0;
        for (const g of graphemes.segment(text.slice(seg.start, seg.wordEnd))) {
          const gStart = seg.start + g.index;
          const gWidth = w(gStart, gStart + g.segment.length);
          if (gStart > chunkStart && chunkWidth + gWidth > boxWidth) {
            raw.push({ start: chunkStart, end: gStart, width: chunkWidth });
            chunkStart = gStart;
            chunkWidth = 0;
          }
          chunkWidth += gWidth;
        }
        lineStart = chunkStart;
        contentWidth = w(chunkStart, seg.wordEnd);
        advance = w(chunkStart, seg.end);
        lineHasContent = true;
        continue;
      }
      contentWidth = advance + wordWidth;
      advance += w(seg.start, seg.end);
      lineHasContent = true;
    }
    raw.push({ start: lineStart, end: paraEnd, width: contentWidth });
    paraStart = paraEnd + 1;
  }
  const lines: Line[] = raw.map((r) => {
    const x =
      align === "left"
        ? 0
        : align === "center"
          ? (boxWidth - r.width) / 2
          : boxWidth - r.width;
    return {
      start: r.start,
      end: r.end,
      text: text.slice(r.start, r.end),
      x,
      width: r.width,
    };
  });
  const { ascent, descent } = measurer.fontMetrics(font);
  const lineHeight = lineHeightFactor * fontSize;
  const baseline = (lineHeight - (ascent + descent) * fontSize) / 2 + ascent * fontSize;
  return {
    text,
    font,
    fontSize,
    boxWidth,
    align,
    lines,
    lineHeight,
    baseline,
    height: lines.length * lineHeight,
    maxLineWidth: lines.reduce((m, l) => Math.max(m, l.width), 0),
  };
}

/** Index of the line that shows the caret at `offset`. */
export function lineIndexOf(layout: TextLayout, offset: number): number {
  const lines = layout.lines;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** X of the caret at `offset` on line `index`, from the box's left edge (world units). */
export function caretX(
  measurer: Measurer,
  layout: TextLayout,
  index: number,
  offset: number,
): number {
  const line = layout.lines[index]!;
  const o = Math.max(line.start, Math.min(line.end, offset));
  return (
    line.x +
    measurer.width(layout.font, layout.text.slice(line.start, o)) * layout.fontSize
  );
}

/** The grapheme boundary on line `index` nearest to `x` (world units from the box's left edge). */
export function offsetAtX(
  measurer: Measurer,
  layout: TextLayout,
  index: number,
  x: number,
): number {
  const line = layout.lines[index]!;
  let best = line.start;
  let bestDistance = Math.abs(line.x - x);
  for (const g of graphemes.segment(line.text)) {
    const o = line.start + g.index + g.segment.length;
    const d = Math.abs(caretX(measurer, layout, index, o) - x);
    if (d < bestDistance) {
      best = o;
      bestDistance = d;
    }
  }
  // A wrapped line's trailing space belongs to it, but the caret after it is drawn
  // at the start of the next line; stay before the break.
  const next = layout.lines[index + 1];
  if (
    next !== undefined &&
    best === line.end &&
    next.start === line.end &&
    best > line.start
  ) {
    best = previousGrapheme(layout.text, best);
  }
  return best;
}

export function previousGrapheme(text: string, offset: number): number {
  let prev = 0;
  for (const g of graphemes.segment(text.slice(0, offset))) prev = g.index;
  return prev;
}

/** Offset of the caret for a point in box coordinates (world units from the top-left). */
export function offsetAtPoint(
  measurer: Measurer,
  layout: TextLayout,
  x: number,
  y: number,
): number {
  const index = Math.max(
    0,
    Math.min(layout.lines.length - 1, Math.floor(y / layout.lineHeight)),
  );
  return offsetAtX(measurer, layout, index, x);
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** The word (or run of spaces or punctuation) around `offset`. */
export function wordAt(text: string, offset: number): { start: number; end: number } {
  for (const s of words.segment(text)) {
    const end = s.index + s.segment.length;
    if (offset >= s.index && offset < end) return { start: s.index, end };
  }
  return { start: offset, end: offset };
}
