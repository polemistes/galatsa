// SPDX-License-Identifier: GPL-3.0-or-later

// Formatting of shared rich text (docs/adr/0011-text.md): character
// attributes on ranges, list attributes on the "\n" that ends each paragraph.
// Character attributes never go on a "\n", and list attributes only on one,
// so the two kinds stay apart. Callers run these inside `edit()`.

import * as Y from "yjs";

export type ListKind = "bullet" | "ordered";

/** A paragraph: its characters [start, end), and whether a "\n" at `end` ends it. */
export interface ParagraphRange {
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
}

/** The paragraphs of a text, as the renderer reads them (rich-text.ts). */
export function paragraphRanges(text: string): ParagraphRange[] {
  const out: ParagraphRange[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    out.push({ start, end: nl, terminated: true });
    start = nl + 1;
  }
  if (start < text.length || out.length === 0)
    out.push({ start, end: text.length, terminated: false });
  return out;
}

/** The paragraphs that a range touches (a caret touches the one it is in). */
export function paragraphsIn(
  text: string,
  index: number,
  length: number,
): ParagraphRange[] {
  const all = paragraphRanges(text);
  if (length <= 0) {
    const p = all.find((r) => r.start <= index && index <= r.end);
    return p ? [p] : all.slice(-1);
  }
  const end = index + length;
  // A selection that starts at a paragraph's end touches only its "\n", and
  // one that ends at a paragraph's start touches none of it.
  return all.filter(
    (p) => p.start < end && (p.end > index || (p.start === p.end && p.start >= index)),
  );
}

/** Each run of characters (not "\n") within [index, index + length). */
function charRuns(text: string, index: number, length: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = index;
  const end = Math.min(text.length, index + length);
  while (at < end) {
    const nl = text.indexOf("\n", at);
    const stop = nl < 0 || nl >= end ? end : nl;
    if (stop > at) out.push([at, stop - at]);
    at = stop + 1;
  }
  return out;
}

/** Whether every character (not "\n") in the range has `key` set to true; false for none. */
export function allHave(
  ytext: Y.Text,
  index: number,
  length: number,
  key: string,
): boolean {
  let at = 0;
  let any = false;
  const end = index + length;
  for (const op of ytext.toDelta() as Array<{
    insert: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    const s = typeof op.insert === "string" ? op.insert : "￼";
    for (let i = 0; i < s.length; i++, at++) {
      if (at < index || at >= end || s[i] === "\n") continue;
      any = true;
      if (op.attributes?.[key] !== true) return false;
    }
  }
  return any;
}

/** Sets character attributes on the range, leaving every "\n" alone. */
export function formatChars(
  ytext: Y.Text,
  index: number,
  length: number,
  attributes: Record<string, unknown>,
): void {
  for (const [at, n] of charRuns(ytext.toString(), index, length))
    ytext.format(at, n, attributes);
}

/** The word around a caret, or null when the caret is not in or next to a word. */
export function wordAt(
  text: string,
  index: number,
): { index: number; length: number } | null {
  const words = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const s of words.segment(text)) {
    const end = s.index + s.segment.length;
    if (s.isWordLike && s.index <= index && index <= end && s.index < end)
      return { index: s.index, length: end - s.index };
  }
  return null;
}

/** The list kind of each paragraph (the attribute of its terminating "\n"). */
function listsOf(ytext: Y.Text): Map<number, ListKind | null> {
  const out = new Map<number, ListKind | null>();
  let at = 0;
  for (const op of ytext.toDelta() as Array<{
    insert: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    const s = typeof op.insert === "string" ? op.insert : "￼";
    const list = op.attributes?.["list"];
    for (let i = 0; i < s.length; i++, at++)
      if (s[i] === "\n")
        out.set(at, list === "bullet" || list === "ordered" ? list : null);
  }
  return out;
}

/** Whether every paragraph given is a list of `kind`. */
export function allLists(
  ytext: Y.Text,
  paragraphs: readonly ParagraphRange[],
  kind: ListKind,
): boolean {
  const lists = listsOf(ytext);
  return (
    paragraphs.length > 0 &&
    paragraphs.every((p) => p.terminated && lists.get(p.end) === kind)
  );
}

/**
 * Makes the paragraphs lists of `kind`, or plain paragraphs with null. A last
 * paragraph without a "\n" gets one, which carries the list.
 */
export function setLists(
  ytext: Y.Text,
  paragraphs: readonly ParagraphRange[],
  kind: ListKind | null,
): void {
  // From the end, so an inserted "\n" does not move the paragraphs before it.
  for (const p of [...paragraphs].sort((a, b) => b.start - a.start)) {
    if (p.terminated) ytext.format(p.end, 1, { list: kind });
    else if (kind !== null) ytext.insert(p.end, "\n", { list: kind });
  }
}
