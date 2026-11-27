// SPDX-License-Identifier: GPL-3.0-or-later

// Free roaming: the presenter moves the camera away from the route. Panning
// and zooming are changes on screen (a nudge), so they can be laid over a
// camera that is still coming to rest after a transition was broken off; and
// a camera at rest is anchored in the innermost frame around its centre, so
// the whole zoom range is there inside every frame (docs/adr/0001, section
// 7.3; the editor anchors the same way, docs/adr/0009).

import {
  clampZoom,
  FRAME_TYPE,
  MAX_ZOOM,
  maxPreciseZoom,
  MIN_ZOOM,
  type CameraView,
  type ElementId,
  type Point,
  type Resolver,
} from "@galatsa/core";

/**
 * A change of the picture on screen: scaled by `k` about the centre of the
 * screen, then moved by (tx, ty) CSS pixels.
 */
export interface Nudge {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

export const NO_NUDGE: Nudge = { k: 1, tx: 0, ty: 0 };

/** The view that shows what `view` shows, nudged. */
export function nudgeView(view: CameraView, n: Nudge): CameraView {
  if (n === NO_NUDGE) return view;
  const zoom = view.zoom * n.k;
  return {
    space: view.space,
    cx: view.cx - n.tx / zoom,
    cy: view.cy - n.ty / zoom,
    zoom,
  };
}

/** The nudge, then the picture moved by (dx, dy) pixels. */
export function panNudge(n: Nudge, dx: number, dy: number): Nudge {
  return { k: n.k, tx: n.tx + dx, ty: n.ty + dy };
}

/**
 * The nudge, then the picture scaled by `factor` about the point (ax, ay),
 * in pixels from the centre of the screen; that point stays where it is.
 */
export function zoomNudge(n: Nudge, ax: number, ay: number, factor: number): Nudge {
  return {
    k: n.k * factor,
    tx: n.tx * factor + (1 - factor) * ax,
    ty: n.ty * factor + (1 - factor) * ay,
  };
}

/** `factor` cut down so that a zoom of `zoom` stays within the zoom range. */
export function limitFactor(zoom: number, factor: number): number {
  if (!(factor > 0) || !Number.isFinite(factor) || !(zoom > 0)) return 1;
  return Math.min(Math.max(zoom * factor, MIN_ZOOM), MAX_ZOOM) / zoom;
}

function inside(x: number, y: number, size: { readonly w: number; readonly h: number }) {
  return x >= 0 && y >= 0 && x <= size.w && y <= size.h;
}

/**
 * Anchors views in the innermost shown frame around their centre. Keeps the
 * child containers of each container, so a camera move does not read every
 * element of a large canvas; `invalidate` drops them when the document changes.
 */
export class Anchor {
  readonly #r: Resolver;
  readonly #containers = new Map<ElementId | null, readonly ElementId[]>();

  constructor(resolver: Resolver) {
    this.#r = resolver;
  }

  invalidate(): void {
    this.#containers.clear();
  }

  offset(from: ElementId | null, to: ElementId | null): Point {
    return this.#r.offset(from, to);
  }

  #frameSize(id: ElementId): { readonly w: number; readonly h: number } | null {
    const element = this.#r.get(id);
    if (element?.type !== FRAME_TYPE || !element.size || this.#r.isGone(id)) return null;
    return element.size;
  }

  #childContainers(parent: ElementId | null): readonly ElementId[] {
    let list = this.#containers.get(parent);
    if (list === undefined) {
      list = this.#r.children(parent).filter((id) => this.#r.isContainer(id));
      this.#containers.set(parent, list);
    }
    return list;
  }

  /** The topmost shown frame inside `container` that holds the point, through groups and gone containers. */
  #frameAt(
    container: ElementId | null,
    px: number,
    py: number,
    depth: number,
  ): { id: ElementId; x: number; y: number } | null {
    if (depth > 64) return null;
    const list = this.#childContainers(container);
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i]!;
      const local = this.#r.localPosition(id);
      const x = px - local.x;
      const y = py - local.y;
      const size = this.#frameSize(id);
      if (size !== null) {
        if (inside(x, y, size)) return { id, x, y };
      } else {
        const found = this.#frameAt(id, x, y, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }

  /** The innermost shown frame around the point (x, y) of `space`; null for the root. */
  #frameAround(space: ElementId | null, x: number, y: number): ElementId | null {
    const r = this.#r;
    let at = space !== null && r.get(space) !== undefined ? space : null;
    // Up, to the nearest frame that holds the point.
    for (let guard = 0; at !== null && guard < 4096; guard++) {
      const size = this.#frameSize(at);
      if (size !== null && inside(x, y, size)) break;
      const local = r.localPosition(at);
      x += local.x;
      y += local.y;
      at = r.parentOf(at);
    }
    // Down, as far as a frame holds it.
    for (let guard = 0; guard < 4096; guard++) {
      const found = this.#frameAt(at, x, y, 0);
      if (found === null) break;
      at = found.id;
      x = found.x;
      y = found.y;
    }
    return at;
  }

  /**
   * The view anchored: in the innermost frame around its centre when the
   * precision budget holds there, otherwise where it was if the budget holds
   * there. The centre is carried over with the offset between the two spaces,
   * through their lowest common ancestor. The zoom is not clamped.
   */
  anchor(view: CameraView): CameraView {
    const target = this.#frameAround(view.space, view.cx, view.cy);
    if (target === view.space) return view;
    const known = view.space === null || this.#r.get(view.space) !== undefined;
    const o = this.#r.offset(known ? view.space : null, target);
    const moved = {
      space: target,
      cx: view.cx + o.x,
      cy: view.cy + o.y,
      zoom: view.zoom,
    };
    if (!known || view.zoom <= maxPreciseZoom(moved.cx, moved.cy)) return moved;
    return view.zoom <= maxPreciseZoom(view.cx, view.cy) ? view : moved;
  }

  /** The view anchored, with its zoom within the range and the precision budget there. */
  place(view: CameraView): CameraView {
    const placed = this.anchor(view);
    const zoom = clampZoom(placed.zoom, placed.cx, placed.cy);
    return zoom === placed.zoom ? placed : { ...placed, zoom };
  }

  /**
   * A view at rest zoomed by `factor` about the point (ax, ay), in pixels
   * from the centre of the screen, which stays where it is. The point is
   * carried into the space the result is anchored in through the old centre,
   * so it stays exact; at a zoom limit the view is returned as it is.
   */
  zoomAbout(view: CameraView, ax: number, ay: number, factor: number): CameraView {
    if (!(factor > 0) || !Number.isFinite(factor)) return view;
    let px = view.cx + ax / view.zoom;
    let py = view.cy + ay / view.zoom;
    const wanted = Math.min(Math.max(view.zoom * factor, MIN_ZOOM), MAX_ZOOM);
    let space = view.space;
    const placed = this.anchor({
      space,
      cx: px - ax / wanted,
      cy: py - ay / wanted,
      zoom: wanted,
    });
    if (placed.space !== space) {
      const o = this.#r.offset(space, placed.space);
      px = view.cx + o.x + ax / view.zoom;
      py = view.cy + o.y + ay / view.zoom;
      space = placed.space;
    }
    const zoom = clampZoom(wanted, placed.cx, placed.cy);
    if (zoom === view.zoom && space === view.space) return view;
    return { space, cx: px - ax / zoom, cy: py - ay / zoom, zoom };
  }
}
