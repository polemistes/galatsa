// SPDX-License-Identifier: GPL-3.0-or-later

// Rich text as the renderer reads it, the simple layout of styled runs and
// lists, the edits of the editing element (diff and moving one past another),
// and drawing a fragment as wide as the layout says.

import type { TextRun } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { CanvasState } from "./canvas.ts";
import { CanvasDrawContext } from "./draw-context.ts";
import { parseRichText } from "./rich-text.ts";
import { RecordingContext } from "./test-support.ts";
import { DEFAULT_FAMILIES, estimateMeasurer, LayoutCache, layoutText } from "./text.ts";
import { diffText, transformEdit } from "./text-edit.ts";

const STYLE = { fontFamily: "sans", fontSize: 10, color: "#000", align: "left" } as const;

describe("rich text", () => {
  it("splits paragraphs at line breaks; a final one ends the last paragraph", () => {
    const shape = (delta: TextRun[]) =>
      parseRichText({ $y: "text", delta }).paragraphs.map((p) => [
        p.runs.map((r) => r.text).join(""),
        p.start,
        p.length,
        p.terminated,
      ]);
    expect(shape([])).toEqual([["", 0, 0, false]]);
    expect(shape([{ insert: "ab" }])).toEqual([["ab", 0, 2, false]]);
    expect(shape([{ insert: "ab\n" }])).toEqual([["ab", 0, 2, true]]);
    expect(shape([{ insert: "ab\n\n" }])).toEqual([
      ["ab", 0, 2, true],
      ["", 3, 0, true],
    ]);
    expect(shape([{ insert: "a\nb" }])).toEqual([
      ["a", 0, 1, true],
      ["b", 2, 1, false],
    ]);
  });

  it("reads runs, lists and their markers", () => {
    const rich = parseRichText({
      $y: "text",
      delta: [
        { insert: "a", attributes: { bold: true } },
        { insert: "b", attributes: { bold: true, italic: true, color: "#f00" } },
        { insert: "\n", attributes: { list: "ordered" } },
        { insert: "c" },
        { insert: "\n", attributes: { list: "ordered" } },
        { insert: "d" },
        { insert: "\n", attributes: { list: "bullet" } },
        { insert: "e\n" },
        { insert: "f" },
        { insert: "\n", attributes: { list: "ordered" } },
      ],
    });
    expect(rich.paragraphs[0]!.runs).toEqual([
      { text: "a", bold: true, italic: false, color: null },
      { text: "b", bold: true, italic: true, color: "#f00" },
    ]);
    expect(rich.paragraphs.map((p) => p.marker)).toEqual(["1.", "2.", "•", null, "1."]);
  });
});

describe("simple layout", () => {
  it("keeps runs as fragments with their fonts, and indents list items", () => {
    const layout = layoutText(
      estimateMeasurer,
      DEFAULT_FAMILIES,
      {
        $y: "text",
        delta: [
          { insert: "ab", attributes: { bold: true } },
          { insert: "cd" },
          { insert: "\n", attributes: { list: "bullet" } },
        ],
      },
      STYLE,
      200,
    );
    expect(layout.lines).toHaveLength(1);
    const line = layout.lines[0]!;
    expect(line.fragments.map((f) => [f.text, f.prefix])).toEqual([
      ["ab", "700 "],
      ["cd", "400 "],
    ]);
    expect(line.fragments[0]!.x).toBeCloseTo(15, 9);
    expect(line.marker?.text).toBe("•");
    expect(line.marker!.x + line.marker!.width).toBeCloseTo(15 - 4, 9);
  });
});

describe("edits of the editing element", () => {
  it("finds the one replacement between two texts", () => {
    expect(diffText("abc", "abc")).toBeNull();
    expect(diffText("abc", "aXc")).toEqual({ index: 1, length: 1, text: "X" });
    expect(diffText("abc", "abXYc")).toEqual({ index: 2, length: 0, text: "XY" });
    expect(diffText("aaa", "aa")).toEqual({ index: 2, length: 1, text: "" });
  });

  it("moves a composition past an edit made meanwhile", () => {
    const local = { index: 5, length: 0, text: "ü" };
    expect(transformEdit(local, null)).toEqual(local);
    expect(transformEdit(local, { index: 0, length: 1, text: "XYZ" })).toEqual({
      index: 7,
      length: 0,
      text: "ü",
    });
    expect(transformEdit(local, { index: 8, length: 1, text: "" })).toEqual(local);
    expect(
      transformEdit(
        { index: 2, length: 4, text: "q" },
        { index: 3, length: 1, text: "" },
      ),
    ).toEqual({
      index: 3,
      length: 2,
      text: "q",
    });
  });
});

describe("drawing a fragment", () => {
  it("stretches it to the layout's width when the canvas sets it otherwise", () => {
    const ctx = new RecordingContext() as RecordingContext & {
      measureText(t: string): { width: number };
    };
    // The canvas sets text 2 % narrower than the layout measured it.
    ctx.measureText = (t: string) => ({ width: t.length * 0.98 * 6.4 });
    const state = new CanvasState(ctx);
    const dc = new CanvasDrawContext(
      {
        state,
        view: [0, 0, 1000, 1000],
        images: null,
        imageSize: () => undefined,
        measurer: {
          width: (font, t) => t.length * 0.1 * Number(/(\d+)px/.exec(font)![1]),
        },
        families: DEFAULT_FAMILIES,
        layouts: new LayoutCache(),
        t: (label) => label,
      },
      { fillText: 0, textBars: 0, images: 0, imagesIncomplete: false },
    );
    dc.begin({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 1, "full");
    const style = { ...STYLE, fontSize: 64 };
    dc.drawText(dc.layoutText("abcd", style, 1000), 0, 0);
    const t = ctx.calls.filter((c) => c.name === "setTransform").at(-1)!.args as number[];
    expect(t[0]).toBeCloseTo(1 / 0.98, 6);
    expect(t[3]).toBeCloseTo(1, 9);
    // While the element's text is edited in place, the canvas leaves it out.
    ctx.calls = [];
    dc.begin({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 1, "full", true);
    dc.drawText(dc.layoutText("abcd", style, 1000), 0, 0);
    expect(ctx.calls.filter((c) => c.name === "fillText")).toEqual([]);
  });
});
