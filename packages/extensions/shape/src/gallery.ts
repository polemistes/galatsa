// SPDX-License-Identifier: GPL-3.0-or-later

// The cases each kind is drawn in for its screenshot test: the same set for
// every kind, made from its description, so a new kind gets its test without
// anyone writing cases. The development page apps/web/shapes.html draws them
// with the real renderer, and tests/e2e/shapes-visual.spec.ts compares each
// kind's picture with the stored one.

import type { ElementData } from "@galatsa/core";
import type { ShapeKind, ShapeParam } from "./kind.ts";
import { newShapeData, type KindTable, type ShapeStyle } from "./model.ts";

/** One shape to draw: its box (in a cell of GALLERY_CELL world units), rotation and data. */
export interface GalleryCase {
  /** Short name of the case, for messages from the test. */
  readonly name: string;
  /** The box's top-left corner and size, within the cell. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Rotation about the box centre, in [0, 2π). */
  readonly rot: number;
  readonly data: ElementData;
}

/** Side of the square cell each case is drawn in, in world units (one pixel each). */
export const GALLERY_CELL = 120;

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

/** The cases for one kind, in a fixed order. */
export function shapeGallery(table: KindTable, kind: ShapeKind): GalleryCase[] {
  const line = kind.drawing === "line";
  const c = GALLERY_CELL;
  // A box shape fills most of the cell; a line runs across it.
  const box = (w: number, h: number) => ({ x: (c - w) / 2, y: (c - h) / 2, w, h });
  const base = line ? box(84, 0) : box(80, 80);
  const shape = (
    name: string,
    style: Partial<ShapeStyle>,
    extra: { rot?: number; box?: ReturnType<typeof box>; params?: ElementData } = {},
  ): GalleryCase => ({
    name,
    ...(extra.box ?? base),
    rot: (((extra.rot ?? (line ? -Math.PI / 6 : 0)) % TAU) + TAU) % TAU,
    data: { ...newShapeData(table, kind.kind, style), ...extra.params },
  });
  const cases: GalleryCase[] = [
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
      {
        rot: line ? Math.PI / 3 : Math.PI / 7,
      },
    ),
    shape(
      "narrow",
      { fill: "#22c55e", stroke: "#14532d", strokeWidth: 3 },
      line ? { rot: 0, box: box(100, 0) } : { box: box(100, 36) },
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
