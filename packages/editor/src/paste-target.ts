// SPDX-License-Identifier: GPL-3.0-or-later

// Where a paste lands (docs/adr/0008-selection.md, with frames in
// docs/adr/0014-stacking-and-frames.md). The container, in order:
//
// 1. A frame is selected, alone, and is not one of the copied elements: into
//    that frame ("paste into the frame I picked").
// 2. Otherwise, what is selected is all seen in one open container that is in
//    view (the canvas, or a frame that meets the view): into that
//    container, next to what is selected. After a copy the copied elements
//    are still selected, so a paste lands next to them, in their container.
// 3. Otherwise, the container it was copied from (or the canvas), while that
//    is there, seen and not locked, and the place it would land there is in
//    view.
// 4. Otherwise, the frame the user is looking at: the innermost open frame
//    around the centre of the view, or the canvas.
//
// It keeps its place on the canvas when that place can be seen in the target:
// it meets the view and, in a frame, the part of the frame in view. Otherwise
// it is centred in that part (a frame out of view altogether: in the frame).
// So a paste never lands in one frame while it shows in another, and lands
// out of sight only in a selected frame that is out of view.

import type { ElementId, Point, Rect } from "@galatsa/core";
import type { ClipboardOrigin } from "./clipboard.ts";

/** What the rule reads of the document, as a resolver gives it. */
export interface PasteScene {
  get(
    id: ElementId,
  ):
    | { readonly type: string; readonly size?: { w: number; h: number } | undefined }
    | undefined;
  logicalParentOf(id: ElementId): ElementId | null;
  logicalChildren(parent: ElementId | null): readonly ElementId[];
  isContainer(id: ElementId | null): boolean;
  isGone(id: ElementId): boolean;
  isLocked(id: ElementId): boolean;
  /** A point in space `from` plus this is the same point in space `to`. */
  offset(from: ElementId | null, to: ElementId | null): Point;
}

export interface PasteInput {
  readonly scene: PasteScene;
  /** The frame element type ("core/frame"). */
  readonly frameType: string;
  /** The fragment's roots, with the ids they were copied with. */
  readonly roots: readonly ElementId[];
  /** The fragment's bounds in the space of its roots' container; null if nothing has a size. */
  readonly bounds: Rect | null;
  readonly origin: ClipboardOrigin | null;
  readonly selection: readonly ElementId[];
  /** What the camera shows, in root space; null when there is no screen. */
  readonly view: Rect | null;
}

/** The paste command's `parent`, `dx` and `dy`. */
export interface PasteTarget {
  readonly parent: ElementId | null;
  readonly dx: number;
  readonly dy: number;
}

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w >= 0 && h >= 0 ? { x, y, w, h } : null;
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function moved(r: Rect, by: Point): Rect {
  return { x: r.x + by.x, y: r.y + by.y, w: r.w, h: r.h };
}

export function pasteTarget(input: PasteInput): PasteTarget {
  const { scene, selection, view, frameType, bounds } = input;
  const origin = input.origin ?? { container: null, at: { x: 0, y: 0 } };
  const open = (id: ElementId | null): boolean =>
    id === null ||
    (scene.get(id) !== undefined &&
      scene.isContainer(id) &&
      !scene.isGone(id) &&
      !scene.isLocked(id));
  const isFrame = (id: ElementId | null): id is ElementId =>
    id !== null && scene.get(id)?.type === frameType;
  const boxOf = (id: ElementId): Rect | null => {
    const size = scene.get(id)?.size;
    return size === undefined
      ? null
      : { ...scene.offset(id, null), w: size.w, h: size.h };
  };
  const seen = (r: Rect | null): boolean =>
    view === null || r === null || intersection(view, r) !== null;

  // Into the container it came from, the positions stay as they are and it
  // lands where that container is now (it may have moved); anywhere else it
  // keeps the place on the canvas it was copied from.
  const home = origin.container === null || open(origin.container);
  const atCopy = bounds === null ? null : moved(bounds, origin.at);
  const atHome =
    bounds === null || origin.container === null || !open(origin.container)
      ? atCopy
      : moved(bounds, scene.offset(origin.container, null));

  let parent: ElementId | null | undefined;
  const only = selection.length === 1 ? selection[0]! : null;
  if (only !== null && isFrame(only) && open(only) && !input.roots.includes(only))
    parent = only;
  else if (selection.length > 0) {
    const containers = new Set(
      selection
        .filter((id) => scene.get(id) !== undefined && !scene.isGone(id))
        .map((id) => scene.logicalParentOf(id)),
    );
    const [only] = containers;
    // Not a frame out of view: the paste would land out of sight.
    if (containers.size === 1 && open(only!) && (only === null || seen(boxOf(only!))))
      parent = only!;
  }
  if (parent === undefined && home && seen(atHome)) parent = origin.container;
  if (parent === undefined) {
    parent = null;
    if (view !== null) {
      const centre = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      for (;;) {
        const children = scene.logicalChildren(parent);
        let next: ElementId | null = null;
        for (let i = children.length - 1; i >= 0; i--) {
          const id = children[i]!;
          const box = isFrame(id) && open(id) ? boxOf(id) : null;
          if (box !== null && contains(box, centre)) {
            next = id;
            break;
          }
        }
        if (next === null) break;
        parent = next;
      }
    }
  }

  const intoHome = parent === origin.container && home;
  let shift: Point = { x: 0, y: 0 };
  if (!intoHome) {
    const o = scene.offset(null, parent);
    shift = { x: origin.at.x + o.x, y: origin.at.y + o.y };
  }
  const lands = intoHome ? atHome : atCopy;
  if (lands === null || view === null) return { parent, ...dxy(shift) };
  const box = parent === null ? null : boxOf(parent);
  const region = box === null ? view : (intersection(view, box) ?? box);
  if (intersection(region, lands) !== null) return { parent, ...dxy(shift) };
  return {
    parent,
    dx: shift.x + region.x + region.w / 2 - (lands.x + lands.w / 2),
    dy: shift.y + region.y + region.h / 2 - (lands.y + lands.h / 2),
  };
}

function dxy(p: Point): { dx: number; dy: number } {
  return { dx: p.x, dy: p.y };
}
