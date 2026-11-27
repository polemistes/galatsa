// SPDX-License-Identifier: GPL-3.0-or-later

// Editor services for tests, over a real document. Part of the entry
// "@galatsa/extension-api/testing"; not part of the program.

import { Resolver, type CameraView, type ElementId, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import type * as Y from "yjs";
import type { Mode } from "./ids.ts";
import type { EditorServices, PreviewChanges, TextEditingState } from "./services.ts";

/** Editor services for tests, with their state open for inspection. */
export interface TestServices extends EditorServices {
  readonly state: {
    selection: readonly ElementId[];
    mode: Mode;
    camera: CameraView;
    viewport: Rect;
    openPanels: Set<string>;
    text: TextEditingState | null;
    preview: PreviewChanges | null;
    /** How many times a preview was shown. */
    previews: number;
    /** How many times overlays asked to be drawn again. */
    overlayRequests: number;
    /** Messages shown to the user, oldest first. */
    notices: { message: string; values?: unknown }[];
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Editor services for tests. Scene queries are answered from the document by
 * resolution, with bounding boxes (no type-specific hit testing); the
 * selectable elements are the visible top-level ones, as in an editor that has
 * not entered a container.
 */
export function createTestServices(
  doc: Y.Doc,
  initial: { readonly mode?: Mode; readonly viewport?: Rect } = {},
): TestServices {
  const state: TestServices["state"] = {
    selection: [],
    mode: initial.mode ?? "advanced",
    camera: { space: null, cx: 500, cy: 400, zoom: 1 },
    viewport: initial.viewport ?? { x: 0, y: 0, w: 1000, h: 800 },
    openPanels: new Set(),
    text: null,
    preview: null,
    previews: 0,
    overlayRequests: 0,
    notices: [],
  };
  const resolver = (): Resolver => new Resolver(yLookup(doc));
  const selectable = (r: Resolver): ElementId[] =>
    r.drawOrder().filter((id) => !r.isGone(id) && r.parentOf(id) === null);
  return {
    state,
    selection: {
      get: () => state.selection,
      set: (ids) => {
        state.selection = [...ids];
      },
    },
    camera: {
      get: () => state.camera,
      viewport: () => state.viewport,
      set: (view) => {
        state.camera = view;
      },
      fit: (rect) => {
        state.viewport = rect;
      },
    },
    mode: {
      get: () => state.mode,
      set: (mode) => {
        state.mode = mode;
      },
    },
    panels: {
      isOpen: (id) => state.openPanels.has(id),
      open: (id) => {
        state.openPanels.add(id);
      },
      close: (id) => {
        state.openPanels.delete(id);
      },
    },
    scene: {
      elementAt(point, tolerance) {
        const r = resolver();
        const probe = {
          x: point.x - tolerance,
          y: point.y - tolerance,
          w: 2 * tolerance,
          h: 2 * tolerance,
        };
        const hits = selectable(r).filter((id) => {
          const b = r.bounds(id);
          return b !== null && intersects(b, probe);
        });
        return hits[hits.length - 1] ?? null;
      },
      elementsIn(rect, how) {
        const r = resolver();
        return selectable(r).filter((id) => {
          const b = r.bounds(id);
          return (
            b !== null && (how === "inside" ? contains(rect, b) : intersects(rect, b))
          );
        });
      },
      bounds: (id) => resolver().bounds(id),
      offset: (from, to) => resolver().offset(from, to),
      placement(id) {
        const r = resolver();
        const e = r.get(id);
        if (!e || r.isGone(id)) return null;
        const local = r.localPosition(id);
        const world = r.worldOrigin(id);
        return {
          parent: r.parentOf(id),
          x: local.x,
          y: local.y,
          worldX: world.x,
          worldY: world.y,
          w: e.size?.w ?? 0,
          h: e.size?.h ?? 0,
          rot: e.rot ?? 0,
        };
      },
      visible() {
        const r = resolver();
        return r.drawOrder().filter((id) => {
          const b = r.bounds(id);
          return !r.isGone(id) && b !== null && intersects(b, state.viewport);
        });
      },
    },
    text: {
      current: () => state.text,
      select: (index, length) => {
        if (state.text) state.text = { ...state.text, index, length };
      },
    },
    preview: {
      show: (changes) => {
        state.preview = changes;
        state.previews += 1;
      },
      clear: () => {
        state.preview = null;
      },
    },
    overlays: {
      invalidate: () => {
        state.overlayRequests += 1;
      },
    },
    notices: {
      show: (message, values) => {
        state.notices.push(values === undefined ? { message } : { message, values });
      },
    },
  };
}
