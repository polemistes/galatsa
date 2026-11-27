// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing in the editor (docs/adr/0011-text.md): binds the
// renderer's editing element (CanvasRenderer.beginTextEdit) to the shared text
// of the element being edited.
//
// - Every edit the element reports is written to the Y.Text in a transaction
//   of the binding's origin, which the document's undo manager tracks, so
//   typing joins the one undo history and a burst of typing is one step
//   (docs/adr/0005, section 3.5). A command run while typing (bold) closes the
//   step, as every command does.
// - Every change of the Y.Text, from typing, undo, a command or another user,
//   is shown in the element again; the caret follows the change.
// - With `autoHeight`, the box's height follows the text in the same undo
//   step as the typing that changed it.
// - Keys with Ctrl, Cmd or Alt run undo and redo, and the shortcuts of the
//   edited type's own extension (bold, lists); everything else is the
//   element's (Ctrl+A selects the text, Ctrl+C copies it). Escape ends the
//   editing.
// - A text box left empty is removed: taken back as if never made when it
//   was made by the press that started editing and nothing was typed, else
//   deleted.

import type { ElementId, LiveResolver } from "@galatsa/core";
import {
  dataMap,
  edit,
  resizeElement,
  type DocumentUndoManager,
} from "@galatsa/core/ydoc";
import type {
  CommandOutcome,
  EditorHost,
  TextEditTarget,
} from "@galatsa/extension-api/editing";
import type { ContributionId, Shortcut } from "@galatsa/extension-api";
import { BASICS } from "@galatsa/extension-basics";
import {
  PARAGRAPH_ATTRIBUTES,
  type TextEdit,
  type TextEditKey,
  type TextEditOptions,
  type TextEditSession,
  type TextSelection,
} from "@galatsa/renderer";
import * as Y from "yjs";
import { matchShortcut, type Platform } from "./keymap.ts";
import type { EditorScene } from "./scene-source.ts";

/** Origin of the binding's transactions; the editor's undo manager tracks it. */
export const TEXT_ORIGIN = "galatsa:text-binding";

/** Starts an editing element (the renderer's beginTextEdit, or a test's stand-in). */
export type TextSessionFactory = (
  id: ElementId,
  options: TextEditOptions,
) => TextEditSession;

type Attributes = Record<string, unknown>;

interface Op {
  readonly insert: unknown;
  readonly attributes?: Attributes;
}

/** The attributes of each character of a Y.Text. */
function attributesAt(ytext: Y.Text): {
  text: string;
  attrs: (Attributes | undefined)[];
} {
  let text = "";
  const attrs: (Attributes | undefined)[] = [];
  for (const op of ytext.toDelta() as Op[]) {
    const s = typeof op.insert === "string" ? op.insert : "￼";
    text += s;
    for (let i = 0; i < s.length; i++) attrs.push(op.attributes);
  }
  return { text, attrs };
}

function charAttributes(attrs: Attributes | undefined): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs ?? {}))
    if (!PARAGRAPH_ATTRIBUTES.includes(key)) out[key] = value;
  return out;
}

function paragraphAttributes(attrs: Attributes | undefined): Attributes {
  const out: Attributes = {};
  for (const key of PARAGRAPH_ATTRIBUTES)
    if (attrs?.[key] !== undefined) out[key] = attrs[key];
  return out;
}

/**
 * Writes one edit of the editing element to the shared text and returns
 * where the caret goes. Inserted characters take the formatting of the
 * character before them in their paragraph (of the one after them at its
 * start); an inserted "\n" splits a paragraph and gives both halves its list.
 * Two edits read as list editing: Enter in an empty list item ends the list,
 * and deleting the "\n" before a list item takes the item out of the list
 * instead of joining it to the paragraph before. Runs inside a transaction
 * of the caller's.
 */
export function applyTextEdit(ytext: Y.Text, change: TextEdit): number {
  const { text, attrs } = attributesAt(ytext);
  const index = Math.max(0, Math.min(text.length, change.index));
  const length = Math.max(0, Math.min(text.length - index, change.length));
  const nextNl = (from: number): number => {
    const nl = text.indexOf("\n", from);
    return nl < 0 ? -1 : nl;
  };
  // Deleting the "\n" before a list item: out of the list instead.
  if (length === 1 && change.text === "" && text[index] === "\n") {
    const end = nextNl(index + 1);
    if (end >= 0 && attrs[end]?.["list"] != null) {
      ytext.format(end, 1, { list: null });
      return index + 1;
    }
  }
  // Enter in an empty list item: out of the list.
  if (length === 0 && change.text === "\n" && text[index] === "\n") {
    const start = text.lastIndexOf("\n", index - 1) + 1;
    if (start === index && attrs[index]?.["list"] != null) {
      ytext.format(index, 1, { list: null });
      return index;
    }
  }
  if (length > 0) ytext.delete(index, length);
  if (change.text === "") return index;
  // Formatting after the deletion: the character before, in the paragraph.
  const after = attributesAt(ytext);
  const before =
    index > 0 && after.text[index - 1] !== "\n" ? after.attrs[index - 1] : undefined;
  const next =
    after.text[index] !== undefined && after.text[index] !== "\n"
      ? after.attrs[index]
      : undefined;
  const chars = charAttributes(before ?? next);
  const end = after.text.indexOf("\n", index);
  const paragraph = paragraphAttributes(end < 0 ? undefined : after.attrs[end]);
  let at = index;
  const parts = change.text.split("\n");
  parts.forEach((part, i) => {
    if (i > 0) {
      ytext.insert(at, "\n", { ...nullOf(chars), ...nullParagraph(), ...paragraph });
      at += 1;
    }
    if (part !== "") {
      ytext.insert(at, part, { ...nullParagraph(), ...chars });
      at += part.length;
    }
  });
  // Enter at the very end of text without a final "\n" (older or foreign
  // text): that "\n" would only end the last paragraph, so add the new one.
  if (parts.length > 1 && at === ytext.length && !after.text.endsWith("\n"))
    ytext.insert(at, "\n", { ...nullOf(chars), ...nullParagraph(), ...paragraph });
  return at;
}

function nullOf(attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const key of Object.keys(attrs)) out[key] = null;
  return out;
}

function nullParagraph(): Attributes {
  const out: Attributes = {};
  for (const key of PARAGRAPH_ATTRIBUTES) out[key] = null;
  return out;
}

/** Moves a selection through a Y.Text change (a delta of retain, insert, delete). */
export function mapSelection(
  selection: TextSelection,
  delta: ReadonlyArray<{ retain?: number; insert?: unknown; delete?: number }>,
): TextSelection {
  // Positions are walked in the old text's coordinates; an insertion at a
  // position moves it, as typing at the caret moves the caret.
  const map = (pos: number): number => {
    let at = 0;
    let out = pos;
    for (const op of delta) {
      if (at > pos) break;
      if (op.retain !== undefined) at += op.retain;
      else if (op.insert !== undefined)
        out += typeof op.insert === "string" ? op.insert.length : 1;
      else if (op.delete !== undefined) {
        if (at < pos) out -= Math.min(op.delete, pos - at);
        at += op.delete;
      }
    }
    return out;
  };
  const start = map(selection.index);
  const end = map(selection.index + selection.length);
  return { index: start, length: Math.max(0, end - start) };
}

/** Where a change starts and ends: the caret after an undo or redo. */
function changeEnd(
  delta: ReadonlyArray<{ retain?: number; insert?: unknown; delete?: number }>,
): number {
  let at = 0;
  let end = 0;
  for (const op of delta) {
    if (op.retain !== undefined) at += op.retain;
    else if (op.insert !== undefined) {
      at += typeof op.insert === "string" ? op.insert.length : 1;
      end = at;
    } else if (op.delete !== undefined) end = at;
  }
  return end;
}

/** The plain text without a final "\n": empty means nothing to keep. */
function isEmptyText(ytext: Y.Text): boolean {
  return ytext.toString().replace(/\n$/, "") === "";
}

/** What the controller needs from the editor. */
export interface TextEditHost {
  readonly doc: Y.Doc;
  readonly host: EditorHost;
  readonly undo: DocumentUndoManager;
  readonly scene: EditorScene;
  readonly live: LiveResolver;
  readonly platform: Platform;
  /** The keyboard map: shortcut to command or tool. */
  keymap(): ReadonlyMap<Shortcut, { readonly kind: string; readonly id: ContributionId }>;
  runFromShortcut(command: ContributionId): CommandOutcome;
  run(command: ContributionId, args?: unknown): CommandOutcome;
  /** Editing started, ended or its selection moved. */
  changed(): void;
  /** Editing of an element ended and the element is still there. */
  ended?(id: ElementId): void;
  invalidate(): void;
}

/** Where a fresh text box's creation can be taken back: the undo steps around it. */
export interface FreshMark {
  /** The undo steps before the press that made it, and the last of them. */
  readonly steps: number;
  readonly top: unknown;
}

interface Active {
  readonly id: ElementId;
  readonly key: string;
  readonly ytext: Y.Text;
  readonly session: TextEditSession;
  readonly extension: string;
  target: TextEditTarget;
  readonly observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;
  /** Undo steps when editing began, and the last of them. */
  readonly began: { readonly steps: number; readonly top: unknown };
  readonly fresh: FreshMark | null;
  /** The caret to show after the binding's own edit. */
  caret: number | null;
}

export class TextEditController {
  readonly #host: TextEditHost;
  readonly #factory: TextSessionFactory;
  #active: Active | null = null;

  constructor(host: TextEditHost, factory: TextSessionFactory) {
    this.#host = host;
    this.#factory = factory;
    host.undo.trackedOrigins.add(TEXT_ORIGIN);
  }

  get id(): ElementId | null {
    return this.#active?.id ?? null;
  }

  get session(): TextEditSession | null {
    return this.#active?.session ?? null;
  }

  /** The text being edited and its selection (the editor's text service). */
  current(): { id: ElementId; key: string; index: number; length: number } | null {
    const a = this.#active;
    if (a === null) return null;
    const sel = a.session.selection() ?? { index: a.ytext.length, length: 0 };
    return { id: a.id, key: a.key, index: sel.index, length: sel.length };
  }

  select(index: number, length: number): void {
    this.#active?.session.select({ index, length });
    this.#host.changed();
  }

  /** Where editing would happen for an element, or null if it cannot be edited in place. */
  targetOf(
    id: ElementId,
  ): { target: TextEditTarget; extension: string; ytext: Y.Text } | null {
    const host = this.#host.host;
    const record = this.#host.scene.element(id);
    const live = this.#host.live;
    if (record === undefined || live.isGone(id) || live.isLocked(id)) return null;
    if (!host.capabilities(record).editContent) return null;
    const type = host.elementType(record.type);
    const editing = type?.editing;
    if (!type || !editing?.textEditing) return null;
    const read = host.read(record);
    if (read === undefined) return null;
    const size = record.size ?? { w: 0, h: 0 };
    const target = editing.textEditing(read.model, { id, w: size.w, h: size.h });
    if (target === null) return null;
    let ytext: unknown;
    try {
      ytext = dataMap(this.#host.doc, id).get(target.key);
    } catch {
      return null;
    }
    if (!(ytext instanceof Y.Text)) return null;
    return { target, extension: type.extension, ytext };
  }

  /** Whether an element's text can be edited in place. */
  canEdit(id: ElementId): boolean {
    return this.targetOf(id) !== null;
  }

  /**
   * Starts editing an element's text. `caretAt` puts the caret at a point of
   * the drawing area; `fresh`, the undo steps before the press that made the
   * element, lets an empty box be taken back as if never made.
   */
  begin(
    id: ElementId,
    options: { caretAt?: { x: number; y: number }; fresh?: FreshMark | null } = {},
  ): boolean {
    const found = this.targetOf(id);
    if (found === null) return false;
    this.end();
    const { target, extension, ytext } = found;
    const undo = this.#host.undo;
    let active: Active | null = null;
    const session = this.#factory(id, {
      style: target.style,
      box: target.box,
      content: { $y: "text", delta: ytext.toDelta() as Op[] as never },
      ...(options.caretAt !== undefined ? { caretAt: options.caretAt } : {}),
      onEdit: (change) => {
        if (active !== null) this.#edit(active, change);
      },
      onKey: (key) => this.#key(key),
      onSelection: () => this.#host.changed(),
      onHistory: (kind) => {
        this.#host.runFromShortcut(kind === "undo" ? BASICS.undo : BASICS.redo);
      },
      onFormat: (kind) => {
        const command = `${extension}/${kind}`;
        if (this.#host.host.commands.get(command) !== undefined)
          this.#host.runFromShortcut(command);
      },
    });
    const observer = (event: Y.YTextEvent, tr: Y.Transaction): void => {
      if (active === null || this.#active !== active) return;
      const content = { $y: "text" as const, delta: ytext.toDelta() as never };
      let selection: TextSelection | undefined;
      if (tr.origin === TEXT_ORIGIN && active.caret !== null) {
        selection = { index: active.caret, length: 0 };
        active.caret = null;
      } else if (tr.origin === undo) {
        selection = { index: changeEnd(event.delta as never), length: 0 };
      } else {
        const now = session.selection();
        if (now !== null) selection = mapSelection(now, event.delta as never);
      }
      session.setContent(content, selection);
      this.#host.changed();
    };
    active = {
      id,
      key: target.key,
      ytext,
      session,
      extension,
      target,
      observer,
      began: {
        steps: undo.undoStack.length,
        top: undo.undoStack[undo.undoStack.length - 1],
      },
      fresh: options.fresh ?? null,
      caret: null,
    };
    ytext.observe(observer);
    this.#active = active;
    this.#host.changed();
    this.#host.invalidate();
    return true;
  }

  #edit(active: Active, change: TextEdit): void {
    const doc = this.#host.doc;
    edit(
      doc,
      () => {
        active.caret = applyTextEdit(active.ytext, change);
      },
      { origin: TEXT_ORIGIN },
    );
    active.caret = null;
    this.#fitHeight(active);
  }

  /** With autoHeight, the box's height follows the text, in the typing's undo step. */
  #fitHeight(active: Active): void {
    if (!active.target.autoHeight || this.#active !== active) return;
    const record = this.#host.scene.element(active.id);
    const size = record?.size;
    if (!size) return;
    const h = Math.max(active.session.contentHeight(), 0) + active.target.box.y;
    const extra = size.h - (active.target.box.y + active.target.box.h);
    const want = h + Math.max(0, extra);
    if (!(want > 0) || Math.abs(want - size.h) <= size.h * 1e-9) return;
    resizeElement(this.#host.doc, active.id, size.w, want, { origin: TEXT_ORIGIN });
  }

  /** A key with a modifier, or Escape, from the editing element. */
  #key(key: TextEditKey): boolean {
    const active = this.#active;
    if (active === null) return false;
    if (key.key === "Escape" && !key.ctrlKey && !key.metaKey && !key.altKey) {
      this.end();
      return true;
    }
    const match = matchShortcut(key, this.#host.platform, this.#host.keymap());
    if (match === undefined || match.value.kind !== "command") return false;
    const command = match.value.id;
    const own =
      command === BASICS.undo ||
      command === BASICS.redo ||
      command.startsWith(`${active.extension}/`);
    if (!own) return false;
    this.#host.runFromShortcut(command);
    return true;
  }

  /** The document changed: follow the element's style and box; end if it went away. */
  documentChanged(ids: ReadonlySet<ElementId> | readonly ElementId[]): void {
    const active = this.#active;
    if (active === null) return;
    const has = Array.isArray(ids)
      ? ids.includes(active.id)
      : (ids as ReadonlySet<ElementId>).has(active.id);
    if (!has) return;
    const found = this.targetOf(active.id);
    if (found === null || found.ytext !== active.ytext) {
      this.#stop(active);
      return;
    }
    const { target } = found;
    const same =
      JSON.stringify(target.style) === JSON.stringify(active.target.style) &&
      JSON.stringify(target.box) === JSON.stringify(active.target.box);
    active.target = target;
    if (!same) active.session.setTarget(target.style, target.box);
  }

  /** Ends editing. A text box left empty is removed (see the top of this file). */
  end(): void {
    const active = this.#active;
    if (active === null) return;
    this.#stop(active);
    if (this.#host.scene.element(active.id) === undefined) return;
    if (this.#host.live.isGone(active.id)) return;
    if (!isEmptyText(active.ytext)) {
      this.#host.ended?.(active.id);
      return;
    }
    const undo = this.#host.undo;
    const fresh = active.fresh;
    const untouched =
      undo.undoStack.length === active.began.steps &&
      undo.undoStack[undo.undoStack.length - 1] === active.began.top;
    if (fresh !== null && untouched && undo.undoStack[fresh.steps - 1] === fresh.top) {
      let taken = 0;
      while (undo.undoStack.length > fresh.steps) {
        const length = undo.undoStack.length;
        undo.undo();
        if (undo.undoStack.length >= length) break;
        taken++;
      }
      undo.redoStack.splice(Math.max(0, undo.redoStack.length - taken), taken);
      return;
    }
    this.#host.run(BASICS.delete, { ids: [active.id] });
  }

  #stop(active: Active): void {
    if (this.#active !== active) return;
    this.#active = null;
    active.ytext.unobserve(active.observer);
    active.session.end();
    this.#host.changed();
    this.#host.invalidate();
  }
}
