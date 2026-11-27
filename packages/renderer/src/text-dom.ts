// SPDX-License-Identifier: GPL-3.0-or-later
// i18n-ignore-file: styles and element structure for laying text out; no text users read.

// The browser's text layout (docs/adr/0011-text.md): rich text is laid out in
// a hidden element at REFERENCE_SIZE, and the lines, their baselines and where
// each run starts on a line are read back with ranges. The in-place editing
// element (text-edit.ts) is built by the same function with the same styles
// and scaled to the screen, so the browser breaks its lines exactly where the
// canvas does: one layout for drawing and editing (docs/adr/0004).
//
// The browser gives Unicode line breaking, grapheme clusters and the bundled
// fonts' real metrics without a layout library. Lines are found by a binary
// search over grapheme clusters (a line ends where the next cluster's box is a
// line lower), so laying out a paragraph reads a few rectangles per line.

import type { TextContent, TextStyle } from "@galatsa/extension-api";
import { cssFamily, type FontFamilies, type FontWaiter } from "./fonts.ts";
import {
  fontPrefix,
  LIST_GAP_EM,
  LIST_INDENT_EM,
  paragraphText,
  parseRichText,
  type Paragraph,
  type RichText,
} from "./rich-text.ts";
import {
  lineHeightOf,
  REFERENCE_SIZE,
  RichTextLayout,
  type LayoutFragment,
  type Line,
} from "./text.ts";

/** Class of an editing element's root (its list markers are styled by it). */
export const EDIT_CLASS = "galatsa-text-edit";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The width of a text box at the reference size, in CSS pixels. */
export function referenceWidth(style: TextStyle, width: number): number {
  return (width * REFERENCE_SIZE) / style.fontSize;
}

/**
 * Styles a text root for a style and a box width. Everything that affects
 * layout is set explicitly, so page styles cannot change it, and the hidden
 * layout element and the editing element get the same.
 */
export function styleTextRoot(
  root: HTMLElement,
  style: TextStyle,
  width: number,
  families: FontFamilies,
): void {
  const lh = (lineHeightOf(style) * REFERENCE_SIZE) / style.fontSize;
  const s = root.style;
  s.cssText = "all: initial";
  Object.assign(s, {
    display: "block",
    position: "absolute",
    left: "0",
    top: "0",
    boxSizing: "content-box",
    width: `${referenceWidth(style, width)}px`,
    margin: "0",
    padding: "0",
    border: "0",
    fontFamily: cssFamily(families, style.fontFamily),
    fontSize: `${REFERENCE_SIZE}px`,
    fontWeight: style.bold ? "700" : "400",
    fontStyle: style.italic ? "italic" : "normal",
    lineHeight: `${lh}px`,
    color: style.color,
    textAlign: style.align,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "normal",
    lineBreak: "auto",
    hyphens: "manual",
    fontKerning: "normal",
    fontVariantLigatures: "normal",
    fontSynthesis: "weight style",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textTransform: "none",
    textIndent: "0",
    direction: "ltr",
    tabSize: "4",
    transformOrigin: "0 0",
  });
  s.setProperty("-webkit-text-size-adjust", "none");
  s.setProperty("text-size-adjust", "none");
}

/**
 * Fills `root` with the paragraphs of `rich`: a block per paragraph, a span
 * per run, a line break in an empty paragraph. List paragraphs are indented,
 * and carry their marker in `data-marker` (the editing element shows it; the
 * canvas draws its own). With `baselines`, each paragraph starts with an
 * empty inline block whose bottom is the first line's baseline.
 */
export function fillTextRoot(
  root: HTMLElement,
  rich: RichText,
  style: TextStyle,
  baselines: boolean,
): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  for (const paragraph of rich.paragraphs) {
    const block = doc.createElement("div");
    block.style.cssText = "display: block; margin: 0; padding: 0; position: relative";
    if (paragraph.list !== null) {
      block.style.paddingLeft = `${LIST_INDENT_EM * REFERENCE_SIZE}px`;
      block.dataset["marker"] = paragraph.marker ?? "";
    }
    if (baselines) {
      const probe = doc.createElement("span");
      probe.style.cssText =
        "display: inline-block; width: 0; height: 0; margin: 0; padding: 0; vertical-align: baseline";
      probe.dataset["probe"] = "";
      block.append(probe);
    }
    for (const run of paragraph.runs) {
      const span = doc.createElement("span");
      const prefix = fontPrefix(style, run);
      span.style.fontWeight = prefix.includes("700") ? "700" : "400";
      span.style.fontStyle = prefix.startsWith("italic") ? "italic" : "normal";
      if (run.color !== null) span.style.color = run.color;
      span.textContent = run.text;
      block.append(span);
    }
    if (paragraph.length === 0) block.append(doc.createElement("br"));
    root.append(block);
  }
}

/** The stylesheet of editing elements: list markers in the indent. */
export function ensureEditStyles(doc: Document): void {
  if (doc.getElementById("galatsa-text-edit-styles") !== null) return;
  const sheet = doc.createElement("style");
  sheet.id = "galatsa-text-edit-styles";
  const width = (LIST_INDENT_EM - LIST_GAP_EM) * REFERENCE_SIZE;
  sheet.textContent =
    `.${EDIT_CLASS} > div[data-marker]::before { content: attr(data-marker); ` +
    `position: absolute; left: 0; width: ${width}px; text-align: right; ` +
    `font-weight: inherit; font-style: inherit; white-space: pre; }`;
  (doc.head ?? doc.documentElement).append(sheet);
}

/** The fonts a text needs, as CSS font strings at the reference size. */
export function fontsOf(rich: RichText, style: TextStyle, family: string): string[] {
  const prefixes = new Set<string>([fontPrefix(style)]);
  for (const p of rich.paragraphs)
    for (const run of p.runs) prefixes.add(fontPrefix(style, run));
  return [...prefixes].map((prefix) => `${prefix}${REFERENCE_SIZE}px ${family}`);
}

interface Cluster {
  /** The text node and the cluster's place in it. */
  readonly node: Text;
  readonly start: number;
  readonly end: number;
  readonly run: number;
  readonly text: string;
}

/** The clusters of a paragraph block, run by run (a cluster never spans runs). */
function clustersOf(block: HTMLElement, paragraph: Paragraph): Cluster[] {
  const out: Cluster[] = [];
  const spans = [...block.children].filter(
    (el): el is HTMLElement =>
      el.tagName === "SPAN" && (el as HTMLElement).dataset["probe"] === undefined,
  );
  paragraph.runs.forEach((run, r) => {
    const node = spans[r]?.firstChild;
    if (!(node instanceof Text)) return;
    for (const { segment, index } of graphemes.segment(run.text))
      out.push({
        node,
        start: index,
        end: index + segment.length,
        run: r,
        text: segment,
      });
  });
  return out;
}

/** Lays text out in the browser. One per document; reuses its hidden element. */
export class DomTextEngine {
  readonly #doc: Document;
  readonly #families: FontFamilies;
  readonly #fonts: FontWaiter;
  #host: HTMLElement | null = null;
  #root: HTMLElement | null = null;
  readonly #range: Range;

  constructor(doc: Document, families: FontFamilies, fonts: FontWaiter) {
    this.#doc = doc;
    this.#families = families;
    this.#fonts = fonts;
    this.#range = doc.createRange();
  }

  #element(): HTMLElement {
    if (this.#root !== null && this.#root.isConnected) return this.#root;
    const doc = this.#doc;
    const host = doc.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; " +
      "overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1";
    const root = doc.createElement("div");
    host.append(root);
    (doc.body ?? doc.documentElement).append(host);
    this.#host = host;
    this.#root = root;
    return root;
  }

  layout(content: TextContent, style: TextStyle, width: number): RichTextLayout {
    const rich = parseRichText(content);
    const family = cssFamily(this.#families, style.fontFamily);
    let all = "";
    for (const p of rich.paragraphs) all += paragraphText(p);
    const ready = this.#fonts.ready(
      fontsOf(rich, style, family),
      all.slice(0, 4096) || " ",
    );
    const root = this.#element();
    styleTextRoot(root, style, width, this.#families);
    fillTextRoot(root, rich, style, true);
    const scale = style.fontSize / REFERENCE_SIZE;
    const lh = (lineHeightOf(style) * REFERENCE_SIZE) / style.fontSize;
    const origin = root.getBoundingClientRect();
    const range = this.#range;
    const rectOf = (c: Cluster): DOMRect => {
      range.setStart(c.node, c.start);
      range.setEnd(c.node, c.end);
      return range.getBoundingClientRect();
    };
    const lines: Line[] = [];
    const blocks = [...root.children] as HTMLElement[];
    rich.paragraphs.forEach((paragraph, p) => {
      const block = blocks[p]!;
      const box = block.getBoundingClientRect();
      const probe = block.querySelector<HTMLElement>("[data-probe]");
      const baseline0 =
        (probe?.getBoundingClientRect().bottom ?? box.top + lh * 0.8) - origin.top;
      const clusters = clustersOf(block, paragraph);
      // Line starts, by binary search on the clusters' tops.
      const tops: number[] = [];
      const starts: number[] = [];
      let at = 0;
      while (at < clusters.length) {
        const top = rectOf(clusters[at]!).top;
        starts.push(at);
        tops.push(top);
        let lo = at + 1;
        let hi = clusters.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (rectOf(clusters[mid]!).top < top + lh / 2) lo = mid + 1;
          else hi = mid;
        }
        at = lo;
      }
      if (starts.length === 0) {
        starts.push(0);
        tops.push(box.top);
      }
      // Lines are lh apart when the block is as tall as its lines; otherwise
      // (a fallback font made a line taller) follow the clusters' tops.
      const uniform = Math.abs(box.height - starts.length * lh) < 0.5;
      const indent = paragraph.list !== null ? LIST_INDENT_EM * REFERENCE_SIZE : 0;
      starts.forEach((first, k) => {
        const last = (starts[k + 1] ?? clusters.length) - 1;
        const offset = uniform ? k * lh : tops[k]! - tops[0]!;
        const top = box.top - origin.top + offset;
        const fragments: LayoutFragment[] = [];
        let left = Infinity;
        let right = -Infinity;
        let text = "";
        let i = first;
        while (i <= last) {
          const run = clusters[i]!.run;
          let j = i;
          let chars = "";
          let shown = "";
          let visibleStart = -1;
          let visibleEnd = -1;
          while (j <= last && clusters[j]!.run === run) {
            chars += clusters[j]!.text;
            if (!/^\s+$/.test(clusters[j]!.text)) {
              if (visibleStart < 0) visibleStart = j;
              visibleEnd = j;
            }
            if (visibleStart >= 0) shown += clusters[j]!.text;
            j++;
          }
          text += chars;
          if (visibleEnd >= 0) {
            // Drawn from its first visible character to its last: spaces
            // around it are not drawn, and are not measured, so the first
            // glyph stands exactly where the browser put it.
            shown = shown.replace(/\s+$/, "");
            const x0 = rectOf(clusters[visibleStart]!).left - origin.left;
            const x1 = rectOf(clusters[visibleEnd]!).right - origin.left;
            const runStyle = paragraph.runs[run]!;
            fragments.push({
              text: shown,
              x: x0 * scale,
              width: (x1 - x0) * scale,
              prefix: fontPrefix(style, runStyle),
              family,
              color: runStyle.color ?? style.color,
            });
            left = Math.min(left, x0);
            right = Math.max(right, x1);
          }
          i = j;
        }
        if (!(right > left)) left = right = indent;
        const marker =
          k === 0 && paragraph.marker !== null
            ? this.#marker(paragraph.marker, style, family, scale)
            : null;
        lines.push({
          top: top * scale,
          height: lh * scale,
          baseline: (baseline0 + offset) * scale,
          x: left * scale,
          width: (right - left) * scale,
          fragments,
          marker,
          text,
        });
      });
    });
    const height = root.getBoundingClientRect().height * scale;
    root.replaceChildren();
    return new RichTextLayout({
      lines,
      width,
      height,
      fontSize: style.fontSize,
      color: style.color,
      provisional: !ready,
    });
  }

  /** A list marker, right-aligned in the indent, measured in the browser too. */
  #marker(text: string, style: TextStyle, family: string, scale: number): LayoutFragment {
    const doc = this.#doc;
    const span = doc.createElement("span");
    const prefix = fontPrefix(style);
    span.style.cssText = `all: initial; position: absolute; white-space: pre; font: ${prefix}${REFERENCE_SIZE}px ${family}`;
    span.textContent = text;
    this.#host!.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    const right = (LIST_INDENT_EM - LIST_GAP_EM) * REFERENCE_SIZE;
    return {
      text,
      x: (right - width) * scale,
      width: width * scale,
      prefix,
      family,
      color: style.color,
    };
  }

  dispose(): void {
    this.#host?.remove();
    this.#host = null;
    this.#root = null;
  }
}
