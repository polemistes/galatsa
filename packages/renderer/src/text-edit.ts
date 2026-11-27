// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing (docs/adr/0004, docs/adr/0011-text.md): an editable
// browser element over the text box. It is built like the hidden layout
// element (text-dom.ts), at the reference size, and scaled onto the screen
// with a CSS transform, so its lines break exactly where the drawn text's do
// and the text does not move when editing starts. The canvas leaves the
// element's text out while it is edited.
//
// The element is never the source of the text: every edit is turned into a
// plain replacement (`{ index, length, text }`, in characters of the content
// as last shown) and handed to `onEdit`; the caller writes it to the shared
// text and shows the result with `setContent`. So typing, pasting, undo and
// edits by other users all go through the shared text, and the element only
// shows it. Most edits arrive as `beforeinput` events, which are cancelled
// and turned into replacements. Composition (input methods, dead keys on some
// systems) cannot be cancelled: the browser changes the element while the
// user composes, and when composition ends the element's text is compared
// with what was shown and the difference is handed on.
//
// Keys and pointer presses inside the element do not reach the canvas (whose
// keys would otherwise move the camera on Space or Shift+1); keys with
// Ctrl, Cmd or Alt, and Escape, go to `onKey` first.

import type { TextContent, TextStyle } from "@galatsa/extension-api";
import type { Rect } from "@galatsa/core";
import { type FontFamilies } from "./fonts.ts";
import { paragraphText, parseRichText, type RichText } from "./rich-text.ts";
import { EDIT_CLASS, ensureEditStyles, fillTextRoot, styleTextRoot } from "./text-dom.ts";
import { REFERENCE_SIZE } from "./text.ts";
import type { Matrix } from "./transform.ts";

/** A replacement of `length` characters at `index` by `text`. */
export interface TextEdit {
  readonly index: number;
  readonly length: number;
  readonly text: string;
  /**
   * An undo step of its own, not joined to the typing around it: a paste, a
   * drop, the text an input method composed.
   */
  readonly step?: boolean;
}

/** A selection in characters of the content: start and length. */
export interface TextSelection {
  readonly index: number;
  readonly length: number;
}

/** A key pressed in the editing element, as plain values. */
export interface TextEditKey {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** `getModifierState("AltGraph")`. */
  readonly altGraph: boolean;
  readonly repeat: boolean;
}

export interface TextEditOptions {
  /** The text style and the text area in the element's local box (TextEditTarget). */
  readonly style: TextStyle;
  readonly box: Rect;
  readonly content: TextContent;
  /** Where the caret starts; the end of the text by default. */
  readonly selection?: TextSelection;
  /** A place on screen (CSS pixels of the drawing area) to put the caret at. */
  readonly caretAt?: { readonly x: number; readonly y: number };
  /** The user changed the text. */
  onEdit(edit: TextEdit): void;
  /** A key with Ctrl, Cmd or Alt, or Escape: true if the caller used it. */
  onKey?(key: TextEditKey): boolean;
  /** The selection moved. */
  onSelection?(selection: TextSelection | null): void;
  /** The browser asked for undo or redo (its menu, a gesture). */
  onHistory?(kind: "undo" | "redo"): void;
  /** The browser asked for bold or italic (a shortcut the page did not see as a key). */
  onFormat?(kind: "bold" | "italic"): void;
}

/** An in-place editing session (CanvasRenderer.beginTextEdit). */
export interface TextEditSession {
  readonly id: string;
  /** The editing element (for tests and focus). */
  readonly element: HTMLElement;
  /** Whether the user is composing (an input method is open). */
  readonly composing: boolean;
  /** Shows new content; the selection is kept where given, else as it was. */
  setContent(content: TextContent, selection?: TextSelection): void;
  /** A new style or text area (the element's style changed). */
  setTarget(style: TextStyle, box: Rect): void;
  selection(): TextSelection | null;
  select(selection: TextSelection): void;
  /** Height of the text, in world units. */
  contentHeight(): number;
  end(): void;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** The content as one string, paragraphs joined by "\n" (and the final one if any). */
function stringOf(rich: RichText): string {
  let out = "";
  rich.paragraphs.forEach((p, i) => {
    if (i > 0) out += "\n";
    out += paragraphText(p);
  });
  const last = rich.paragraphs[rich.paragraphs.length - 1];
  if (last?.terminated) out += "\n";
  return out;
}

/** The single replacement that turns `before` into `after` (common ends kept). */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) ===
      after.charCodeAt(after.length - 1 - end)
  )
    end++;
  return {
    index: start,
    length: before.length - start - end,
    text: after.slice(start, after.length - end),
  };
}

/**
 * Moves a local edit made on a text past a remote edit of the same text, so
 * it applies to the text with the remote edit. Edits that overlap keep the
 * local insertion, after the remote one, and drop the overlapping deletion.
 */
export function transformEdit(local: TextEdit, remote: TextEdit | null): TextEdit {
  if (remote === null) return local;
  const shift = remote.text.length - remote.length;
  if (local.index + local.length <= remote.index) return local;
  if (local.index >= remote.index + remote.length)
    return { ...local, index: local.index + shift };
  const end = local.index + local.length;
  if (end > remote.index + remote.length)
    return {
      index: remote.index + remote.text.length,
      length: end - (remote.index + remote.length),
      text: local.text,
    };
  return { index: remote.index + remote.text.length, length: 0, text: local.text };
}

/** Index of the grapheme boundary before or after `index` in `text`. */
function graphemeStep(text: string, index: number, forward: boolean): number {
  let prev = 0;
  for (const { index: at, segment } of graphemes.segment(text)) {
    const end = at + segment.length;
    if (forward && at >= index) return end;
    if (!forward && end >= index) return at < index ? at : prev;
    prev = at;
  }
  return forward ? text.length : prev;
}

/** Index of the word boundary before or after `index` in `text`. */
function wordStep(text: string, index: number, forward: boolean): number {
  const bounds: Array<{ start: number; end: number; word: boolean }> = [];
  for (const s of words.segment(text))
    bounds.push({
      start: s.index,
      end: s.index + s.segment.length,
      word: s.isWordLike === true,
    });
  if (forward) {
    let seen = false;
    for (const b of bounds) {
      if (b.end <= index) continue;
      if (b.word) return Math.max(b.end, index);
      if (seen) return b.start;
      seen = true;
    }
    return text.length;
  }
  for (let i = bounds.length - 1; i >= 0; i--) {
    const b = bounds[i]!;
    if (b.start >= index) continue;
    if (b.word) return b.start;
  }
  return 0;
}

export class DomTextEditSession implements TextEditSession {
  readonly id: string;
  readonly element: HTMLElement;
  readonly #container: HTMLElement;
  readonly #families: FontFamilies;
  readonly #options: TextEditOptions;
  readonly #off: Array<() => void> = [];
  #style: TextStyle;
  #box: Rect;
  #rich: RichText;
  /** The content as shown, as one string. */
  #text: string;
  #composing = false;
  /** Content that came while the user composed, shown when composition ends. */
  #deferred: { content: TextContent; selection?: TextSelection } | null = null;
  #ended = false;
  #rendering = false;

  constructor(
    id: string,
    container: HTMLElement,
    families: FontFamilies,
    options: TextEditOptions,
  ) {
    this.id = id;
    this.#container = container;
    this.#families = families;
    this.#options = options;
    this.#style = options.style;
    this.#box = options.box;
    const doc = container.ownerDocument;
    ensureEditStyles(doc);
    const el = doc.createElement("div");
    this.element = el;
    this.#rich = parseRichText(options.content);
    this.#text = stringOf(this.#rich);
    this.#applyStyle();
    el.className = EDIT_CLASS;
    el.contentEditable = "true";
    el.spellcheck = false;
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    el.setAttribute("autocapitalize", "off");
    fillTextRoot(el, this.#rich, this.#style, false);
    container.append(el);
    this.#listen();
    el.focus({ preventScroll: true });
    const at = options.caretAt;
    const placed = at !== undefined && this.#caretFromPoint(at.x, at.y);
    if (!placed) {
      const end = this.#maxIndex();
      this.select(options.selection ?? { index: end, length: 0 });
    }
  }

  get composing(): boolean {
    return this.#composing;
  }

  get ended(): boolean {
    return this.#ended;
  }

  #applyStyle(): void {
    const el = this.element;
    const transform = el.style.transform;
    styleTextRoot(el, this.#style, this.#box.w, this.#families);
    Object.assign(el.style, {
      outline: "none",
      cursor: "text",
      userSelect: "text",
      webkitUserSelect: "text",
      caretColor: this.#style.color,
      pointerEvents: "auto",
      zIndex: "1",
      transform,
      minHeight: `${(this.#style.lineHeight ?? 1.2) * REFERENCE_SIZE}px`,
    });
    // `all: initial` also resets WebKit's user-modify, which is what makes a
    // contenteditable element editable (and focusable) there.
    el.style.setProperty("-webkit-user-modify", "read-write");
  }

  /** The largest caret index: the content's length, less a final "\n". */
  #maxIndex(): number {
    return this.#text.endsWith("\n") ? this.#text.length - 1 : this.#text.length;
  }

  /**
   * Places the element: `m` maps the element's local box to device pixels,
   * `ratio` is device pixels per CSS pixel. Hidden when null (out of the scene).
   */
  place(m: Matrix | null, ratio: number): void {
    const el = this.element;
    if (m === null) {
      el.style.visibility = "hidden";
      return;
    }
    el.style.visibility = "visible";
    const r = this.#style.fontSize / REFERENCE_SIZE;
    const k = 1 / ratio;
    // local -> CSS pixels, then the text area's offset, then reference px -> local.
    el.style.transform =
      `matrix(${m.a * k}, ${m.b * k}, ${m.c * k}, ${m.d * k}, ${m.e * k}, ${m.f * k}) ` +
      `translate(${this.#box.x}px, ${this.#box.y}px) scale(${r})`;
  }

  setContent(content: TextContent, selection?: TextSelection): void {
    if (this.#ended) return;
    if (this.#composing) {
      this.#deferred = selection === undefined ? { content } : { content, selection };
      return;
    }
    const keep = selection ?? this.selection();
    this.#rich = parseRichText(content);
    this.#text = stringOf(this.#rich);
    this.#rendering = true;
    try {
      fillTextRoot(this.element, this.#rich, this.#style, false);
    } finally {
      this.#rendering = false;
    }
    if (keep !== null && this.#hasFocus()) this.select(keep);
  }

  setTarget(style: TextStyle, box: Rect): void {
    if (this.#ended) return;
    this.#style = style;
    this.#box = box;
    const keep = this.selection();
    this.#applyStyle();
    fillTextRoot(this.element, this.#rich, this.#style, false);
    if (keep !== null && this.#hasFocus()) this.select(keep);
  }

  contentHeight(): number {
    return this.element.offsetHeight * (this.#style.fontSize / REFERENCE_SIZE);
  }

  #hasFocus(): boolean {
    return this.element.ownerDocument.activeElement === this.element;
  }

  // -------------------------------------------------------------------------
  // Positions: DOM points <-> character indices
  // -------------------------------------------------------------------------

  /** The paragraph blocks, in order. */
  #blocks(): HTMLElement[] {
    return [...this.element.children].filter(
      (el): el is HTMLElement => el.tagName === "DIV",
    );
  }

  /** Index in the content of a DOM point inside the element, or null. */
  indexOf(node: Node, offset: number): number | null {
    const el = this.element;
    if (node !== el && !el.contains(node)) return null;
    const blocks = this.#blocks();
    const starts: number[] = [];
    let at = 0;
    for (const block of blocks) {
      starts.push(at);
      at += (block.textContent ?? "").length + 1;
    }
    const clamp = (i: number): number => Math.max(0, Math.min(this.#maxIndex(), i));
    if (node === el) {
      const child = el.childNodes[offset];
      const b = child === undefined ? -1 : blocks.indexOf(child as HTMLElement);
      if (b < 0) return clamp(at - 1);
      return clamp(starts[b]!);
    }
    let block: Node | null = node;
    while (block !== null && block.parentNode !== el) block = block.parentNode;
    const b = blocks.indexOf(block as HTMLElement);
    if (b < 0) return null;
    // Characters before the point within the block.
    const range = el.ownerDocument.createRange();
    range.setStart(block!, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    const count = range.toString().length;
    return clamp(starts[b]! + count);
  }

  /** The DOM point of an index. */
  pointOf(index: number): { node: Node; offset: number } {
    const blocks = this.#blocks();
    let at = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      const length = (block.textContent ?? "").length;
      if (index <= at + length || b === blocks.length - 1) {
        let rest = Math.max(0, Math.min(length, index - at));
        const walker = this.element.ownerDocument.createTreeWalker(
          block,
          NodeFilter.SHOW_TEXT,
        );
        let last: Text | null = null;
        for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
          const text = t as Text;
          if (rest <= text.length) return { node: text, offset: rest };
          rest -= text.length;
          last = text;
        }
        return last ? { node: last, offset: last.length } : { node: block, offset: 0 };
      }
      at += length + 1;
    }
    return { node: this.element, offset: 0 };
  }

  selection(): TextSelection | null {
    const sel = this.element.ownerDocument.getSelection();
    if (sel === null || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const a = this.indexOf(range.startContainer, range.startOffset);
    const b = this.indexOf(range.endContainer, range.endOffset);
    if (a === null || b === null) return null;
    return { index: Math.min(a, b), length: Math.abs(b - a) };
  }

  select(selection: TextSelection): void {
    const doc = this.element.ownerDocument;
    const sel = doc.getSelection();
    if (sel === null) return;
    const max = this.#maxIndex();
    const start = Math.max(0, Math.min(max, selection.index));
    const end = Math.max(start, Math.min(max, selection.index + selection.length));
    const a = this.pointOf(start);
    const b = this.pointOf(end);
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Puts the caret at a point of the drawing area; false if the browser cannot tell. */
  #caretFromPoint(x: number, y: number): boolean {
    const doc = this.element.ownerDocument as Document & {
      caretPositionFromPoint?(
        x: number,
        y: number,
      ): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const rect = this.#container.getBoundingClientRect();
    const cx = rect.left + x;
    const cy = rect.top + y;
    let point: { node: Node; offset: number } | null = null;
    if (typeof doc.caretPositionFromPoint === "function") {
      const p = doc.caretPositionFromPoint(cx, cy);
      if (p) point = { node: p.offsetNode, offset: p.offset };
    } else if (typeof doc.caretRangeFromPoint === "function") {
      const r = doc.caretRangeFromPoint(cx, cy);
      if (r) point = { node: r.startContainer, offset: r.startOffset };
    }
    if (point === null) return false;
    const index = this.indexOf(point.node, point.offset);
    if (index === null) return false;
    this.select({ index, length: 0 });
    return true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #on<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    this.element.addEventListener(type, listener as EventListener);
    this.#off.push(() =>
      this.element.removeEventListener(type, listener as EventListener),
    );
  }

  #edit(edit: TextEdit): void {
    if (edit.length === 0 && edit.text === "") return;
    this.#options.onEdit(edit);
  }

  /** The selection, or the caret at the end when there is none. */
  #current(): TextSelection {
    return this.selection() ?? { index: this.#maxIndex(), length: 0 };
  }

  /** The range a beforeinput event acts on, from its target ranges or the selection. */
  #target(e: InputEvent): TextSelection {
    const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
    const r = ranges[0];
    if (r !== undefined) {
      const a = this.indexOf(r.startContainer, r.startOffset);
      const b = this.indexOf(r.endContainer, r.endOffset);
      if (a !== null && b !== null)
        return { index: Math.min(a, b), length: Math.abs(b - a) };
    }
    return this.#current();
  }

  /** What a deletion removes: the target range, or one step from a caret. */
  #deletion(e: InputEvent): TextSelection {
    const target = this.#target(e);
    if (target.length > 0) return this.#clampDeletion(target);
    const sel = this.#current();
    if (sel.length > 0) return this.#clampDeletion(sel);
    const text = this.#text;
    const i = sel.index;
    const type = e.inputType;
    let to: number;
    if (type.includes("Word")) to = wordStep(text, i, type.endsWith("Forward"));
    else if (type.includes("Line")) {
      const start = text.lastIndexOf("\n", i - 1) + 1;
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      to = type.endsWith("Forward") ? end : start;
    } else to = graphemeStep(text, i, type.endsWith("Forward"));
    return this.#clampDeletion({ index: Math.min(i, to), length: Math.abs(to - i) });
  }

  /** A deletion never removes the content's final "\n" (it ends the last paragraph). */
  #clampDeletion(range: TextSelection): TextSelection {
    const max = this.#maxIndex();
    const index = Math.min(range.index, max);
    return {
      index,
      length: Math.max(0, Math.min(range.index + range.length, max) - index),
    };
  }

  #listen(): void {
    const el = this.element;
    this.#on("beforeinput", (e) => this.#beforeInput(e));
    this.#on("input", (e) => {
      if (!(e as InputEvent).isComposing && !this.#composing) this.#reconcile(false);
    });
    this.#on("compositionstart", () => {
      this.#composing = true;
    });
    this.#on("compositionend", () => {
      this.#composing = false;
      const deferred = this.#deferred;
      this.#deferred = null;
      if (deferred === null) {
        this.#reconcile(true);
        return;
      }
      // Others changed the text while the user composed: hand on the
      // composition moved past their change, then show their change.
      const local = diffText(this.#text, this.#shownText());
      const rich = parseRichText(deferred.content);
      const remote = diffText(this.#text, stringOf(rich));
      this.#rich = rich;
      this.#text = stringOf(rich);
      const moved = local === null ? null : transformEdit(local, remote);
      if (moved !== null) this.#edit({ ...moved, step: true });
      else this.setContent(deferred.content, deferred.selection);
    });
    this.#on("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text === "") return;
      const sel = this.#current();
      this.#edit({ ...sel, text: text.replace(/\r\n?/g, "\n"), step: true });
    });
    this.#on("drop", (e) => {
      // Dropping text moves it in ways the replacement model cannot follow.
      e.preventDefault();
    });
    this.#on("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing || this.#composing || e.keyCode === 229) return;
      if (e.key === "Tab") {
        e.preventDefault();
        return;
      }
      const special = e.ctrlKey || e.metaKey || e.altKey || e.key === "Escape";
      if (special && this.#options.onKey?.(keyOf(e))) e.preventDefault();
    });
    this.#on("keyup", (e) => e.stopPropagation());
    this.#on("keypress", (e) => e.stopPropagation());
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "contextmenu",
      "touchstart",
    ] as const)
      this.#on(type, (e: Event) => e.stopPropagation());
    const doc = el.ownerDocument;
    const onSelection = (): void => {
      if (this.#rendering || !this.#hasFocus()) return;
      this.#options.onSelection?.(this.selection());
    };
    doc.addEventListener("selectionchange", onSelection);
    this.#off.push(() => doc.removeEventListener("selectionchange", onSelection));
  }

  #beforeInput(e: InputEvent): void {
    const type = e.inputType;
    if (e.isComposing || type === "insertCompositionText" || this.#composing) return;
    switch (type) {
      case "historyUndo":
      case "historyRedo":
        e.preventDefault();
        this.#options.onHistory?.(type === "historyUndo" ? "undo" : "redo");
        return;
      case "formatBold":
      case "formatItalic":
        e.preventDefault();
        this.#options.onFormat?.(type === "formatBold" ? "bold" : "italic");
        return;
      case "insertText":
      case "insertReplacementText":
      case "insertFromPaste":
      case "insertFromDrop":
      case "insertFromYank":
      case "insertTranspose": {
        e.preventDefault();
        const text = (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").replace(
          /\r\n?/g,
          "\n",
        );
        const range = this.#target(e);
        const step = type !== "insertText" && type !== "insertReplacementText";
        this.#edit({ ...this.#clampDeletion(range), text, step });
        return;
      }
      case "insertParagraph":
      case "insertLineBreak": {
        e.preventDefault();
        this.#edit({ ...this.#clampDeletion(this.#current()), text: "\n" });
        return;
      }
      default:
        if (type.startsWith("delete")) {
          e.preventDefault();
          this.#edit({ ...this.#deletion(e), text: "" });
          return;
        }
        // Formatting the browser would do to the element itself (lists,
        // indents, colours): not ours, so nothing.
        e.preventDefault();
    }
  }

  /** The text the element shows now, in the form of the content. */
  #shownText(): string {
    const shown = this.#blocks()
      .map((b) => b.textContent ?? "")
      .join("\n");
    return this.#text.endsWith("\n") ? `${shown}\n` : shown;
  }

  /** Hands on what the browser changed in the element (composition, an uncancelled edit). */
  #reconcile(step: boolean): void {
    if (this.#ended) return;
    const now = this.#shownText();
    const edit = diffText(this.#text, now);
    if (edit === null) return;
    const caret = this.selection();
    // The element now shows the edited text; until the caller shows it again
    // (setContent), indices refer to it.
    this.#text = now;
    this.#edit({ ...edit, step });
    if (caret !== null && this.#text === now && this.#hasFocus()) this.select(caret);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const hadFocus = this.#hasFocus();
    for (const off of this.#off.splice(0)) off();
    this.element.remove();
    if (hadFocus) this.#container.focus({ preventScroll: true });
  }
}

function keyOf(e: KeyboardEvent): TextEditKey {
  return {
    key: e.key,
    code: e.code,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altGraph: typeof e.getModifierState === "function" && e.getModifierState("AltGraph"),
    repeat: e.repeat,
  };
}
