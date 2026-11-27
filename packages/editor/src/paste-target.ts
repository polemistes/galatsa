// SPDX-License-Identifier: GPL-3.0-or-later

// Where a paste lands (docs/adr/0008-selection.md, with frames in
// docs/adr/0014-stacking-and-frames.md). The container, in order:
//
// 1. A frame is selected, alone, and is not one of the copied elements nor a
//    copy pasted from them before: into that frame ("paste into the frame I
//    picked").
// 2. Otherwise, what is selected is all seen in one open container that is in
//    view (the canvas, or a frame that meets the view): into that container.
//    Where that is the container it was copied from (after a copy the copied
//    elements are still selected), it keeps its place; elsewhere it is put
//    where the selection is, centred on it.
// 3. Otherwise, the container it was copied from (or the canvas), while that
//    is there, seen and not locked, and the place it would land there is in
//    view.
// 4. Otherwise, the frame being looked at: the frame on top at the centre of
//    the view, or the canvas.
//
// It keeps its place on the canvas (or the selection's, 2) when that can be
// seen in the target: it meets the view and, in a frame, the part of the
// frame in view. Otherwise it is centred in that part (a frame out of view
// altogether: in the frame).
//
// Last, it goes into the frame it shows in: where another frame than the
// target is on top at the centre of where it lands (not one of the copied
// frames, nor a copy of them), it goes into that frame, at the same place. So
// a paste never lands in one frame while showing in another.

import type { ElementId, Point, Rect } from "@galatsa/core";
import { topFrameAt, type OpenFrame } from "@galatsa/extension-basics";
import type { ClipboardOrigin } from "./clipboard.ts";

/** What the rule reads of the document, as a resolver gives it. */
export interface PasteScene {
  get(
    id: ElementId,
  ):
    | { readonly type: string; readonly size?: { w: number; h: number } | undefined }
    | undefined;
  logicalParentOf(id: ElementId): ElementId | null;
  isContainer(id: ElementId | null): boolean;
  isGone(id: ElementId): boolean;
  isLocked(id: ElementId): boolean;
  /** A point in space `from` plus this is the same point in space `to`. */
  offset(from: ElementId | null, to: ElementId | null): Point;
  /** An element's bounds in root space. */
  bounds(id: ElementId): Rect | null;
}

export interface PasteInput {
  readonly scene: PasteScene;
  /** The frame element type ("core/frame"). */
  readonly frameType: string;
  /**
   * The open frames, in drawing order, without the copied elements, the
   * copies pasted from them before and what is inside those (`openFrames`).
   */
  readonly frames: readonly OpenFrame[];
  /** The fragment's roots, with the ids they were copied with. */
  readonly roots: readonly ElementId[];
  /** What earlier pastes of the same fragment made: copies, not targets. */
  readonly copies: readonly ElementId[];
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

function moved(r: Rect, by: Point): Rect {
  return { x: r.x + by.x, y: r.y + by.y, w: r.w, h: r.h };
}

function centre(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function union(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
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
  const copied = (id: ElementId): boolean =>
    input.roots.includes(id) || input.copies.includes(id);

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
  /** Where it lands before it is fitted to what can be seen (root space). */
  let lands: Rect | null = null;
  const only = selection.length === 1 ? selection[0]! : null;
  if (only !== null && isFrame(only) && open(only) && !copied(only)) parent = only;
  else if (selection.length > 0) {
    const shown = selection.filter(
      (id) => scene.get(id) !== undefined && !scene.isGone(id),
    );
    const containers = new Set(shown.map((id) => scene.logicalParentOf(id)));
    const [one] = containers;
    // Not a frame out of view: the paste would land out of sight.
    if (containers.size === 1 && open(one!) && (one === null || seen(boxOf(one!)))) {
      parent = one!;
      if (!(parent === origin.container && home) && bounds !== null) {
        // Next to what is selected: centred on it.
        const around = union(
          shown.map((id) => scene.bounds(id)).filter((b): b is Rect => b !== null),
        );
        if (around !== null) {
          const c = centre(around);
          lands = {
            x: c.x - bounds.w / 2,
            y: c.y - bounds.h / 2,
            w: bounds.w,
            h: bounds.h,
          };
        }
      }
    }
  }
  if (parent === undefined && home && seen(atHome)) parent = origin.container;
  if (parent === undefined)
    parent = view === null ? null : topFrameAt(input.frames, centre(view));

  const intoHome = parent === origin.container && home;
  lands ??= intoHome ? atHome : atCopy;
  if (lands === null || bounds === null) {
    // Nothing with a size: the positions as copied, in root space elsewhere.
    if (intoHome) return { parent, dx: 0, dy: 0 };
    const o = scene.offset(null, parent);
    return { parent, dx: origin.at.x + o.x, dy: origin.at.y + o.y };
  }
  if (view !== null) {
    const box = parent === null ? null : boxOf(parent);
    const region = box === null ? view : (intersection(view, box) ?? box);
    if (intersection(region, lands) === null) {
      const c = centre(region);
      lands = { x: c.x - lands.w / 2, y: c.y - lands.h / 2, w: lands.w, h: lands.h };
    }
  }
  // Into the frame it shows in.
  const shownIn = topFrameAt(input.frames, centre(lands));
  if (shownIn !== parent && (shownIn === null || !copied(shownIn))) parent = shownIn;
  // Back where it came from, unmoved: the positions exactly as copied.
  if (lands === atHome && parent === origin.container && home)
    return { parent, dx: 0, dy: 0 };
  // The offset that puts the fragment's bounds at `lands` in the parent's space.
  const o = scene.offset(parent, null);
  return { parent, dx: lands.x - bounds.x - o.x, dy: lands.y - bounds.y - o.y };
}
