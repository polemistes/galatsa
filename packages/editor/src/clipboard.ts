// SPDX-License-Identifier: GPL-3.0-or-later

// What the editor puts on the system clipboard and reads back from it
// (docs/adr/0008-selection.md). A copy writes the fragment the basics' "copy"
// returns, wrapped in a small envelope with a version, twice: under the
// program's own type, which the browser's copy and paste events carry, and
// as plain text, which is what the asynchronous clipboard (a paste from the
// context menu) can read in every browser. Pasting reads the program's type
// first, then plain text that holds an envelope. Anything else on the
// clipboard (text from another program, image files) is described so that
// the text and image extensions can paste it later; the editor does not paste
// it yet.

import type { Fragment, Rect } from "@galatsa/core";

/** The program's own clipboard type: the envelope as JSON. */
export const FRAGMENT_MIME = "application/x-galatsa-fragment+json";
/** What the envelope says it holds. */
export const ENVELOPE_KIND = "galatsa/fragment";
/** The envelope's layout; a newer one is not read. */
export const ENVELOPE_VERSION = 1;

/** Where a copy writes: a `DataTransfer` of a copy event, say. */
export interface ClipboardTarget {
  setData(type: string, data: string): void;
}

/** A file on the clipboard, as much as the editor needs to know of it. */
export interface ClipboardFile {
  readonly name: string;
  readonly type: string;
}

/** What a paste found on the clipboard. */
export interface ClipboardContent {
  /**
   * A fragment from the program's envelope, not yet checked: paste reads it
   * with the document's grammar and refuses what does not read.
   */
  readonly fragment: unknown;
  /** Plain text that is not an envelope (text from another program), or null. */
  readonly text: string | null;
  /** Files (pasted images, for the image extension later). */
  readonly files: readonly ClipboardFile[];
}

/** The envelope a copy puts on the clipboard, as text. */
export function encodeFragment(fragment: Fragment): string {
  return JSON.stringify({ kind: ENVELOPE_KIND, version: ENVELOPE_VERSION, fragment });
}

/** Writes a fragment to the clipboard: the program's type and plain text. */
export function writeFragment(target: ClipboardTarget, fragment: Fragment): void {
  const text = encodeFragment(fragment);
  target.setData(FRAGMENT_MIME, text);
  target.setData("text/plain", text);
}

/** The fragment in an envelope, or undefined if the text is not one this version reads. */
export function decodeFragment(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const envelope = value as { kind?: unknown; version?: unknown; fragment?: unknown };
  if (envelope.kind !== ENVELOPE_KIND || envelope.version !== ENVELOPE_VERSION)
    return undefined;
  return envelope.fragment;
}

/** Where a paste reads from: a `DataTransfer` of a paste event, say. */
export interface ClipboardSource {
  readonly types: readonly string[];
  getData(type: string): string;
  readonly files?: ArrayLike<ClipboardFile>;
}

/** What the clipboard holds, read the way a paste reads it. */
export function readClipboard(source: ClipboardSource): ClipboardContent {
  const types = [...source.types];
  const files = source.files ? Array.from(source.files) : [];
  let fragment: unknown;
  if (types.includes(FRAGMENT_MIME))
    fragment = decodeFragment(source.getData(FRAGMENT_MIME));
  let text: string | null = types.includes("text/plain")
    ? source.getData("text/plain")
    : null;
  if (fragment === undefined && text !== null) {
    fragment = decodeFragment(text);
    if (fragment !== undefined) text = null;
  } else if (fragment !== undefined) text = null;
  return { fragment, text: text === "" ? null : text, files };
}

/**
 * Roughly where a fragment's roots lie, in their common space (unrotated
 * boxes; groups by what is inside them). Null if nothing in it has a size.
 */
export function fragmentBounds(fragment: Fragment): Rect | null {
  const children = new Map<string, string[]>();
  for (const [id, element] of Object.entries(fragment.elements)) {
    if (element.parent === null) continue;
    const list = children.get(element.parent) ?? [];
    list.push(id);
    children.set(element.parent, list);
  }
  let out: Rect | null = null;
  const add = (r: Rect): void => {
    if (out === null) {
      out = r;
      return;
    }
    const x = Math.min(out.x, r.x);
    const y = Math.min(out.y, r.y);
    out = {
      x,
      y,
      w: Math.max(out.x + out.w, r.x + r.w) - x,
      h: Math.max(out.y + out.h, r.y + r.h) - y,
    };
  };
  const visit = (id: string, ox: number, oy: number, depth: number): void => {
    const element = fragment.elements[id];
    if (element === undefined || depth > 64) return;
    const x = ox + element.pos.x;
    const y = oy + element.pos.y;
    if ("size" in element && element.size !== undefined) {
      add({ x, y, w: element.size.w, h: element.size.h });
      return;
    }
    for (const child of children.get(id) ?? []) visit(child, x, y, depth + 1);
  };
  for (const root of fragment.roots) visit(root, 0, 0, 0);
  return out;
}
