// SPDX-License-Identifier: GPL-3.0-or-later

// The cases each kind is drawn in for its screenshot test: the same set for
// every kind, made from its description, so a new kind gets its test without
// anyone writing cases. The development page apps/web/shapes.html draws them
// with the real renderer, and tests/e2e/shapes-visual.spec.ts compares each
// kind's picture with the stored one.

import type { ElementData } from "@galatsa/core";
import { shapeBounds } from "./draw.ts";
import type { ShapeKind, ShapeParam } from "./kind.ts";
import { newShapeData, readShape, type KindTable, type ShapeStyle } from "./model.ts";

/** One shape to draw: its box in the kind's strip, its rotation and data. */
export interface GalleryCase {
  /** Short name of the case, for messages from the test. */
  readonly name: string;
  /** The box's top-left corner (in the strip) and size. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Rotation about the box centre, in [0, 2π). */
  readonly rot: number;
  readonly data: ElementData;
}

/** The cases of one kind side by side, in a strip of `width` by `height` world units. */
export interface GalleryStrip {
  readonly width: number;
  readonly height: number;
  readonly cases: readonly GalleryCase[];
}

/**
 * Smallest side of the cell each case is drawn in, in world units (one pixel
 * each). A case that reaches further, by its outline width or by a parameter
 * that draws outside the box (a speech bubble's tail), gets a larger cell.
 */
export const GALLERY_CELL = 120;
/** Space around what a case draws, in its cell. */
const MARGIN = 10;

const TAU = 2 * Math.PI;

/** A value other than the default, to show a parameter at work. */
function otherValue(param: ShapeParam): number | string | boolean {
  switch (param.type) {
    case "number":
      return param.default === param.max ? param.min : param.max;
    case "choice":
      return param.options.find((o) => o.value !== param.default)?.value ?? param.default;
    case "toggle":
      return !param.default;
  }
}

interface Unplaced {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  readonly data: ElementData;
}

/** The cases for one kind, in a fixed order, unplaced. */
function galleryCases(table: KindTable, kind: ShapeKind): Unplaced[] {
  const line = kind.drawing === "line";
  const base = line ? { w: 84, h: 0 } : { w: 80, h: 80 };
  const shape = (
    name: string,
    style: Partial<ShapeStyle>,
    extra: { rot?: number; box?: { w: number; h: number }; params?: ElementData } = {},
  ): Unplaced => ({
    name,
    ...(extra.box ?? base),
    rot: (((extra.rot ?? (line ? -Math.PI / 6 : 0)) % TAU) + TAU) % TAU,
    data: { ...newShapeData(table, kind.kind, style), ...extra.params },
  });
  const cases: Unplaced[] = [
    shape("default", {}),
    shape("thick outline, no fill", { fill: null, stroke: "#0f766e", strokeWidth: 10 }),
    shape("half opacity", {
      fill: "#dc2626",
      stroke: "#111827",
      strokeWidth: 8,
      opacity: 0.5,
    }),
    shape(
      "turned",
      { fill: "#a855f7", stroke: "#3b0764", strokeWidth: 4 },
      // Not square, so that the turn shows on every kind.
      line ? { rot: Math.PI / 3 } : { rot: Math.PI / 7, box: { w: 90, h: 50 } },
    ),
    shape(
      "narrow",
      { fill: "#22c55e", stroke: "#14532d", strokeWidth: 3 },
      line ? { rot: 0, box: { w: 100, h: 0 } } : { box: { w: 100, h: 36 } },
    ),
  ];
  // An open outline is not filled, so without an outline it would show nothing.
  if (kind.closed)
    cases.push(shape("fill, no outline", { fill: "#f59e0b", stroke: null }));
  if (kind.corners === true)
    cases.push(
      shape("rounded corners", {
        fill: "#38bdf8",
        stroke: "#0c4a6e",
        strokeWidth: 6,
        cornerRadius: 22,
      }),
    );
  for (const param of kind.params ?? [])
    cases.push(
      shape(
        `${param.key} changed`,
        { strokeWidth: 4 },
        { params: { [param.key]: otherValue(param) } },
      ),
    );
  return cases;
}

/**
 * What a case draws on, turned, relative to its box centre: from the shape's
 * bounds, so a stroke or a part drawn outside the box is in its cell.
 */
function reach(table: KindTable, c: Unplaced) {
  const model = readShape(table, c.data, () => {});
  const b = shapeBounds(table, model, { w: c.w, h: c.h });
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ] as const) {
    const dx = px - c.w / 2;
    const dy = py - c.h / 2;
    const x = dx * cos - dy * sin;
    const y = dx * sin + dy * cos;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The cases for one kind, placed side by side: each in a cell at least
 * GALLERY_CELL square and large enough for everything it draws, centred.
 */
export function shapeGallery(table: KindTable, kind: ShapeKind): GalleryStrip {
  const unplaced = galleryCases(table, kind);
  const reaches = unplaced.map((c) => reach(table, c));
  const height = Math.max(
    GALLERY_CELL,
    ...reaches.map((r) => Math.ceil(r.y1 - r.y0 + 2 * MARGIN)),
  );
  let left = 0;
  const cases = unplaced.map((c, i) => {
    const r = reaches[i]!;
    const cell = Math.max(GALLERY_CELL, Math.ceil(r.x1 - r.x0 + 2 * MARGIN));
    // The box centre, so that what the case draws is centred in its cell.
    const cx = left + (cell - (r.x1 - r.x0)) / 2 - r.x0;
    const cy = (height - (r.y1 - r.y0)) / 2 - r.y0;
    left += cell;
    return { ...c, x: cx - c.w / 2, y: cy - c.h / 2 };
  });
  return { width: left, height, cases };
}
