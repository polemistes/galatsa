// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing: a <textarea> laid over the canvas, styled and positioned to
// match the text box on screen, so that the browser provides the caret, selection,
// clipboard, IME composition and accessibility. The canvas text of the box is
// hidden while the textarea is shown, and updated when editing ends.
//
// Two ways to size the textarea, for comparison:
// - "screen": the font size and box width are multiplied by the zoom, so the
//   browser lays out text at its on-screen size. The caret stays one pixel wide.
// - "scaled": the textarea keeps the world font size and box width and is scaled
//   with a CSS transform, as Konva's own example does. Line breaks follow the world
//   layout exactly, but the caret and selection scale with the zoom.

import type { CameraPose, TextElement } from "@galatsa/bench";

export type EditMode = "screen" | "scaled";

export interface EditTarget {
  readonly element: TextElement;
  /** Current text (may differ from element.text after earlier edits). */
  readonly text: string;
}

export class TextEditor {
  readonly textarea: HTMLTextAreaElement;
  private target: EditTarget | undefined;
  private lastKey = "";

  private readonly viewport: { width: number; height: number };
  private readonly mode: EditMode;
  private readonly onCommit: (id: string, text: string) => void;

  /** `onCommit` is called with the final text when editing ends. */
  constructor(
    container: HTMLElement,
    viewport: { width: number; height: number },
    mode: EditMode,
    onCommit: (id: string, text: string) => void,
  ) {
    this.viewport = viewport;
    this.mode = mode;
    this.onCommit = onCommit;
    const t = document.createElement("textarea");
    t.className = "galatsa-text-editor";
    t.spellcheck = false;
    t.setAttribute("autocomplete", "off");
    t.setAttribute("aria-label", "Text");
    Object.assign(t.style, {
      position: "absolute",
      display: "none",
      margin: "0",
      padding: "0",
      border: "0",
      outline: "1px dashed rgba(0, 120, 255, 0.8)",
      background: "transparent",
      resize: "none",
      overflow: "hidden",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      boxSizing: "content-box",
      transformOrigin: "0 0",
      zIndex: "10",
    } satisfies Partial<CSSStyleDeclaration>);
    t.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
      event.stopPropagation();
    });
    t.addEventListener("blur", () => this.close());
    t.addEventListener("input", () => this.fitHeight());
    this.textarea = t;
    container.append(t);
  }

  get editingId(): string | undefined {
    return this.target?.element.id;
  }

  open(target: EditTarget, camera: CameraPose): void {
    if (this.target !== undefined) this.close();
    this.target = target;
    const e = target.element;
    const t = this.textarea;
    t.value = target.text;
    t.style.fontFamily = e.fontFamily;
    t.style.fontWeight = String(e.fontWeight);
    t.style.lineHeight = String(e.lineHeight);
    t.style.color = e.color;
    t.style.caretColor = e.color;
    t.style.textAlign = e.align;
    t.style.opacity = String(e.opacity);
    t.style.display = "block";
    this.lastKey = "";
    this.update(camera);
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }

  /** Keeps the textarea on the text box when the camera moves. */
  update(camera: CameraPose): void {
    const target = this.target;
    if (target === undefined) return;
    const key = `${camera.x},${camera.y},${camera.zoom}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const e = target.element;
    const t = this.textarea;
    const z = camera.zoom;
    // Screen position of the box's top-left corner before rotation.
    const left = (e.x - camera.x) * z + this.viewport.width / 2;
    const top = (e.y - camera.y) * z + this.viewport.height / 2;
    // Rotation is around the box centre (scene convention), with the scene's box
    // height, which is what the canvas uses too.
    const cx = (e.width / 2) * z;
    const cy = (e.height / 2) * z;
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
    const rotate = `translate(${cx}px, ${cy}px) rotate(${e.rotation}deg) translate(${-cx}px, ${-cy}px)`;
    if (this.mode === "screen") {
      t.style.fontSize = `${e.fontSize * z}px`;
      t.style.width = `${e.width * z}px`;
      t.style.transform = rotate;
    } else {
      t.style.fontSize = `${e.fontSize}px`;
      t.style.width = `${e.width}px`;
      t.style.transform = `${rotate} scale(${z})`;
    }
    this.fitHeight();
  }

  /** Ends editing and hands the text to onCommit. */
  close(): void {
    const target = this.target;
    if (target === undefined) return;
    this.target = undefined;
    const text = this.textarea.value;
    this.textarea.style.display = "none";
    if (document.activeElement === this.textarea) this.textarea.blur();
    this.onCommit(target.element.id, text);
  }

  dispose(): void {
    this.target = undefined;
    this.textarea.remove();
  }

  private fitHeight(): void {
    const t = this.textarea;
    t.style.height = "0px";
    t.style.height = `${t.scrollHeight}px`;
  }
}
