// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing in the editor (text-edit.ts), with a stand-in for the
// renderer's editing element: edits written to the shared text with their
// formatting, typing as one undo step with the height that follows it, the
// caret through undo and others' edits, keys, ending, empty boxes, and a
// pinch that takes back the press that made the box.

import type { ElementId } from "@galatsa/core";
import { dataMap, initDocument } from "@galatsa/core/ydoc";
import type { TextContent } from "@galatsa/extension-api";
import { SELECT_TOOL } from "@galatsa/extension-select";
import { TEXT_COMMANDS, TEXT_TYPE, textExtension } from "@galatsa/extension-text";
import {
  parseRichText,
  type TextEditOptions,
  type TextEditSession,
  type TextSelection,
} from "@galatsa/renderer";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor } from "./editor.ts";
import { loadExtensions } from "./extensions.ts";
import { applyTextEdit, mapSelection, TEXT_ORIGIN } from "./text-edit.ts";
import { key, nullContext, pointer, testI18n, VIEW } from "./test-support.ts";

/** A stand-in for the editing element: plain text, a selection, typing. */
class FakeSession implements TextEditSession {
  readonly id: string;
  readonly element = {} as HTMLElement;
  readonly composing = false;
  readonly options: TextEditOptions;
  text: string;
  sel: TextSelection;
  ended = false;
  targets = 0;

  constructor(id: string, options: TextEditOptions) {
    this.id = id;
    this.options = options;
    this.text = plain(options.content);
    this.sel = options.selection ?? { index: this.max(), length: 0 };
  }

  max(): number {
    return this.text.endsWith("\n") ? this.text.length - 1 : this.text.length;
  }

  setContent(content: TextContent, selection?: TextSelection): void {
    this.text = plain(content);
    if (selection) this.sel = selection;
  }

  setTarget(): void {
    this.targets++;
  }

  selection(): TextSelection | null {
    return this.sel;
  }

  select(selection: TextSelection): void {
    this.sel = selection;
  }

  contentHeight(): number {
    const lines = parseRichText(this.text).paragraphs.length;
    return lines * this.options.style.fontSize * (this.options.style.lineHeight ?? 1.2);
  }

  end(): void {
    this.ended = true;
  }

  type(text: string): void {
    this.options.onEdit({ ...this.sel, text });
  }

  key(k: string, mods: { ctrl?: boolean; shift?: boolean } = {}): boolean {
    return (
      this.options.onKey?.({
        key: k,
        code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        altKey: false,
        metaKey: false,
        altGraph: false,
        repeat: false,
      }) ?? false
    );
  }
}

function plain(content: TextContent): string {
  if (typeof content === "string") return content;
  return content.delta
    .map((op) => (typeof op.insert === "string" ? op.insert : "￼"))
    .join("");
}

function setup() {
  const i18n = testI18n();
  const doc = new Y.Doc();
  initDocument(doc);
  const loaded = loadExtensions(i18n, [textExtension]);
  if (loaded.problems.length > 0)
    throw new Error(loaded.problems.map((p) => p.detail).join());
  const sessions: FakeSession[] = [];
  const editor = new Editor({
    doc,
    host: loaded.host,
    i18n,
    platform: { mac: false },
    schedule: () => () => {},
    defaultTool: SELECT_TOOL,
    textSessions: (id, options) => {
      const s = new FakeSession(id, options);
      sessions.push(s);
      return s;
    },
  });
  editor.attach(nullContext(), VIEW);
  editor.services.camera.set({ space: null, cx: 500, cy: 400, zoom: 1 });
  // Each typing burst its own undo step, as if typed slowly.
  editor.undo.captureTimeout = 0;
  const session = (): FakeSession => sessions[sessions.length - 1]!;
  const ytext = (id: ElementId): Y.Text => dataMap(doc, id).get("text") as Y.Text;
  const textIds = (): ElementId[] =>
    [...editor.live.ids()].filter(
      (id) => !editor.live.isGone(id) && editor.live.get(id)?.type === TEXT_TYPE,
    );
  /** Makes a text box with the text tool, as a click at (x, y). */
  const click = (x: number, y: number): ElementId => {
    editor.keyDown(key("t"));
    editor.pointerDown(pointer(x, y));
    editor.pointerUp(pointer(x, y));
    // The tool is done; the editor goes back to the selection tool in a
    // microtask, which a synchronous test does not wait for.
    editor.tools.selectDefault();
    return textIds().at(-1)!;
  };
  return { editor, doc, sessions, session, ytext, textIds, click };
}

describe("applying an edit to shared text", () => {
  const text = (delta: Array<{ insert: string; attributes?: object }>): Y.Text => {
    const doc = new Y.Doc();
    const t = doc.getText("t");
    t.applyDelta(delta);
    return t;
  };

  it("gives typed text the formatting before it, never a paragraph's list", () => {
    const t = text([
      { insert: "ab", attributes: { bold: true } },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "cd\n" },
    ]);
    t.doc!.transact(() => applyTextEdit(t, { index: 2, length: 0, text: "X" }));
    t.doc!.transact(() => applyTextEdit(t, { index: 4, length: 0, text: "Y" }));
    expect(t.toDelta()).toEqual([
      { insert: "abX", attributes: { bold: true } },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "Ycd\n" },
    ]);
  });

  it("at the start of a paragraph takes the formatting after it", () => {
    const t = text([
      { insert: "a\n" },
      { insert: "b", attributes: { italic: true } },
      { insert: "\n" },
    ]);
    t.doc!.transact(() => applyTextEdit(t, { index: 2, length: 0, text: "X" }));
    expect(t.toDelta()[1]).toEqual({ insert: "Xb", attributes: { italic: true } });
  });

  it("splits a list item into two items, and Enter in an empty item ends the list", () => {
    const t = text([
      { insert: "abcd" },
      { insert: "\n", attributes: { list: "ordered" } },
    ]);
    let caret = 0;
    t.doc!.transact(
      () => (caret = applyTextEdit(t, { index: 2, length: 0, text: "\n" })),
    );
    expect(caret).toBe(3);
    expect(t.toDelta()).toEqual([
      { insert: "ab" },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "cd" },
      { insert: "\n", attributes: { list: "ordered" } },
    ]);
    t.doc!.transact(() => applyTextEdit(t, { index: 5, length: 0, text: "\n" }));
    t.doc!.transact(() => applyTextEdit(t, { index: 6, length: 0, text: "\n" }));
    expect(t.toString()).toBe("ab\ncd\n\n");
    expect(
      (t.toDelta() as Array<{ attributes?: object }>).at(-1)!.attributes,
    ).toBeUndefined();
  });

  it("Backspace takes an item out of its list; Delete before it joins the paragraphs", () => {
    const t = text([
      { insert: "a\nb" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
    t.doc!.transact(() =>
      applyTextEdit(t, { index: 1, length: 1, text: "", backward: true }),
    );
    expect(t.toDelta()).toEqual([{ insert: "a\nb\n" }]);
    t.doc!.transact(() =>
      applyTextEdit(t, { index: 1, length: 1, text: "", backward: true }),
    );
    expect(t.toString()).toBe("ab\n");
    const u = text([
      { insert: "a\nb" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
    u.doc!.transact(() => applyTextEdit(u, { index: 1, length: 1, text: "" }));
    expect(u.toDelta()).toEqual([
      { insert: "ab" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
  });

  it("adds the new paragraph when Enter ends text that has no final line break", () => {
    const t = text([{ insert: "ab" }]);
    let caret = 0;
    t.doc!.transact(
      () => (caret = applyTextEdit(t, { index: 2, length: 0, text: "\n" })),
    );
    expect(t.toString()).toBe("ab\n\n");
    expect(caret).toBe(3);
    expect(parseRichText({ $y: "text", delta: t.toDelta() }).paragraphs).toHaveLength(2);
  });

  it("moves a selection through others' changes", () => {
    expect(
      mapSelection({ index: 5, length: 2 }, [{ retain: 1 }, { insert: "xyz" }]),
    ).toEqual({
      index: 8,
      length: 2,
    });
    expect(mapSelection({ index: 5, length: 2 }, [{ retain: 1 }, { delete: 2 }])).toEqual(
      {
        index: 3,
        length: 2,
      },
    );
    expect(mapSelection({ index: 5, length: 2 }, [{ retain: 6 }, { delete: 3 }])).toEqual(
      {
        index: 5,
        length: 1,
      },
    );
    expect(
      mapSelection({ index: 5, length: 0 }, [{ retain: 9 }, { insert: "x" }]),
    ).toEqual({
      index: 5,
      length: 0,
    });
  });
});

describe("editing in place", () => {
  it("starts with the text tool, writes typing as one undo step with the height", () => {
    const { editor, session, ytext, click } = setup();
    const steps = editor.undo.undoStack.length;
    const id = click(100, 100);
    expect(editor.textEdit.id).toBe(id);
    expect(editor.services.text.current()).toMatchObject({ id, key: "text", index: 0 });
    // The element is outlined, not selected, while its text is edited.
    expect(editor.selection).toEqual([]);
    const s = session();
    const h0 = editor.live.get(id)!.size!.h;
    editor.undo.captureTimeout = 60_000;
    s.type("Hello");
    s.type("\n");
    s.type("world");
    expect(ytext(id).toString()).toBe("Hello\nworld\n");
    expect(s.text).toBe("Hello\nworld\n");
    expect(s.sel).toEqual({ index: 11, length: 0 });
    const h1 = editor.live.get(id)!.size!.h;
    expect(h1).toBeCloseTo(2 * h0, 9);
    // The insert, then the typing with the height: two steps.
    expect(editor.undo.undoStack.length).toBe(steps + 2);
    expect(s.key("z", { ctrl: true })).toBe(true);
    expect(ytext(id).toString()).toBe("\n");
    expect(editor.live.get(id)!.size!.h).toBeCloseTo(h0, 9);
    // The caret follows the undo to where the change was.
    expect(s.sel.index).toBe(0);
    expect(s.key("z", { ctrl: true, shift: true })).toBe(true);
    expect(ytext(id).toString()).toBe("Hello\nworld\n");
  });

  it("transactions of typing have the binding's origin, which undo tracks", () => {
    const { editor, session, doc, click } = setup();
    click(100, 100);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    session().type("x");
    expect(origins).toContain(TEXT_ORIGIN);
    expect(editor.undo.trackedOrigins.has(TEXT_ORIGIN)).toBe(true);
  });

  it("runs the type's own shortcuts and undo while editing, and leaves the rest to the element", () => {
    const { editor, session, ytext, click } = setup();
    const id = click(100, 100);
    const s = session();
    s.type("bold words");
    s.select({ index: 0, length: 4 });
    expect(s.key("b", { ctrl: true })).toBe(true);
    expect(ytext(id).toDelta()[0]).toEqual({
      insert: "bold",
      attributes: { bold: true },
    });
    // Bold is its own undo step, apart from the typing.
    const before = editor.undo.undoStack.length;
    expect(s.key("z", { ctrl: true })).toBe(true);
    expect(editor.undo.undoStack.length).toBe(before - 1);
    expect(ytext(id).toDelta()).toEqual([{ insert: "bold words\n" }]);
    // Select all and copy are the element's; the document's are not run.
    expect(s.key("a", { ctrl: true })).toBe(false);
    expect(s.key("c", { ctrl: true })).toBe(false);
    expect(s.key("d", { ctrl: true })).toBe(false);
    expect(editor.textEdit.id).toBe(id);
  });

  it("ends with Escape, a press on the canvas or a pinch, and keeps the text box", () => {
    const { editor, session, textIds, click } = setup();
    const id = click(100, 100);
    session().type("kept");
    expect(session().key("Escape")).toBe(true);
    expect(session().ended).toBe(true);
    expect(editor.textEdit.id).toBe(null);
    expect(editor.selection).toEqual([id]);
    expect(textIds()).toEqual([id]);
    // Enter edits the selected text again; a press elsewhere ends it.
    expect(editor.keyDown(key("Enter"))).toEqual({ kind: "edit-text" });
    expect(editor.textEdit.id).toBe(id);
    editor.pointerDown(pointer(900, 700));
    editor.pointerUp(pointer(900, 700));
    expect(editor.textEdit.id).toBe(null);
    expect(textIds()).toEqual([id]);
  });

  it("takes back a text box left empty, as if it was never made", () => {
    const { editor, session, textIds, click } = setup();
    const steps = editor.undo.undoStack.length;
    click(100, 100);
    expect(textIds()).toHaveLength(1);
    session().key("Escape");
    expect(textIds()).toEqual([]);
    expect(editor.undo.undoStack.length).toBe(steps);
    expect(editor.undo.redoStack.length).toBe(0);
  });

  it("deletes a text box whose text was typed and deleted again", () => {
    const { editor, session, textIds, click } = setup();
    click(100, 100);
    const s = session();
    s.type("ab");
    s.select({ index: 0, length: 2 });
    s.type("");
    s.key("Escape");
    expect(textIds()).toEqual([]);
    // Undo brings the text box back.
    editor.keyDown(key("z", { ctrlKey: true }));
    expect(textIds()).toHaveLength(1);
  });

  it("a pinch that started with the press takes the box back and ends the editing", () => {
    const { editor, session, textIds } = setup();
    const steps = editor.undo.undoStack.length;
    editor.keyDown(key("t"));
    editor.pointerDown(pointer(100, 100, { pointerType: "touch" }));
    expect(editor.textEdit.id).not.toBe(null);
    editor.pointerWithdraw();
    expect(session().ended).toBe(true);
    expect(editor.textEdit.id).toBe(null);
    expect(textIds()).toEqual([]);
    expect(editor.undo.undoStack.length).toBe(steps);
  });

  it("a double click on a text box edits it, with the caret where the pointer is", () => {
    const { editor, session, click, textIds } = setup();
    const id = click(100, 100);
    session().type("double");
    session().key("Escape");
    editor.services.selection.set([]);
    const count = textIds().length;
    const position = editor.live.localPosition(id);
    editor.pointerDown(pointer(110, 100));
    editor.pointerUp(pointer(110, 100));
    expect(editor.textEdit.id).toBe(null);
    editor.pointerDown(pointer(110, 100));
    editor.pointerMove(pointer(150, 140));
    editor.pointerUp(pointer(150, 140));
    expect(editor.textEdit.id).toBe(id);
    expect(session().options.caretAt).toEqual({ x: 110, y: 100 });
    // The second press was not the selection tool's: nothing moved.
    expect(editor.live.localPosition(id)).toEqual(position);
    expect(textIds()).toHaveLength(count);
  });

  it("follows edits by others and a style change of the box", () => {
    const { editor, doc, session, ytext, click } = setup();
    const id = click(100, 100);
    const s = session();
    s.type("abc");
    s.select({ index: 2, length: 0 });
    // Someone else inserts before the caret.
    doc.transact(() => ytext(id).insert(0, "XY"), "remote");
    expect(s.text).toBe("XYabc\n");
    expect(s.sel).toEqual({ index: 4, length: 0 });
    const targets = s.targets;
    expect(
      editor.run(TEXT_COMMANDS.setStyle, { ids: [id], key: "fontSize", value: 40 }).ok,
    ).toBe(true);
    expect(s.targets).toBe(targets + 1);
    // The element going away ends the editing.
    doc.transact(() => ytext(id).insert(0, "!"), "remote");
    editor.run("galatsa.basics/delete", { ids: [id] });
    expect(editor.textEdit.id).toBe(null);
    expect(s.ended).toBe(true);
  });

  it("undoing a formatting keeps the selection where it was", () => {
    const { editor, session, ytext, click } = setup();
    const id = click(100, 100);
    const s = session();
    s.type("hello world");
    s.select({ index: 6, length: 5 });
    expect(s.key("b", { ctrl: true })).toBe(true);
    expect(s.key("z", { ctrl: true })).toBe(true);
    expect(ytext(id).toDelta()).toEqual([{ insert: "hello world\n" }]);
    expect(s.sel).toEqual({ index: 6, length: 5 });
    s.type("Q");
    expect(ytext(id).toString()).toBe("hello Q\n");
    void editor;
  });

  it("keeps the selection when the focus goes elsewhere, as to a panel", () => {
    const { editor, session, ytext, doc, click } = setup();
    const id = click(100, 100);
    const s = session();
    s.type("one two three");
    s.select({ index: 4, length: 3 });
    s.options.onSelection?.(s.sel);
    // The browser no longer reports a selection (the focus is in a panel).
    s.selection = () => null;
    expect(editor.services.text.current()).toMatchObject({ index: 4, length: 3 });
    // Others' edits move it.
    doc.transact(() => ytext(id).insert(0, "zero "), "remote");
    expect(editor.services.text.current()).toMatchObject({ index: 9, length: 3 });
    expect(editor.run(TEXT_COMMANDS.bold).ok).toBe(true);
    expect(ytext(id).toDelta()[1]).toEqual({ insert: "two", attributes: { bold: true } });
  });

  it("zooms the canvas with Ctrl and plus, minus and 0 while editing", () => {
    const { editor, session, click } = setup();
    click(100, 100);
    const zoom = editor.camera.zoom;
    expect(session().key("=", { ctrl: true })).toBe(true);
    expect(editor.camera.zoom).toBeCloseTo(zoom * 2, 9);
    expect(session().key("-", { ctrl: true })).toBe(true);
    expect(session().key("0", { ctrl: true })).toBe(true);
    expect(editor.camera.zoom).toBe(1);
    expect(editor.textEdit.id).not.toBe(null);
  });

  it("keeps text composed when editing ends in the middle of it", () => {
    const { editor, sessions, ytext, click } = setup();
    const id = click(100, 100);
    const s = sessions.at(-1)!;
    s.type("ab");
    // The stand-in hands on its composition when it ends, as the element does.
    s.end = () => {
      s.ended = true;
      s.options.onEdit({ index: 2, length: 0, text: "仮名", step: true });
    };
    editor.setInputEnabled(false);
    expect(editor.textEdit.id).toBe(null);
    expect(ytext(id).toString()).toBe("ab仮名\n");
  });
});

describe("presenting", () => {
  it("ends editing in place, keeping what was typed, when a presentation starts", () => {
    const t = setup();
    const id = t.click(100, 100);
    expect(t.editor.textEdit.id).toBe(id);
    t.session().type("Hello");
    t.editor.setPresenter((_request, ended) => ({ exit: () => ended() }));
    expect(t.editor.present()).toBe(true);
    expect(t.editor.textEdit.id).toBe(null);
    expect(t.session().ended).toBe(true);
    expect(t.ytext(id).toString()).toContain("Hello");
  });
});
