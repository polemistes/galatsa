// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing for a text drawn on the canvas. A hidden textarea is the
// input sink and holds the text and the selection while editing: typing, deleting,
// paste, cut, copy, undo, word-wise movement and IME composition are the browser's
// own. The canvas draws the text, the selection, the composition underline and the
// caret from the textarea's state. Only what depends on our line layout is done
// here: up and down, Home and End, and mouse positions. The textarea follows the
// caret on screen, so IME candidate windows open next to it.

import {
  caretX,
  fontString,
  lineIndexOf,
  type Measurer,
  offsetAtX,
  previousGrapheme,
  type TextLayout,
  wordAt,
} from "./text-layout.ts";

export interface EditHost {
  readonly container: HTMLElement;
  readonly measurer: Measurer;
  layoutOf(id: string): TextLayout;
  setText(id: string, text: string): void;
  /** CSS pixels in the container for a point in box coordinates (world units from the box's top-left). */
  boxToScreen(id: string, x: number, y: number): { x: number; y: number };
  /** CSS pixels per world unit. */
  zoom(): number;
  invalidate(): void;
  /** The user pressed Escape. */
  requestExit(): void;
}

export interface EditState {
  readonly id: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly direction: "forward" | "backward" | "none";
  readonly composition: { readonly start: number; readonly end: number } | null;
  readonly focused: boolean;
}

const CARET_BLINK_MS = 530;

export class TextEditor {
  readonly id: string;
  private readonly host: EditHost;
  readonly textarea: HTMLTextAreaElement;
  private composition: { start: number; end: number } | null = null;
  private compositionStart = 0;
  private goalX: number | null = null;
  private lastActivity = performance.now();
  private placed = "";
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  /** Set to false to keep the caret always visible (for screenshots and tests). */
  blink = true;

  constructor(host: EditHost, id: string, offset: number) {
    this.host = host;
    this.id = id;
    const ta = document.createElement("textarea");
    ta.value = host.layoutOf(id).text;
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.wrap = "off";
    Object.assign(ta.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "1px",
      padding: "0",
      border: "0",
      margin: "0",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      whiteSpace: "pre",
      opacity: "0",
      pointerEvents: "none",
      lineHeight: "1",
      background: "transparent",
      color: "transparent",
      caretColor: "transparent",
    } satisfies Partial<CSSStyleDeclaration>);
    this.textarea = ta;
    host.container.append(ta);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(offset, offset);

    const activity = () => {
      this.lastActivity = performance.now();
      host.invalidate();
    };
    this.on(ta, "input", () => {
      host.setText(id, ta.value);
      activity();
    });
    this.on(ta, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    this.on(ta, "keyup", activity);
    this.on(ta, "select", activity);
    this.on(ta, "focus", activity);
    this.on(ta, "blur", activity);
    this.on(document, "selectionchange", activity);
    this.on(ta, "compositionstart", () => {
      this.compositionStart = Math.min(ta.selectionStart, ta.selectionEnd);
      this.composition = { start: this.compositionStart, end: this.compositionStart };
      activity();
    });
    this.on(ta, "compositionupdate", (e) => {
      const data = (e as CompositionEvent).data ?? "";
      this.composition = {
        start: this.compositionStart,
        end: this.compositionStart + data.length,
      };
      activity();
    });
    this.on(ta, "compositionend", () => {
      this.composition = null;
      activity();
    });
  }

  private on(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  state(): EditState {
    const ta = this.textarea;
    return {
      id: this.id,
      text: ta.value,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
      direction: ta.selectionDirection,
      composition: this.composition === null ? null : { ...this.composition },
      focused: document.activeElement === ta,
    };
  }

  private anchorFocus(): { anchor: number; focus: number } {
    const ta = this.textarea;
    return ta.selectionDirection === "backward"
      ? { anchor: ta.selectionEnd, focus: ta.selectionStart }
      : { anchor: ta.selectionStart, focus: ta.selectionEnd };
  }

  /** The caret end of the selection. */
  get focusOffset(): number {
    return this.anchorFocus().focus;
  }

  setSelection(anchor: number, focus: number): void {
    const ta = this.textarea;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    ta.setSelectionRange(
      Math.min(anchor, focus),
      Math.max(anchor, focus),
      focus < anchor ? "backward" : "forward",
    );
    this.goalX = null;
    this.lastActivity = performance.now();
    this.host.invalidate();
  }

  /** Keeps the anchor and moves the focus (shift-click, drag). */
  extendTo(focus: number): void {
    this.setSelection(this.anchorFocus().anchor, focus);
  }

  selectWordAt(offset: number): void {
    const { start, end } = wordAt(this.textarea.value, offset);
    this.setSelection(start, end);
  }

  caretVisible(now: number): boolean {
    if (document.activeElement !== this.textarea) return false;
    if (!this.blink) return true;
    return Math.floor((now - this.lastActivity) / CARET_BLINK_MS) % 2 === 0;
  }

  get composing(): { start: number; end: number } | null {
    return this.composition;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.lastActivity = performance.now();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.host.requestExit();
      return;
    }
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    const layout = this.host.layoutOf(this.id);
    const { anchor, focus } = this.anchorFocus();
    const move = (to: number) => {
      const goal = this.goalX;
      if (e.shiftKey) this.setSelection(anchor, to);
      else this.setSelection(to, to);
      this.goalX = goal;
      e.preventDefault();
    };
    if (plain && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const line = lineIndexOf(layout, focus);
      this.goalX ??= caretX(this.host.measurer, layout, line, focus);
      const target = line + (e.key === "ArrowUp" ? -1 : 1);
      if (target < 0) move(0);
      else if (target >= layout.lines.length) move(layout.text.length);
      else move(offsetAtX(this.host.measurer, layout, target, this.goalX));
      return;
    }
    if (plain && (e.key === "Home" || e.key === "End")) {
      const index = lineIndexOf(layout, focus);
      const line = layout.lines[index]!;
      if (e.key === "Home") {
        move(line.start);
      } else {
        const next = layout.lines[index + 1];
        const wrapped =
          next !== undefined && next.start === line.end && line.end > line.start;
        move(wrapped ? previousGrapheme(layout.text, line.end) : line.end);
      }
      this.goalX = null;
      return;
    }
    this.goalX = null;
    this.host.invalidate();
  }

  /** Moves the hidden textarea to the caret, so IME candidate windows open there. */
  placeInput(): void {
    const layout = this.host.layoutOf(this.id);
    const focus = this.composition?.start ?? this.focusOffset;
    const index = lineIndexOf(layout, focus);
    const x = caretX(this.host.measurer, layout, index, focus);
    const p = this.host.boxToScreen(this.id, x, index * layout.lineHeight);
    const zoom = this.host.zoom();
    const fontPx = Math.min(1000, Math.max(1, layout.fontSize * zoom));
    const linePx = Math.min(1000, Math.max(1, layout.lineHeight * zoom));
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${fontPx.toFixed(1)}`;
    if (key === this.placed) return;
    this.placed = key;
    const s = this.textarea.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    s.height = `${linePx}px`;
    s.font = fontString(layout.font, fontPx);
  }

  dispose(): void {
    for (const [target, type, listener] of this.listeners)
      target.removeEventListener(type, listener);
    this.listeners.length = 0;
    this.textarea.remove();
  }
}
