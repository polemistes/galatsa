// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for the editor's own tests: an editor over a new document with the
// examples loaded, drawing into a context that draws nothing, and input
// helpers. Not part of the program (nothing in index.ts exports it).

import { initDocument } from "@galatsa/core/ydoc";
import { exampleExtensions } from "@galatsa/extension-examples";
import { createI18n, memoryLocaleStorage, type I18n } from "@galatsa/i18n";
import type { Canvas2D } from "@galatsa/renderer";
import * as Y from "yjs";
import { Editor, type EditorOptions, type PointerInput } from "./editor.ts";
import { loadExtensions } from "./extensions.ts";
import type { KeyInput } from "./keymap.ts";

/** A 2D context that accepts every call and draws nothing. */
export function nullContext(): Canvas2D {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Canvas2D;
}

export function testI18n(): I18n {
  return createI18n({ locale: "en", dev: false, storage: memoryLocaleStorage() });
}

export const VIEW = { width: 1000, height: 800, devicePixelRatio: 1 };

/** An editor over a new document, 1000 x 800, where a screen pixel is a world unit at (x, y). */
export function testEditor(options: Partial<EditorOptions> = {}): {
  editor: Editor;
  frames: Array<() => void>;
} {
  const i18n = options.i18n ?? testI18n();
  const doc = options.doc ?? new Y.Doc();
  if (!options.doc) initDocument(doc);
  const loaded = loadExtensions(i18n, exampleExtensions);
  if (loaded.problems.length > 0)
    throw new Error(loaded.problems.map((p) => p.detail).join("; "));
  const frames: Array<() => void> = [];
  const editor = new Editor({
    doc,
    host: loaded.host,
    i18n,
    platform: { mac: false },
    schedule: (frame) => {
      frames.push(frame);
      return () => {};
    },
    defaultTool: "examples.select/select",
    ...options,
  });
  editor.attach(nullContext(), VIEW);
  editor.services.camera.set({ space: null, cx: 500, cy: 400, zoom: 1 });
  return { editor, frames };
}

export function pointer(
  x: number,
  y: number,
  extra: Partial<PointerInput> = {},
): PointerInput {
  return {
    x,
    y,
    pointerType: "mouse",
    button: 0,
    pressure: 0.5,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...extra,
  };
}

/** A drag from one screen point to another, in a few moves. */
export function drag(
  editor: Editor,
  from: { x: number; y: number },
  to: { x: number; y: number },
  extra: Partial<PointerInput> = {},
): void {
  editor.pointerDown(pointer(from.x, from.y, extra));
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    editor.pointerMove(
      pointer(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, extra),
    );
  }
  editor.pointerUp(pointer(to.x, to.y, extra));
}

export function key(k: string, extra: Partial<KeyInput> = {}): KeyInput {
  const code =
    extra.code ??
    (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k === "Escape" ? "Escape" : "");
  return {
    key: k,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    altGraph: false,
    ...extra,
  };
}
