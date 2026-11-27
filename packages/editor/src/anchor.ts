// SPDX-License-Identifier: GPL-3.0-or-later

// Where the camera is anchored (docs/adr/0001, section 7.3; docs/adr/0008).
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
    // carried out of it; an id the document does not know is read as the root.
    const known = view.space === null || src.known(view.space);
    const o = src.offset(known ? view.space : null, target);
    const moved: CameraView = {
      space: target,
      cx: view.cx + o.x,
      cy: view.cy + o.y,
      zoom: view.zoom,
    };
    if (!known || (view.space !== null && src.isGone(view.space))) return moved;
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
 * How far the anchor moved since `pinned`, as an offset in its space; null if
 * its chain of containers is not the same any more (moved into another
 * container, or gone from the document).
 */
export function shiftSince(src: AnchorSource, pinned: Pin): Point | null {
  const now = pin(src, pinned.space);
  if (now === null || now.chain.length !== pinned.chain.length) return null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < now.chain.length; i++) {
    const a = pinned.chain[i]!;
    const b = now.chain[i]!;
    if (a.id !== b.id) return null;
    x += b.x - a.x;
    y += b.y - a.y;
  }
  return { x, y };
}

/**
 * The camera's centre in root space from a pinned chain: the fallback when the
 * anchor's chain changed. It loses precision far from the root, which only
 * matters when the frame being looked at deep down is moved into another
 * container or purged.
 */
export function rootCentre(pinned: Pin, view: CameraView): Point {
  let x = view.cx;
  let y = view.cy;
  for (const level of pinned.chain) {
    x += level.x;
    y += level.y;
  }
  return { x, y };
}
