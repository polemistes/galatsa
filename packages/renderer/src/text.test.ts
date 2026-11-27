// SPDX-License-Identifier: GPL-3.0-or-later

// Simple text: line breaks independent of zoom, bars for tiny text, glyphs at
// their size on screen, and few distinct fonts while the camera zooms (the slow
// drawing path in WebKitGTK).

import type { ElementId } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, RecordingContext, record, testHost, TEXT } from "./test-support.ts";
import {
  DEFAULT_FAMILIES,
  estimateMeasurer,
  FONT_STEPS,
  ladderSize,
  LayoutCache,
  layoutText,
} from "./text.ts";

const STYLE = { fontFamily: "sans", fontSize: 10, color: "#000", align: "left" } as const;

describe("layout", () => {
  it("breaks lines at spaces and long words between characters", () => {
    // The estimate: 5.5 units per character at size 10.
    const layout = layoutText(
      estimateMeasurer,
      DEFAULT_FAMILIES,
      "aaa bbb ccccccccccccc d",
      STYLE,
      40,
    );
    expect(layout.lines.map((l) => l.text)).toEqual([
      "aaa bbb",
      "ccccccc",
      "cccccc",
      "d",
    ]);
    expect(layout.height).toBeCloseTo(4 * 12, 9);
  });

  it("keeps paragraphs and aligns lines", () => {
    const layout = layoutText(
      estimateMeasurer,
      DEFAULT_FAMILIES,
      { $y: "text", delta: [{ insert: "ab\ncd" }] },
      { ...STYLE, align: "right" },
      100,
    );
    expect(layout.lines.map((l) => [l.text, l.x])).toEqual([
      ["ab", 100 - 11],
      ["cd", 100 - 11],
    ]);
  });
});

describe("ladder", () => {
  it("rounds to a few sizes per octave", () => {
    const sizes = new Set<number>();
    for (let px = 4; px <= 64; px *= 1.01) sizes.add(ladderSize(px));
    // 4 to 64 is four octaves.
    expect(sizes.size).toBeLessThanOrEqual(4 * FONT_STEPS + 1);
    for (const px of [4, 7.3, 12, 100, 333]) {
      const k = px / ladderSize(px);
      expect(k).toBeGreaterThan(2 ** (-0.5 / FONT_STEPS) - 0.01);
      expect(k).toBeLessThan(2 ** (0.5 / FONT_STEPS) + 0.01);
    }
  });
});

describe("drawing text", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const elements = record([
    ["t", box(TEXT, 0, 0, 200, 600, { data: { text: words, size: 10 } })],
  ]);

  function setup() {
    const { host } = testHost();
    const renderer = new CanvasRenderer({ host, measurer: estimateMeasurer });
    const ctx = new RecordingContext();
    renderer.attach(ctx, { width: 400, height: 300, devicePixelRatio: 1 });
    renderer.setScene(sceneFromSnapshot({ elements }));
    return { renderer, ctx };
  }

  it("draws bars below 4 device pixels and glyphs above", () => {
    const { renderer, ctx } = setup();
    renderer.setCamera({ space: null, cx: 100, cy: 100, zoom: 0.3 });
    renderer.render();
    expect(ctx.named("fillText")).toHaveLength(0);
    expect(renderer.stats.textBars).toBe(1);
    ctx.calls = [];
    renderer.setCamera({ space: null, cx: 100, cy: 100, zoom: 0.5 });
    renderer.render();
    expect(ctx.named("fillText").length).toBeGreaterThan(0);
  });

  it("draws only the lines in view, with the glyphs at their size on screen", () => {
    const { renderer, ctx } = setup();
    // Zoom 10: lines of 12 units are 120 pixels; a 300 pixel view shows 3 or 4,
    // and a margin of one font size on each side may add one more each.
    renderer.setCamera({ space: null, cx: 100, cy: 300, zoom: 10 });
    renderer.render();
    const texts = ctx.named("fillText");
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.length).toBeLessThanOrEqual(6);
    // Font size times the matrix scale is the size on screen: 10 units x 10.
    const font = ctx.named("set font").at(-1)!.args[0] as string;
    const fontPx = Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
    const lastText = ctx.calls.lastIndexOf(texts.at(-1)!);
    const t = ctx.calls
      .slice(0, lastText)
      .filter((c) => c.name === "setTransform")
      .at(-1)!.args as number[];
    expect(fontPx * Math.hypot(t[0]!, t[1]!)).toBeCloseTo(100, 9);
  });

  it("keeps the line breaks when the zoom changes", () => {
    const { renderer, ctx } = setup();
    const linesAt = (zoom: number): string[] => {
      ctx.calls = [];
      renderer.setCamera({ space: null, cx: 100, cy: 30, zoom });
      renderer.render();
      return ctx.named("fillText").map((c) => c.args[0] as string);
    };
    const near = linesAt(4);
    const nearer = linesAt(4.37);
    expect(nearer.slice(0, 2)).toEqual(near.slice(0, 2));
  });

  it("gives the canvas only a few font strings during a long zoom", () => {
    const { renderer, ctx } = setup();
    for (let i = 0; i < 300; i++) {
      renderer.setCamera({ space: null, cx: 100, cy: 30, zoom: 0.5 * 1.01 ** i });
      renderer.render();
    }
    const fonts = new Set(ctx.named("set font").map((c) => c.args[0]));
    // 0.5 to 10 is a bit over four octaves.
    expect(fonts.size).toBeLessThanOrEqual(5 * FONT_STEPS);
    // The font is assigned only when it changes, not once per line.
    expect(ctx.named("set font").length).toBeLessThan(ctx.named("fillText").length / 4);
  });
});

describe("the layout cache", () => {
  it("does not lay out every text again on every frame when there are many", () => {
    let measured = 0;
    const { host } = testHost();
    const list: Array<[ElementId, ReturnType<typeof box>]> = [];
    for (let i = 0; i < 4100; i++)
      list.push([
        `t${i}`,
        box(TEXT, (i % 64) * 12, Math.floor(i / 64) * 12, 10, 10, {
          data: { text: `w${i}`, size: 5 },
        }),
      ]);
    const renderer = new CanvasRenderer({
      host,
      measurer: { width: (_f, t) => (measured++, t.length * 55) },
    });
    renderer.attach(new RecordingContext(), {
      width: 800,
      height: 600,
      devicePixelRatio: 1,
    });
    renderer.setScene(sceneFromSnapshot({ elements: record(list) }));
    renderer.setCamera({ space: null, cx: 384, cy: 384, zoom: 0.7 });
    renderer.render();
    expect(measured).toBeGreaterThan(4000);
    const first = measured;
    renderer.render();
    expect(measured - first).toBe(0);
  });

  it("drops the layouts used longest ago when full", () => {
    const cache = new LayoutCache(8);
    let made = 0;
    const get = (text: string) =>
      cache.get(text, STYLE, 100, () => {
        made++;
        return layoutText(estimateMeasurer, DEFAULT_FAMILIES, text, STYLE, 100);
      });
    for (let i = 0; i < 8; i++) get(`t${i}`);
    get("t0"); // used again, so it stays
    get("new");
    expect(cache.size).toBeLessThanOrEqual(8);
    made = 0;
    get("t0");
    get("t7");
    expect(made).toBe(0);
    get("t1");
    expect(made).toBe(1);
  });
});
