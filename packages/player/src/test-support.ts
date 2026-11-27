// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for the player's own tests: small documents as snapshots, a clock
// the test moves, and measures of how far two pictures are apart. Not part of
// the program (nothing in index.ts or core.ts exports it).

import {
  FRAME_TYPE,
  type CameraView,
  type DocumentSnapshot,
  type Element,
  type ElementId,
  type Json,
  type Resolver,
  type Route,
  type Stop,
  type StopView,
} from "@galatsa/core";
import type { Picture, Shot } from "./playback.ts";

export type TestDocument = Pick<DocumentSnapshot, "elements" | "stops" | "routes">;

/** An element record with the given fields over plain defaults. */
export function element(partial: Record<string, unknown>): Element {
  return {
    type: "test.shapes/box",
    typeVersion: 1,
    parent: null,
    order: "a0",
    pos: { x: 0, y: 0, space: partial["parent"] ?? null },
    rebase: null,
    name: "",
    locked: false,
    rev: { w: 1 },
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: {},
    size: { w: 10, h: 10 },
    rot: 0,
    ...partial,
  } as unknown as Element;
}

/** A frame at (x, y) in its parent, w by h. */
export function frame(
  x: number,
  y: number,
  w: number,
  h: number,
  parent: ElementId | null = null,
  more: Record<string, unknown> = {},
): Element {
  return element({
    type: FRAME_TYPE,
    parent,
    pos: { x, y, space: parent },
    size: { w, h },
    ...more,
  });
}

export function stop(view: StopView, more: Partial<Stop> = {}): Stop {
  return {
    name: "",
    view,
    notes: { $y: "text", delta: [] },
    visibility: {},
    transition: null,
    rev: { w: 1 },
    deleted: {},
    ext: {},
    ...more,
  };
}

/** A rectangle stop. */
export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  space: ElementId | null = null,
): StopView {
  return { kind: "rect", space, x, y, w, h };
}

/** A route that visits the stops in order; entries are named e0, e1 and so on. */
export function route(stops: readonly string[], order = "a0", more: Partial<Route> = {}) {
  const entries: Route["entries"] = {};
  stops.forEach((id, i) => {
    entries[`e${i}`] = { stop: id, order: `a${String(i).padStart(3, "0")}` };
  });
  return { name: "", order, rev: {}, deleted: {}, ext: {}, entries, ...more } as Route;
}

/** A stop's transition value. */
export function transition(type: string): Json {
  return { type, options: null };
}

/** A clock the test moves. */
export function testClock(): { now(): number; advance(ms: number): void; time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    advance: (ms: number) => {
      clock.time += ms;
    },
  };
  return clock;
}

/** A pseudo-random sequence in [0, 1) from a seed. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s % 2147483648) / 2147483648;
  };
}

/** A view in root space (the test documents are small enough for that to be exact enough). */
export function inRoot(resolver: Resolver, view: CameraView): CameraView {
  if (view.space === null) return view;
  const o = resolver.offset(view.space, null);
  return { space: null, cx: view.cx + o.x, cy: view.cy + o.y, zoom: view.zoom };
}

/**
 * How far apart two views are as seen on screen: the distance between the
 * centres in screen widths, plus the zoom between them as a natural logarithm.
 */
export function viewGap(
  resolver: Resolver,
  a: CameraView,
  b: CameraView,
  width: number,
): number {
  const p = inRoot(resolver, a);
  const q = inRoot(resolver, b);
  const pan = (Math.hypot(q.cx - p.cx, q.cy - p.cy) * Math.min(p.zoom, q.zoom)) / width;
  return pan + Math.abs(Math.log(q.zoom / p.zoom));
}

interface Layer extends Shot {
  readonly weight: number;
}

function layers(picture: Picture): Layer[] {
  if (picture.kind === "view") return [{ ...picture, weight: 1 }];
  return [
    { ...picture.from, weight: 1 - picture.mix },
    { ...picture.to, weight: picture.mix },
  ];
}

/** Two sets of hidden elements with the same members. */
function sameHidden(a: Shot["hidden"], b: Shot["hidden"]): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Views closer than this on screen count as the same view moving on. */
const SAME_VIEW = 0.02;

/**
 * How far apart two pictures are, between 0 (the same) and about 1 (nothing in
 * common). Two single views: their gap on screen (0 to 1 and beyond).
 * Otherwise the share of the screen's light that changed hands between the
 * views shown (a cross-fade moving on), plus how far the views that stayed
 * moved. `popped` says that a view that stayed changed what is hidden in it.
 */
export function pictureGap(
  resolver: Resolver,
  a: Picture,
  b: Picture,
  width: number,
): { gap: number; popped: boolean } {
  const la = layers(a);
  const lb = layers(b);
  if (la.length === 1 && lb.length === 1)
    return {
      gap: viewGap(resolver, la[0]!.view, lb[0]!.view, width),
      popped: !sameHidden(la[0]!.hidden, lb[0]!.hidden),
    };
  // The pairing of the views of the two pictures that explains the change best.
  let best = { gap: Infinity, popped: false };
  const pair = (
    i: number,
    used: readonly Layer[],
    moved: number,
    shifted: number,
    popped: boolean,
  ): void => {
    const p = la[i];
    if (p === undefined) {
      for (const q of lb) if (!used.includes(q)) moved += q.weight;
      const gap = moved / 2 + shifted;
      if (gap < best.gap) best = { gap, popped };
      return;
    }
    pair(i + 1, used, moved + p.weight, shifted, popped);
    for (const q of lb) {
      if (used.includes(q)) continue;
      const gap = viewGap(resolver, p.view, q.view, width);
      if (gap >= SAME_VIEW) continue;
      const shared = Math.min(p.weight, q.weight);
      pair(
        i + 1,
        [...used, q],
        moved + Math.abs(p.weight - q.weight),
        shifted + gap * shared,
        popped || (!sameHidden(p.hidden, q.hidden) && shared > 0),
      );
    }
  };
  pair(0, [], 0, 0, false);
  return best;
}

/** Every view of a picture is a usable camera. */
export function usable(picture: Picture): boolean {
  return layers(picture).every(
    (l) =>
      Number.isFinite(l.view.cx) &&
      Number.isFinite(l.view.cy) &&
      Number.isFinite(l.view.zoom) &&
      l.view.zoom > 0 &&
      l.weight >= 0 &&
      l.weight <= 1,
  );
}
