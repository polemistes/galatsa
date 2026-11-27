// SPDX-License-Identifier: GPL-3.0-or-later

// Extensions' overlays (docs/adr/0013): drawn in root space in every frame,
// left out while not visible or not offered in the mode, drawn again when the
// document changes, when a panel opens and when the overlay asks.

import { EXTENSION_API_VERSION } from "@galatsa/extension-api";
import {
  defineEditExtension,
  defineViewExtension,
  type CommandContext,
  type DrawContext,
} from "@galatsa/extension-api/editing";
import { addStop } from "@galatsa/core/ydoc";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "./editor.ts";
import { loadExtensions } from "./extensions.ts";
import { testEditor, testI18n } from "./test-support.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function setup() {
  const drawn: Array<{ scale: number; point: { x: number; y: number } }> = [];
  let shown = true;
  let fail = false;
  const view = defineViewExtension({
    id: "lines",
    version: "1.0.0",
    api: EXTENSION_API_VERSION,
  });
  const extension = defineEditExtension({
    view,
    contributes: {
      overlays: [
        {
          name: "advanced-only",
          draw: () => {
            throw new Error("not drawn in quick mode");
          },
        },
        {
          name: "line",
          quick: true,
          visible: (ctx: CommandContext) => shown && !ctx.services.panels.isOpen("x/y"),
          draw(ctx: DrawContext) {
            if (fail) throw new Error("broken overlay");
            const path = ctx.createPath();
            path.moveTo(100, 100);
            path.lineTo(200, 100);
            ctx.stroke(path, { color: "#000", width: 1 / ctx.scale });
            drawn.push({ scale: ctx.scale, point: { x: 100, y: 100 } });
          },
        },
      ],
    },
  });
  const i18n = testI18n();
  const loaded = loadExtensions(i18n, [extension]);
  expect(loaded.problems).toEqual([]);
  const { editor, frames } = testEditor({ host: loaded.host, i18n, mode: "quick" });
  editors.push(editor);
  const flush = (): void => {
    for (const frame of frames.splice(0)) frame();
  };
  flush();
  return {
    editor,
    frames,
    drawn,
    flush,
    show: (value: boolean) => (shown = value),
    breakIt: () => (fail = true),
  };
}

describe("extension overlays", () => {
  it("draws visible overlays of the mode in root space, through the camera", () => {
    const t = setup();
    expect(t.drawn.length).toBeGreaterThan(0);
    t.drawn.length = 0;
    t.editor.services.camera.set({ space: null, cx: 500, cy: 400, zoom: 4 });
    t.flush();
    // Device pixels per root unit: zoom 4 at a device pixel ratio of 1.
    expect(t.drawn.at(-1)!.scale).toBe(4);
    t.drawn.length = 0;
    t.show(false);
    t.editor.services.overlays.invalidate();
    t.flush();
    expect(t.drawn).toEqual([]);
  });

  it("draws again when the document changes, when a panel opens and when asked", () => {
    const t = setup();
    expect(t.frames).toEqual([]);
    addStop(t.editor.doc, {
      view: { kind: "rect", space: null, x: 0, y: 0, w: 1, h: 1 },
    });
    expect(t.frames.length).toBe(1);
    t.flush();
    t.drawn.length = 0;
    t.editor.services.panels.open("x/y");
    expect(t.frames.length).toBe(1);
    t.flush();
    expect(t.drawn).toEqual([]);
    t.editor.services.panels.close("x/y");
    t.flush();
    expect(t.drawn.length).toBe(1);
    t.editor.services.overlays.invalidate();
    expect(t.frames.length).toBe(1);
  });

  it("goes on drawing the frame when an overlay throws", () => {
    const t = setup();
    t.breakIt();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (error: unknown) => errors.push(error);
    try {
      t.editor.services.overlays.invalidate();
      expect(() => t.flush()).not.toThrow();
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
  });
});
