// SPDX-License-Identifier: GPL-3.0-or-later

// The system clipboard as the editor reads and writes it: a paste lands where
// the copy came from, inside the frame it was copied from while that is
// there; what is pasted is limited before it is parsed and before it is
// pasted, and refused with a notice; envelopes of another version are
// recognised and refused, never handed on as text; plain text that is not an
// envelope is not parsed.

import type { ElementId } from "@galatsa/core";
import { setLocked } from "@galatsa/core/ydoc";
import { INSERT_FRAME } from "@galatsa/extension-basics/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENVELOPE_KIND,
  FRAGMENT_MIME,
  MAX_CLIPBOARD_TEXT,
  MAX_PASTE_DEPTH,
  MAX_PASTE_ELEMENTS,
  decodeEnvelope,
  readClipboard,
  readClipboardText,
  withinLimits,
  type ClipboardSource,
} from "./clipboard.ts";
import type { Editor } from "./editor.ts";
import { testEditor } from "./test-support.ts";

const editors: Editor[] = [];
function make(): Editor {
  const { editor } = testEditor();
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  vi.restoreAllMocks();
});

function must<R>(editor: Editor, command: string, args?: unknown): R {
  const outcome = editor.run<R>(command, args);
  if (!outcome.ok) throw new Error(`${command}: ${outcome.reason}`);
  return outcome.value;
}

function rect(
  editor: Editor,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: ElementId | null = null,
): ElementId {
  return must<ElementId>(editor, "examples.shape/insert", {
    kind: "rect",
    x,
    y,
    w,
    h,
    parent,
  });
}

function world(editor: Editor, id: ElementId) {
  const p = editor.services.scene.placement(id)!;
  return { x: p.worldX, y: p.worldY, parent: p.parent };
}

function clipboardData(): ClipboardSource & {
  setData(type: string, data: string): void;
} {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    getData: (type) => store.get(type) ?? "",
    setData: (type, data) => {
      store.set(type, data);
    },
  };
}

function only(type: string, text: string): ClipboardSource {
  const data = clipboardData();
  data.setData(type, text);
  return data;
}

/** An envelope of this version around `fragment`. */
function envelope(fragment: unknown, version = 1): string {
  return JSON.stringify({ kind: ENVELOPE_KIND, version, fragment });
}

/** A fragment of `count` shapes side by side, or of groups nested `depth` deep. */
function fragmentOf(shape: { count?: number; depth?: number }) {
  const elements: Record<string, unknown> = {};
  const base = (parent: string | null, type: string) => ({
    type,
    typeVersion: 1,
    parent,
    order: "a0",
    pos: { x: 0, y: 0, space: parent },
    rebase: null,
    name: "",
    locked: false,
    rev: {},
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: {},
  });
  const id = (i: number) => `e${String(i).padStart(21, "0")}`;
  if (shape.count !== undefined) {
    for (let i = 0; i < shape.count; i++)
      elements[id(i)] = {
        ...base(null, "test.missing/thing"),
        size: { w: 1, h: 1 },
        rot: 0,
      };
    return {
      elements,
      roots: Object.keys(elements),
      stops: {},
      routes: {},
      fallbackViews: {},
      assets: {},
    };
  }
  for (let i = 0; i < shape.depth!; i++)
    elements[id(i)] = base(i === 0 ? null : id(i - 1), "core/group");
  return {
    elements,
    roots: [id(0)],
    stops: {},
    routes: {},
    fallbackViews: {},
    assets: {},
  };
}

describe("where a paste lands", () => {
  it("pastes an element copied from a frame back into that frame, on the original", () => {
    const editor = make();
    const frame = must<ElementId>(editor, INSERT_FRAME, {
      x: 400,
      y: 300,
      w: 300,
      h: 300,
    });
    const a = rect(editor, 20, 20, 50, 50, frame);
    editor.services.selection.set([a]);
    const data = clipboardData();
    expect(editor.clipboardCopy(data)).toBe(true);
    expect(editor.clipboardPaste(readClipboard(data))).toBe(true);
    const [pasted] = editor.selection;
    expect(world(editor, pasted!)).toEqual({ x: 420, y: 320, parent: frame });
    // The editor's own copy (the context menu's fallback) lands there too.
    expect(editor.clipboardPaste()).toBe(true);
    expect(world(editor, editor.selection[0]!)).toEqual({
      x: 420,
      y: 320,
      parent: frame,
    });
  });

  it("pastes on the canvas at the same place when the frame is not there or is locked", () => {
    const editor = make();
    const frame = must<ElementId>(editor, INSERT_FRAME, {
      x: 400,
      y: 300,
      w: 300,
      h: 300,
    });
    const a = rect(editor, 20, 20, 50, 50, frame);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    // Another document has no such frame: root space, same place.
    const other = make();
    expect(other.clipboardPaste(readClipboard(data))).toBe(true);
    expect(world(other, other.selection[0]!)).toEqual({ x: 420, y: 320, parent: null });
    // A locked frame takes nothing in.
    setLocked(editor.doc, frame, true);
    expect(editor.clipboardPaste(readClipboard(data))).toBe(true);
    expect(world(editor, editor.selection[0]!)).toEqual({ x: 420, y: 320, parent: null });
  });

  it("brings what was copied out of sight inside a frame to the middle of the view", () => {
    const editor = make();
    const frame = must<ElementId>(editor, INSERT_FRAME, {
      x: 4000,
      y: 3000,
      w: 300,
      h: 300,
    });
    const a = rect(editor, 20, 20, 100, 100, frame);
    editor.services.selection.set([a]);
    const data = clipboardData();
    editor.clipboardCopy(data);
    // The view is 0..1000 by 0..800.
    expect(editor.clipboardPaste(readClipboard(data))).toBe(true);
    expect(world(editor, editor.selection[0]!)).toEqual({
      x: 450,
      y: 350,
      parent: frame,
    });
  });
});

describe("limits and versions", () => {
  it("does not parse plain text that does not start like an envelope", () => {
    const parse = vi.spyOn(JSON, "parse");
    const text = `{ "a": 1 } ${"x".repeat(1000)}`;
    expect(readClipboard(only("text/plain", text))).toMatchObject({
      fragment: undefined,
      problem: null,
      text,
    });
    expect(decodeEnvelope("[1, 2, 3]")).toEqual({ kind: "text" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses text longer than the limit before parsing it", () => {
    const parse = vi.spyOn(JSON, "parse");
    const huge = `{"kind":"galatsa/fragment","version":1,"fragment":"${"x".repeat(MAX_CLIPBOARD_TEXT)}"}`;
    expect(readClipboard(only(FRAGMENT_MIME, huge))).toMatchObject({
      fragment: undefined,
      problem: "too-large",
      text: null,
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses too many elements and too deep nesting, quickly, with a translated notice", () => {
    expect(withinLimits(fragmentOf({ count: MAX_PASTE_ELEMENTS }))).toBe(true);
    expect(withinLimits(fragmentOf({ count: MAX_PASTE_ELEMENTS + 1 }))).toBe(false);
    expect(withinLimits(fragmentOf({ depth: MAX_PASTE_DEPTH }))).toBe(true);
    expect(withinLimits(fragmentOf({ depth: MAX_PASTE_DEPTH + 1 }))).toBe(false);

    const editor = make();
    const steps = editor.undo.undoStack.length;
    const started = performance.now();
    const deep = readClipboard(
      only("text/plain", envelope(fragmentOf({ depth: 20000 }))),
    );
    expect(deep.problem).toBe("too-large");
    expect(editor.clipboardPaste(deep)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(editor.notice).toEqual({ message: "editor:paste.tooLarge" });
    expect(editor.i18n.t(editor.notice!.message)).toMatch(/too much/);
    expect(editor.undo.undoStack.length).toBe(steps);
    editor.dismissNotice();
    expect(editor.notice).toBeNull();
    // The same limits hold for the editor's own memory of a copy.
    const many = readClipboard(
      only(FRAGMENT_MIME, envelope(fragmentOf({ count: MAX_PASTE_ELEMENTS + 1 }))),
    );
    expect(many.problem).toBe("too-large");
  });

  it("recognises an envelope of another version and refuses it, in either type", () => {
    const newer = envelope({ elements: {}, roots: [] }, 2);
    for (const source of [only(FRAGMENT_MIME, newer), only("text/plain", newer)]) {
      expect(readClipboard(source)).toMatchObject({
        fragment: undefined,
        problem: "other-version",
        text: null,
      });
    }
    const both = clipboardData();
    both.setData(FRAGMENT_MIME, newer);
    both.setData("text/plain", newer);
    expect(readClipboard(both)).toMatchObject({ problem: "other-version", text: null });
    expect(readClipboardText(newer).problem).toBe("other-version");
    const editor = make();
    expect(editor.clipboardPaste(readClipboard(both))).toBe(false);
    expect(editor.notice).toEqual({ message: "editor:paste.otherVersion" });
  });

  it("tells of a damaged envelope, and of a fragment paste refuses", () => {
    const editor = make();
    const broken = `{"kind":"galatsa/fragment","version":1,"fragment":`;
    expect(readClipboardText(broken).problem).toBe("damaged");
    expect(editor.clipboardPaste(readClipboardText(broken))).toBe(false);
    expect(editor.notice).toEqual({ message: "editor:paste.damaged" });
    editor.dismissNotice();
    const refused = readClipboardText(envelope({ roots: 1 }));
    expect(refused.problem).toBeNull();
    expect(editor.clipboardPaste(refused)).toBe(false);
    expect(editor.notice).toEqual({ message: "editor:paste.damaged" });
  });
});
