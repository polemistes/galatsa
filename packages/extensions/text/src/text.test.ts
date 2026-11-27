// SPDX-License-Identifier: GPL-3.0-or-later

// The text extension against the real document model: loading with its texts
// in both languages, reading data (with lenient reading of values a later
// version may write), inserting a text box as one undo step, the style
// fields, bold and italic and lists on the edited selection or on whole
// boxes, the tool, and drawing.

import type { ElementId } from "@galatsa/core";
import { createUndoManager, dataMap, initDocument } from "@galatsa/core/ydoc";
import { ViewHost } from "@galatsa/extension-api";
import { EditorHost, type CommandEnvironment } from "@galatsa/extension-api/editing";
import {
  createRecordingDrawContext,
  createTestServices,
} from "@galatsa/extension-api/testing";
import { createI18n, memoryLocaleStorage, type Locale } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_COLOR,
  DEFAULT_SIZE,
  TEXT_COMMANDS,
  TEXT_TYPE,
  fontSizeAt,
  paragraphsIn,
  readText,
  textExtension,
  textView,
  textViewExtension,
  wordAt,
} from "./index.ts";

function setup(locale: Locale = "en") {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc, { captureTimeout: 0 });
  const i18n = createI18n({ dev: false, locale, storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  const problems = host.load([textExtension]);
  const services = createTestServices(doc);
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const run = <R = unknown>(id: string, args?: unknown) =>
    host.commands.execute<R>(id, env(), args);
  const must = <R = unknown>(id: string, args?: unknown): R => {
    const outcome = run<R>(id, args);
    if (!outcome.ok) throw new Error(`${id}: ${outcome.reason} ${String(outcome.error)}`);
    return outcome.value;
  };
  const text = (id: ElementId): Y.Text => dataMap(doc, id).get("text") as Y.Text;
  return { doc, undo, i18n, host, problems, services, run, must, text, env };
}

describe("loading", () => {
  it("loads with its texts in both languages", () => {
    for (const locale of ["nb", "en"] as const) {
      const { problems, i18n, host } = setup(locale);
      expect(problems).toEqual([]);
      expect(i18n.t("galatsa.text:name")).not.toBe("galatsa.text:name");
      expect(host.tools("quick").map((t) => t.id)).toContain("galatsa.text/text");
    }
  });

  it("the viewing part loads alone and draws", () => {
    const i18n = createI18n({ dev: false, locale: "en", storage: memoryLocaleStorage() });
    const host = new ViewHost({ i18n });
    expect(host.load([textViewExtension])).toEqual([]);
    const ctx = createRecordingDrawContext();
    const element = {
      type: TEXT_TYPE,
      typeVersion: 1,
      data: { text: { $y: "text" as const, delta: [{ insert: "Hi\n" }] } },
      size: { w: 100, h: 30 },
      rot: 0,
    };
    host.drawElement(ctx, element, "t");
    expect(ctx.calls.map((c) => c.op)).toContain("text");
  });
});

describe("reading", () => {
  it("reads missing keys as their defaults without a report", () => {
    const reports: string[] = [];
    expect(readText({}, (p) => reports.push(p))).toEqual({
      text: { $y: "text", delta: [] },
      fontFamily: "sans",
      fontSize: DEFAULT_SIZE,
      color: DEFAULT_COLOR,
      align: "left",
    });
    expect(reports).toEqual([]);
  });

  it("keeps a family or alignment of a later version without a report, and draws a default", () => {
    const reports: string[] = [];
    const model = readText({ fontFamily: "handwriting", align: "justify" }, (p) =>
      reports.push(p),
    );
    expect(reports).toEqual([]);
    expect(model.fontFamily).toBe("handwriting");
    expect(model.align).toBe("justify");
    const ctx = createRecordingDrawContext();
    textView.draw(model, ctx, { id: "t", w: 100, h: 20 });
    const drawn = ctx.calls.find((c) => c.op === "text") as { style: { align: string } };
    expect(drawn.style.align).toBe("left");
  });

  it("reports values that do not fit", () => {
    const reports: string[] = [];
    readText(
      { text: "plain", fontSize: -1, color: "red", fontFamily: "Bad Name", align: 3 },
      (p) => reports.push(p),
    );
    expect(reports.sort()).toEqual(["align", "color", "fontFamily", "fontSize", "text"]);
  });
});

describe("commands", () => {
  it("inserts a text box as one undo step, its size from the zoom", () => {
    const { must, undo, doc, services } = setup();
    services.state.camera = { space: null, cx: 0, cy: 0, zoom: 2 };
    const id = must<ElementId>(TEXT_COMMANDS.insert, { x: 10, y: 20, text: "a\nb" });
    const data = dataMap(doc, id);
    expect(data.get("fontSize")).toBe(fontSizeAt(2));
    expect(fontSizeAt(2)).toBe(12);
    expect((data.get("text") as Y.Text).toString()).toBe("a\nb\n");
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(doc.getMap("elements").get(id)).toBeDefined();
  });

  it("changes the style through the fields' command, and refuses what this version does not write", () => {
    const { must, run, doc } = setup();
    const id = must<ElementId>(TEXT_COMMANDS.insert, { x: 0, y: 0, fontSize: 20 });
    must(TEXT_COMMANDS.setStyle, { ids: [id], key: "color", value: "#FF0000" });
    expect(dataMap(doc, id).get("color")).toBe("#ff0000");
    must(TEXT_COMMANDS.setStyle, { ids: [id], key: "fontFamily", value: "serif" });
    expect(
      run(TEXT_COMMANDS.setStyle, { ids: [id], key: "fontFamily", value: "comic" }).ok,
    ).toBe(false);
    expect(run(TEXT_COMMANDS.setStyle, { ids: [id], key: "fontSize", value: 0 }).ok).toBe(
      false,
    );
    // A change that changes nothing is not offered.
    expect(
      run(TEXT_COMMANDS.setStyle, { ids: [id], key: "fontFamily", value: "serif" }).ok,
    ).toBe(false);
  });

  it("makes the selected text bold and italic while it is edited, each one step", () => {
    const { must, run, services, text, undo } = setup();
    const id = must<ElementId>(TEXT_COMMANDS.insert, {
      x: 0,
      y: 0,
      text: "one two\nthree",
    });
    services.state.text = { id, key: "text", index: 4, length: 7 };
    must(TEXT_COMMANDS.bold);
    expect(text(id).toDelta()).toEqual([
      { insert: "one " },
      { insert: "two", attributes: { bold: true } },
      { insert: "\n" },
      { insert: "thr", attributes: { bold: true } },
      { insert: "ee\n" },
    ]);
    const steps = undo.undoStack.length;
    must(TEXT_COMMANDS.bold);
    expect(text(id).toDelta()).toEqual([{ insert: "one two\nthree\n" }]);
    expect(undo.undoStack.length).toBe(steps + 1);
    // With only a caret, the word it is in.
    services.state.text = { id, key: "text", index: 1, length: 0 };
    must(TEXT_COMMANDS.italic);
    expect(text(id).toDelta()[0]).toEqual({
      insert: "one",
      attributes: { italic: true },
    });
    // Not in or next to a word: nothing to format.
    const spaced = must<ElementId>(TEXT_COMMANDS.insert, { x: 0, y: 0, text: "a   b" });
    services.state.text = { id: spaced, key: "text", index: 2, length: 0 };
    expect(run(TEXT_COMMANDS.bold).ok).toBe(false);
  });

  it("formats whole text boxes that are selected but not edited", () => {
    const { must, text } = setup();
    const a = must<ElementId>(TEXT_COMMANDS.insert, { x: 0, y: 0, text: "a" });
    const b = must<ElementId>(TEXT_COMMANDS.insert, { x: 0, y: 50, text: "b\nc" });
    must(TEXT_COMMANDS.bold, { ids: [a, b] });
    expect(text(b).toDelta()).toEqual([
      { insert: "b", attributes: { bold: true } },
      { insert: "\n" },
      { insert: "c", attributes: { bold: true } },
      { insert: "\n" },
    ]);
    must(TEXT_COMMANDS.numbers, { ids: [a, b] });
    expect(text(b).toDelta()).toEqual([
      { insert: "b", attributes: { bold: true } },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "c", attributes: { bold: true } },
      { insert: "\n", attributes: { list: "ordered" } },
    ]);
    must(TEXT_COMMANDS.numbers, { ids: [a, b] });
    expect(text(a).toDelta()).toEqual([
      { insert: "a", attributes: { bold: true } },
      { insert: "\n" },
    ]);
  });

  it("makes the edited paragraphs a list, and adds the line break a last paragraph lacks", () => {
    const { must, services, doc } = setup();
    const id = must<ElementId>(TEXT_COMMANDS.insert, { x: 0, y: 0, text: "a\nb\nc" });
    const t = dataMap(doc, id).get("text") as Y.Text;
    // Text from elsewhere without a final line break.
    doc.transact(() => t.delete(t.length - 1, 1));
    services.state.text = { id, key: "text", index: 2, length: 3 };
    must(TEXT_COMMANDS.bullets);
    expect(t.toDelta()).toEqual([
      { insert: "a\nb" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "c" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
  });

  it("finds the paragraphs a selection touches and the word at a caret", () => {
    const text = "ab\ncd\nef";
    expect(paragraphsIn(text, 4, 0).map((p) => p.start)).toEqual([3]);
    expect(paragraphsIn(text, 2, 2).map((p) => p.start)).toEqual([3]);
    expect(paragraphsIn(text, 1, 5).map((p) => p.start)).toEqual([0, 3]);
    expect(wordAt("one two", 5)).toEqual({ index: 4, length: 3 });
    expect(wordAt("one  two", 4)).toBeNull();
  });
});

describe("the tool", () => {
  it("makes a text box where it is clicked and starts editing it", () => {
    const { host, env } = setup();
    const tool = host.tools("quick").find((t) => t.id === "galatsa.text/text")!;
    const edited: string[] = [];
    let done = false;
    const handler = tool.definition.start({
      environment: env,
      run: (command, args) => host.commands.execute(command, env(), args),
      isEnabled: () => true,
      extensions: host,
      gesture: () => {
        throw new Error("no gesture");
      },
      scale: () => 1,
      requestOverlay: () => {},
      editText: (id) => edited.push(id),
      setCursor: () => {},
      done: () => {
        done = true;
      },
    });
    handler.pointerDown!({
      screen: { x: 0, y: 0 },
      world: { x: 50, y: 60 },
      pointerType: "mouse",
      button: 0,
      pressure: 0.5,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false, mod: false },
    });
    expect(edited).toHaveLength(1);
    expect(done).toBe(true);
  });
});
