// SPDX-License-Identifier: GPL-3.0-or-later

// Where the camera is anchored (docs/adr/0001, section 7.3; docs/adr/0010).
//
// The camera's centre is kept in the local space of the innermost frame that
// contains it, so its numbers stay small however far the frame is from the
// root, and the full zoom range is there inside every frame. When the centre
// leaves a frame for a space where its numbers would be too large for the
// zoom (the precision budget), the camera stays anchored where it was: the
// anchor need not contain the centre, it only has to keep the numbers small.
//
// The camera stays where it is on screen when the frame it is anchored in (or
// a container above it) moves: by a drag's preview, an edit, an undo, or
// someone else's change. The anchor's chain of local positions is remembered,
// and the camera is shifted by how far the chain moved, computed level by
// level from local positions so it stays exact.

import {
  FRAME_TYPE,
  maxPreciseZoom,
  type CameraView,
  type ElementId,
  type LiveResolver,
  type Point,
} from "@galatsa/core";
import type { EditorScene } from "./scene-source.ts";

/** What anchoring reads of the scene: the live resolver with the gesture's preview. */
export interface AnchorSource {
  /** Whether the document has a record for this id. */
  known(id: ElementId): boolean;
  isGone(id: ElementId): boolean;
  isContainer(id: ElementId | null): boolean;
  /** The size of a frame that is shown, or null if `id` is not one. */
  frameSize(id: ElementId): { readonly w: number; readonly h: number } | null;
  parentOf(id: ElementId): ElementId | null;
  children(parent: ElementId | null): readonly ElementId[];
  localPosition(id: ElementId): Point;
  offset(from: ElementId | null, to: ElementId | null): Point;
}

/** An anchor source over the editor's scene (the live resolver and the preview). */
export function sceneAnchorSource(live: LiveResolver, scene: EditorScene): AnchorSource {
  return {
    known: (id) => live.get(id) !== undefined,
    isGone: (id) => live.isGone(id),
    isContainer: (id) => live.isContainer(id),
    frameSize(id) {
      const element = live.get(id);
      if (element?.type !== FRAME_TYPE || live.isGone(id)) return null;
      const size = element.size ?? { w: 0, h: 0 };
      const preview = scene.preview.get(id);
      return { w: preview?.w ?? size.w, h: preview?.h ?? size.h };
    },
    parentOf: (id) => live.parentOf(id),
    children: (parent) => live.children(parent),
    localPosition: (id) => scene.localPosition(id),
    offset: (from, to) => scene.offset(from, to),
  };
}

function inside(p: Point, size: { readonly w: number; readonly h: number }): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h;
}

/**
 * Finds anchors. Keeps, per container, the list of its child containers, so a
 * camera move does not read every element of a large canvas; `invalidate`
 * drops the list when the document changes.
 */
export class Anchoring {
  readonly #src: AnchorSource;
  readonly #containers = new Map<ElementId | null, readonly ElementId[]>();

  constructor(src: AnchorSource) {
    this.#src = src;
  }

  /** The document changed: child containers may have changed. */
  invalidate(): void {
    this.#containers.clear();
  }

  #childContainers(parent: ElementId | null): readonly ElementId[] {
    let list = this.#containers.get(parent);
    if (list === undefined) {
      list = this.#src.children(parent).filter((id) => this.#src.isContainer(id));
      this.#containers.set(parent, list);
    }
    return list;
  }

  /**
   * The innermost shown frame that contains the point `p` of space `space`, or
   * null (the root). Only decides where to anchor: the point is carried
   * between spaces approximately, and the caller converts the camera through
   * the offset between the two spaces, which is exact.
   */
  frameAround(space: ElementId | null, p: Point): ElementId | null {
    const src = this.#src;
    let at = space !== null && src.known(space) ? space : null;
    let x = p.x;
    let y = p.y;
    // Up, to the nearest frame that contains the point.
    while (at !== null) {
      const size = src.frameSize(at);
      if (size !== null && inside({ x, y }, size)) break;
      const local = src.localPosition(at);
      x += local.x;
      y += local.y;
      at = src.parentOf(at);
    }
    // Down, into the topmost frame that contains it, through groups and gone
    // containers, as often as one is found.
    const search = (
      container: ElementId | null,
      px: number,
      py: number,
    ): { id: ElementId; x: number; y: number } | null => {
      const list = this.#childContainers(container);
      for (let i = list.length - 1; i >= 0; i--) {
        const id = list[i]!;
        const local = src.localPosition(id);
        const qx = px - local.x;
        const qy = py - local.y;
        const size = src.frameSize(id);
        if (size !== null) {
          if (inside({ x: qx, y: qy }, size)) return { id, x: qx, y: qy };
        } else {
          const found = search(id, qx, qy);
          if (found !== null) return found;
        }
      }
      return null;
    };
    for (;;) {
      const found = search(at, x, y);
      if (found === null) return at;
      at = found.id;
      x = found.x;
      y = found.y;
    }
  }

  /**
   * The view anchored: in the innermost frame around its centre when the
   * precision budget holds there, otherwise where it was if the budget holds
   * there. The zoom is not clamped here.
   */
  anchor(view: CameraView): CameraView {
    const src = this.#src;
    const target = this.frameAround(view.space, { x: view.cx, y: view.cy });
    if (target === view.space) return view;
    // A gone frame still has its place in the document, so the centre can be
    // carried out of it; an id the document does not know is read as the root
    // (the camera control carries the camera out of a purged anchor first).
    const known = view.space === null || src.known(view.space);
    const o = src.offset(known ? view.space : null, target);
    const moved: CameraView = {
      space: target,
      cx: view.cx + o.x,
      cy: view.cy + o.y,
      zoom: view.zoom,
    };
    // A deleted frame still keeps the numbers small: the camera stays in it
    // while the budget would break elsewhere (so undoing the delete finds the
    // view as it was).
    if (!known) return moved;
    if (view.zoom <= maxPreciseZoom(moved.cx, moved.cy)) return moved;
    if (view.zoom <= maxPreciseZoom(view.cx, view.cy)) return view;
    return moved;
  }
}

/** The anchor and its containers up to the root, with their local positions. */
export interface Pin {
  readonly space: ElementId;
  readonly chain: readonly {
    readonly id: ElementId;
    readonly x: number;
    readonly y: number;
  }[];
}

/** Remembers where the anchor is now; null for the root. */
export function pin(src: AnchorSource, space: ElementId | null): Pin | null {
  if (space === null || !src.known(space)) return null;
  const chain: { id: ElementId; x: number; y: number }[] = [];
  const seen = new Set<ElementId>();
  for (let at: ElementId | null = space; at !== null; at = src.parentOf(at)) {
    if (seen.has(at)) break;
    seen.add(at);
    const local = src.localPosition(at);
    chain.push({ id: at, x: local.x, y: local.y });
  }
  return { space, chain };
}

/**
 * The camera after the document changed under its pinned anchor: in the same
 * view of the canvas, in the anchor's space (or, if the anchor left the
 * document, in the nearest container of its old chain that is still there).
 *
 * Never through root coordinates. The containers of the old chain that are
 * still above the anchor, in the same order, split both chains into
 * segments; for each segment the offset across it now (`offset`, through the
 * lowest common ancestor) is compared with the sum of the old local positions
 * across it. Each difference is a small number computed from two nearly
 * equal ones, so it is exact; it is how far the anchor moved relative to the
 * top of the segment. Grouping, ungrouping or moving the anchor into another
 * container keeps its place on the canvas, so the differences are zero (up to
 * the rounding of the operation itself) and the view stays.
 */
export function follow(src: AnchorSource, pinned: Pin, view: CameraView): CameraView {
  const old = pinned.chain;
  // The anchor, or the nearest container of its old chain still in the document.
  let k = 0;
  while (k < old.length && !src.known(old[k]!.id)) k++;
  let cx = view.cx;
  let cy = view.cy;
  for (let m = 0; m < k; m++) {
    cx += old[m]!.x;
    cy += old[m]!.y;
  }
  const space = k < old.length ? old[k]!.id : null;
  if (space === null) return { space, cx, cy, zoom: view.zoom };
  // Its chain now, and the old chain's containers that are still in it.
  const now: (ElementId | null)[] = [];
  const seen = new Set<ElementId>();
  for (let at: ElementId | null = space; at !== null; at = src.parentOf(at)) {
    if (seen.has(at)) break;
    seen.add(at);
    now.push(at);
  }
  now.push(null);
  const kept: { old: number; id: ElementId | null }[] = [{ old: k, id: space }];
  let last = 0;
  for (let i = k + 1; i < old.length; i++) {
    const at = now.indexOf(old[i]!.id);
    if (at > last) {
      kept.push({ old: i, id: old[i]!.id });
      last = at;
    }
  }
  kept.push({ old: old.length, id: null });
  let sx = 0;
  let sy = 0;
  for (let j = 0; j + 1 < kept.length; j++) {
    const from = kept[j]!;
    const to = kept[j + 1]!;
    let ox = 0;
    let oy = 0;
    for (let m = from.old; m < to.old; m++) {
      ox += old[m]!.x;
      oy += old[m]!.y;
    }
    const o = src.offset(from.id, to.id);
    sx += o.x - ox;
    sy += o.y - oy;
  }
  if (sx === 0 && sy === 0 && k === 0) return view;
  return { space, cx: cx - sx, cy: cy - sy, zoom: view.zoom };
}
