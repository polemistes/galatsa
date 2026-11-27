// SPDX-License-Identifier: GPL-3.0-or-later

// Rich text as the renderer reads it: text content (a plain string, or the JSON
// form of a Y.Text, a delta of runs with attributes) split into paragraphs of
// styled runs. The drawing layout, the hidden layout element and the in-place
// editing element are all built from this, so they agree on what the text is.
// See docs/adr/0011-text.md.
//
// The attributes the renderer understands:
//
// - On characters: `bold: true`, `italic: true`, `color: "<css colour>"`.
// - On a paragraph's terminating "\n": `list: "bullet" | "ordered"`.
//
// A "\n" ends the paragraph before it and carries that paragraph's attributes.
// Text that ends with "\n" has no empty paragraph after it; text that does not
// (or empty text) has a last paragraph without attributes. So "ab\n" and "ab"
// are both one paragraph, "ab\n\n" is "ab" and an empty one. Unknown
// attributes are ignored. An embed (a non-string insert) counts as one
// character, shown as U+FFFC, so indices match the shared text.

import type { TextContent, TextStyle } from "@galatsa/extension-api";

export type ListKind = "bullet" | "ordered";

/** A run of characters with one style. */
export interface TextRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Colour of this run; null for the box's colour. */
  readonly color: string | null;
}

export interface Paragraph {
  readonly runs: readonly TextRun[];
  readonly list: ListKind | null;
  /** The list marker ("•", "3."), or null. */
  readonly marker: string | null;
  /** Index of the paragraph's first character in the content. */
  readonly start: number;
  /** Number of characters, without the terminating "\n". */
  readonly length: number;
  /** Whether a "\n" ends it in the content. */
  readonly terminated: boolean;
}

export interface RichText {
  readonly paragraphs: readonly Paragraph[];
  /** Length of the content in characters (UTF-16 code units), "\n" included. */
  readonly length: number;
}

/** Width of the list indent, in em. */
export const LIST_INDENT_EM = 1.5;
/** Space between a list marker and the text, in em. */
export const LIST_GAP_EM = 0.4;
export const BULLET = "•";
const OBJECT = "￼";

interface Attributes {
  readonly [key: string]: unknown;
}

function runStyle(attributes: Attributes | undefined): Omit<TextRun, "text"> {
  const color = attributes?.["color"];
  return {
    bold: attributes?.["bold"] === true,
    italic: attributes?.["italic"] === true,
    color: typeof color === "string" && color.length > 0 && color.length <= 64 ? color : null,
  };
}

function listOf(attributes: Attributes | undefined): ListKind | null {
  const list = attributes?.["list"];
  return list === "bullet" || list === "ordered" ? list : null;
}

/** Plain text of the content, embeds as U+FFFC. */
export function contentString(content: TextContent): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const run of content.delta)
    out += typeof run.insert === "string" ? run.insert : OBJECT;
  return out;
}

/** Splits text content into paragraphs of styled runs. */
export function parseRichText(content: TextContent): RichText {
  const delta: ReadonlyArray<{ insert: unknown; attributes?: Attributes }> =
    typeof content === "string" ? [{ insert: content }] : content.delta;
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  let start = 0;
  let at = 0;
  let ordered = 0;
  const push = (text: string, attributes: Attributes | undefined): void => {
    if (text === "") return;
    const style = runStyle(attributes);
    const last = runs[runs.length - 1];
    if (
      last &&
      last.bold === style.bold &&
      last.italic === style.italic &&
      last.color === style.color
    )
      runs[runs.length - 1] = { ...last, text: last.text + text };
    else runs.push({ text, ...style });
  };
  const end = (terminated: boolean, list: ListKind | null): void => {
    ordered = list === "ordered" ? ordered + 1 : 0;
    paragraphs.push({
      runs,
      list,
      marker: list === "bullet" ? BULLET : list === "ordered" ? `${ordered}.` : null,
      start,
      length: at - start,
      terminated,
    });
    runs = [];
  };
  for (const op of delta) {
    if (typeof op.insert !== "string") {
      push(OBJECT, op.attributes);
      at += 1;
      continue;
    }
    const parts = op.insert.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        end(true, listOf(op.attributes));
        at += 1;
        start = at;
      }
      push(part, op.attributes);
      at += part.length;
    });
  }
  if (paragraphs.length === 0 || at > start || !paragraphs[paragraphs.length - 1]!.terminated)
    end(false, null);
  return { paragraphs, length: at };
}

/** The paragraph's plain text. */
export function paragraphText(paragraph: Paragraph): string {
  let out = "";
  for (const run of paragraph.runs) out += run.text;
  return out;
}

/** The CSS font prefix (style and weight) of a run in a style. */
export function fontPrefix(style: TextStyle, run?: TextRun): string {
  const italic = (run?.italic ?? false) || style.italic === true;
  const bold = (run?.bold ?? false) || style.bold === true;
  return `${italic ? "italic " : ""}${bold ? "700" : "400"} `;
}
