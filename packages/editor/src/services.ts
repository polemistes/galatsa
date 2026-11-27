// SPDX-License-Identifier: GPL-3.0-or-later

// The editor services of docs/adr/0005, section 4.8, over the editor's state:
// the selection, the camera, the mode, open panels, questions about the
// canvas as the user sees it, the text being edited, and previews.
//
// Scene questions answer from the document as it is (the live resolver),
// except `elementAt`, which asks the renderer, so that a click hits what each
// element type says is its outline (an ellipse is not hit in its corners), and
// `visible`, which asks the renderer's spatial index. What a click inside a
// group selects is the editor's choice: the outermost group it is in, up to
// the nearest frame. Locked elements are passed over by clicks.

import {
  GROUP_TYPE,
  type CameraView,
  type ElementId,
  type LiveResolver,
  type Point,
  type Rect,
} from "@galatsa/core";
import type { ContributionId, Mode } from "@galatsa/extension-api";
import type {
  EditorServices,
  ElementPlacement,
  PreviewChanges,
} from "@galatsa/extension-api/editing";
import type { CanvasRenderer } from "@galatsa/renderer";
import { fitCamera, visibleWorld, type ScreenSize } from "./camera.ts";
import type { EditorScene } from "./scene-source.ts";

/** What the services need from the editor. */
export interface ServiceHost {
  readonly live: LiveResolver;
  readonly scene: EditorScene;
  readonly renderer: CanvasRenderer;
  screen(): ScreenSize;
  /** Something visible changed: draw again. */
  invalidate(): void;
  /** The editor's state changed (selection, camera, mode, panels): tell listeners. */
  changed(what: StateChange): void;
  /** The camera as it is set: anchored and within the zoom limits (docs/adr/0009). */
  placeCamera(view: CameraView): CameraView;
  /** The preview of a gesture changed (the camera follows its anchor). */
  previewChanged(): void;
  /** A point of root space on screen (exact for the pointer's own position). */
  toScreen(point: Point): Point;
}

export type StateChange = "selection" | "camera" | "mode" | "panels";

/** The services, with the state behind them. */
export interface EditorState {
  selection: readonly ElementId[];
  camera: CameraView;
  mode: Mode;
  readonly openPanels: Set<ContributionId>;
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

/** The element a click on `id` selects: the outermost group it is in, up to the nearest frame. */
export function selectableFor(live: LiveResolver, id: ElementId): ElementId {
  let chosen = id;
  for (let at = live.parentOf(id); at !== null; at = live.parentOf(at)) {
    if (live.get(at)?.type !== GROUP_TYPE || live.isGone(at)) break;
    chosen = at;
  }
  return chosen;
}

/**
 * The elements the user sees at the top level of the canvas, back to front:
 * the root's children that are not gone, and in place of a gone container
 * (a dissolved group) its members.
 */
export function topLevel(live: LiveResolver): ElementId[] {
  const out: ElementId[] = [];
  const collect = (parent: ElementId | null): void => {
    for (const id of live.children(parent)) {
      if (!live.isGone(id)) out.push(id);
      else if (live.isContainer(id)) collect(id);
    }
  };
  collect(null);
  return out;
}

export function createServices(host: ServiceHost, state: EditorState): EditorServices {
  const { live, scene, renderer } = host;
  const offsets = (from: ElementId | null, to: ElementId | null): Point =>
    scene.offset(from, to);
  const setPreview = (changes: PreviewChanges | null): void => {
    const ids = scene.setPreview(changes);
    if (ids.size === 0) return;
    renderer.applyChanges(ids);
    host.previewChanged();
    host.invalidate();
  };
  return {
    selection: {
      get: () => state.selection,
      set(ids) {
        const next = [...new Set(ids)];
        if (
          next.length === state.selection.length &&
          next.every((id, i) => id === state.selection[i])
        )
          return;
        state.selection = next;
        host.changed("selection");
        host.invalidate();
      },
    },
    camera: {
      get: () => state.camera,
      viewport: () => visibleWorld(state.camera, host.screen(), offsets),
      set(view) {
        if (
          !Number.isFinite(view.cx) ||
          !Number.isFinite(view.cy) ||
          !(view.zoom > 0) ||
          !Number.isFinite(view.zoom)
        )
          return;
        state.camera = host.placeCamera({
          space: view.space,
          cx: view.cx,
          cy: view.cy,
          zoom: view.zoom,
        });
        renderer.setCamera(state.camera);
        host.changed("camera");
        host.invalidate();
      },
      fit(rect, space) {
        this.set(fitCamera(rect, space, host.screen(), undefined, state.camera.zoom));
      },
    },
    mode: {
      get: () => state.mode,
      set(mode) {
        if (mode === state.mode) return;
        state.mode = mode;
        host.changed("mode");
      },
    },
    panels: {
      isOpen: (id) => state.openPanels.has(id),
      open(id) {
        if (state.openPanels.has(id)) return;
        state.openPanels.add(id);
        host.changed("panels");
      },
      close(id) {
        if (state.openPanels.delete(id)) host.changed("panels");
      },
    },
    scene: {
      elementAt(point, tolerance) {
        const screen = host.toScreen(point);
        const hit = renderer.hitTest(screen.x, screen.y, {
          tolerance: tolerance * state.camera.zoom,
          accept: (id) => !live.isLocked(id),
        });
        return hit === null ? null : selectableFor(live, hit);
      },
      elementsIn(rect, how) {
        return topLevel(live).filter((id) => {
          const b = live.bounds(id);
          return (
            b !== null && (how === "inside" ? contains(rect, b) : intersects(rect, b))
          );
        });
      },
      bounds: (id) => (live.get(id) === undefined ? null : live.bounds(id)),
      offset: (from, to) => scene.offset(from, to),
      placement(id): ElementPlacement | null {
        const e = live.get(id);
        if (!e || live.isGone(id)) return null;
        const local = live.localPosition(id);
        const world = live.worldOrigin(id);
        return {
          parent: live.parentOf(id),
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
        const size = host.screen();
        return renderer.elementsInRect({ x: 0, y: 0, w: size.width, h: size.height });
      },
    },
    text: {
      // In-place text editing is not built yet (the renderer's beginTextEdit).
      current: () => null,
      select: () => {},
    },
    preview: {
      show: (changes) => setPreview(changes),
      clear: () => setPreview(null),
    },
    overlays: {
      invalidate: () => host.invalidate(),
    },
  };
}
