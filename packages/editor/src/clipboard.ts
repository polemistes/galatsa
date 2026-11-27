// SPDX-License-Identifier: GPL-3.0-or-later

// What the editor puts on the system clipboard and reads back from it
// (docs/adr/0008-selection.md). A copy writes the fragment the basics' "copy"
// returns, wrapped in a small envelope with a version and where it was copied
// from, twice: under the program's own type, which the browser's copy and
// paste events carry, and as plain text, which is what the asynchronous
// clipboard (a paste from the context menu) can read in every browser.
//
// Pasting reads the program's type first, then plain text that starts like an
// envelope; other text is never parsed. What is pasted is limited before it
// is parsed (the length of the text) and before it is pasted (the number of
// elements and how deep containers nest), so a huge or hostile clipboard is
// refused with a notice instead of freezing the page. An envelope of another
// version is recognised and refused, never handed on as text. Anything else
// on the clipboard (text from another program, image files) is described so
// that the text and image extensions can paste it later; the editor does not
// paste it yet.

import type { ElementId, Fragment, Point, Rect } from "@galatsa/core";

/** The program's own clipboard type: the envelope as JSON. */
export const FRAGMENT_MIME = "application/x-galatsa-fragment+json";
/** What the envelope says it holds. */
export const ENVELOPE_KIND = "galatsa/fragment";
/** The envelope's layout; another one is not read. */
export const ENVELOPE_VERSION = 1;

/** The longest clipboard text read as an envelope, in characters. */
export const MAX_CLIPBOARD_TEXT = 16 * 1024 * 1024;
/** The most elements one paste creates. */
export const MAX_PASTE_ELEMENTS = 5000;
/** The deepest nesting of containers in what is pasted (a root is at depth 1). */
export const MAX_PASTE_DEPTH = 64;

/**
 * How an envelope starts. `encodeFragment` writes the kind first, so text
 * that does not start like this is not the program's and is not parsed.
 */
const ENVELOPE_START = /^\s*\{\s*"kind"\s*:\s*"galatsa\/fragment"/;

/** Where a copy writes: a `DataTransfer` of a copy event, say. */
export interface ClipboardTarget {
  setData(type: string, data: string): void;
}

/** A file on the clipboard, as much as the editor needs to know of it. */
export interface ClipboardFile {
  readonly name: string;
  readonly type: string;
}

/**
 * Where a fragment was copied from: the container its roots' positions are
 * in (null for the canvas), and where that container's origin was in root
 * space then. A paste puts it back into that container while it is there,
 * and otherwise converts its positions to root space.
 */
export interface ClipboardOrigin {
  readonly container: ElementId | null;
  readonly at: Point;
}

/** Why what is on the clipboard is not pasted. */
export type ClipboardProblem =
  /** More than the limits allow (MAX_CLIPBOARD_TEXT, MAX_PASTE_ELEMENTS, MAX_PASTE_DEPTH). */
  | "too-large"
  /** An envelope of a version this program does not read. */
  | "other-version"
  /** An envelope that is not valid. */
  | "damaged";

/** What a paste found on the clipboard. */
export interface ClipboardContent {
  /**
   * A fragment from the program's envelope, within the limits but not yet
   * checked otherwise: paste reads it with the document's grammar and
   * refuses what does not read. Undefined when there is none.
   */
  readonly fragment: unknown;
  /** Where the fragment was copied from, if the envelope says. */
  readonly origin: ClipboardOrigin | null;
  /** The program's envelope was there but is not pasted, and why. */
  readonly problem: ClipboardProblem | null;
  /** Plain text that is not the program's (text from another program), or null. */
  readonly text: string | null;
  /** Files (pasted images, for the image extension later). */
  readonly files: readonly ClipboardFile[];
}

/** The envelope a copy puts on the clipboard, as text. */
export function encodeFragment(fragment: Fragment, origin?: ClipboardOrigin): string {
  return JSON.stringify({
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    ...(origin !== undefined ? { origin } : {}),
    fragment,
  });
}

/** Writes a fragment to the clipboard: the program's type and plain text. */
export function writeFragment(
  target: ClipboardTarget,
  fragment: Fragment,
  origin?: ClipboardOrigin,
): void {
  const text = encodeFragment(fragment, origin);
  target.setData(FRAGMENT_MIME, text);
  target.setData("text/plain", text);
}

/** What a text is, read as an envelope. */
export type Decoded =
  /** Not the program's: other text. */
  | { readonly kind: "text" }
  | { readonly kind: "problem"; readonly problem: ClipboardProblem }
  | {
      readonly kind: "fragment";
      readonly fragment: unknown;
      readonly origin: ClipboardOrigin | null;
    };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readOrigin(raw: unknown): ClipboardOrigin | null {
  if (raw === null || typeof raw !== "object") return null;
  const { container, at } = raw as { container?: unknown; at?: unknown };
  if (container !== null && typeof container !== "string") return null;
  if (at === null || typeof at !== "object") return null;
  const { x, y } = at as { x?: unknown; y?: unknown };
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return { container, at: { x, y } };
}

/**
 * Whether a fragment, still unchecked, is within the limits: at most
 * MAX_PASTE_ELEMENTS elements, containers nested at most MAX_PASTE_DEPTH
 * deep. Anything that is not even shaped like a fragment passes, for paste to
 * refuse with the grammar.
 */
export function withinLimits(fragment: unknown): boolean {
  if (fragment === null || typeof fragment !== "object") return true;
  const elements = (fragment as { elements?: unknown }).elements;
  if (elements === null || typeof elements !== "object") return true;
  const ids = Object.keys(elements);
  if (ids.length > MAX_PASTE_ELEMENTS) return false;
  const parentOf = (id: string): string | null => {
    const element = Object.hasOwn(elements, id)
      ? (elements as Record<string, unknown>)[id]
      : undefined;
    if (element === null || typeof element !== "object") return null;
    const parent = (element as { parent?: unknown }).parent;
    return typeof parent === "string" && Object.hasOwn(elements, parent) ? parent : null;
  };
  const depth = new Map<string, number>();
  for (const id of ids) {
    // Up to a known depth, or the root; a cycle ends the walk (the grammar
    // refuses it later).
    const path: string[] = [];
    const onPath = new Set<string>();
    let at: string | null = id;
    while (at !== null && !depth.has(at) && !onPath.has(at)) {
      path.push(at);
      onPath.add(at);
      if (path.length > MAX_PASTE_DEPTH) return false;
      at = parentOf(at);
    }
    let d = at !== null ? (depth.get(at) ?? 0) : 0;
    for (let i = path.length - 1; i >= 0; i--) {
      d += 1;
      if (d > MAX_PASTE_DEPTH) return false;
      depth.set(path[i]!, d);
    }
  }
  return true;
}

/** Reads a text as the program's envelope. Text that does not start like one is not parsed. */
export function decodeEnvelope(text: string): Decoded {
  if (!ENVELOPE_START.test(text.slice(0, 256))) return { kind: "text" };
  if (text.length > MAX_CLIPBOARD_TEXT) return { kind: "problem", problem: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "problem", problem: "damaged" };
  }
  if (value === null || typeof value !== "object")
    return { kind: "problem", problem: "damaged" };
  const envelope = value as {
    kind?: unknown;
    version?: unknown;
    origin?: unknown;
    fragment?: unknown;
  };
  if (envelope.kind !== ENVELOPE_KIND) return { kind: "problem", problem: "damaged" };
  if (envelope.version !== ENVELOPE_VERSION)
    return { kind: "problem", problem: "other-version" };
  if (!withinLimits(envelope.fragment)) return { kind: "problem", problem: "too-large" };
  return {
    kind: "fragment",
    fragment: envelope.fragment,
    origin: readOrigin(envelope.origin),
  };
}

/** The fragment in an envelope, or undefined if the text is not one this version pastes. */
export function decodeFragment(text: string): unknown {
  const decoded = decodeEnvelope(text);
  return decoded.kind === "fragment" ? decoded.fragment : undefined;
}

/** Where a paste reads from: a `DataTransfer` of a paste event, say. */
export interface ClipboardSource {
  readonly types: readonly string[];
  getData(type: string): string;
  readonly files?: ArrayLike<ClipboardFile>;
}

/** What a text read from the clipboard holds (the asynchronous clipboard gives plain text only). */
export function readClipboardText(text: string): ClipboardContent {
  return contentOf(decodeEnvelope(text), text, []);
}

function contentOf(
  decoded: Decoded,
  text: string | null,
  files: readonly ClipboardFile[],
): ClipboardContent {
  if (decoded.kind === "fragment")
    return {
      fragment: decoded.fragment,
      origin: decoded.origin,
      problem: null,
      text: null,
      files,
    };
  if (decoded.kind === "problem")
    return {
      fragment: undefined,
      origin: null,
      problem: decoded.problem,
      text: null,
      files,
    };
  return {
    fragment: undefined,
    origin: null,
    problem: null,
    text: text === "" ? null : text,
    files,
  };
}

/** What the clipboard holds, read the way a paste reads it. */
export function readClipboard(source: ClipboardSource): ClipboardContent {
  const types = [...source.types];
  const files = source.files ? Array.from(source.files) : [];
  const text = types.includes("text/plain") ? source.getData("text/plain") : null;
  if (types.includes(FRAGMENT_MIME)) {
    const decoded = decodeEnvelope(source.getData(FRAGMENT_MIME));
    // The program's own type holds nothing but an envelope.
    if (decoded.kind !== "text") return contentOf(decoded, null, files);
  }
  return contentOf(text === null ? { kind: "text" } : decodeEnvelope(text), text, files);
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
