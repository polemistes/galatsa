// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the shape extension, viewing part: shapes described as data (a
// template draws the outline and decides hits), with fill, outline, corner
// rounding and opacity.

import {
  defineElementView,
  defineViewExtension,
  type Label,
  type Path,
} from "@galatsa/extension-api";
import { API, label, readChoice, readColor, readNumber } from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const SHAPE_EXTENSION = "examples.shape";
export const SHAPE_TYPE = `${SHAPE_EXTENSION}/shape`;

/**
 * A shape template. Adding a shape is adding one of these: the type, its tool
 * and its entry in the shape menu follow.
 */
export interface ShapeTemplate {
  readonly kind: string;
  readonly label: Label;
  readonly shortcut?: string;
  /** Adds the outline for a box of w by h to `path`. */
  outline(path: Path, w: number, h: number, cornerRadius: number): void;
  /** True if (x, y) is inside the outline, grown by `tolerance`. */
  contains(x: number, y: number, w: number, h: number, tolerance: number): boolean;
}

export const TEMPLATES: readonly ShapeTemplate[] = [
  {
    kind: "rect",
    label: label("shape.kind.rect"),
    shortcut: "r",
    outline: (path, w, h, r) =>
      r > 0
        ? path.roundRect(0, 0, w, h, Math.min(r, w / 2, h / 2))
        : path.rect(0, 0, w, h),
    contains: (x, y, w, h, t) => x >= -t && y >= -t && x <= w + t && y <= h + t,
  },
  {
    kind: "ellipse",
    label: label("shape.kind.ellipse"),
    shortcut: "o",
    outline: (path, w, h) => path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI),
    contains: (x, y, w, h, t) => {
      const rx = w / 2 + t;
      const ry = h / 2 + t;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (x - w / 2) / rx;
      const dy = (y - h / 2) / ry;
      return dx * dx + dy * dy <= 1;
    },
  },
  {
    kind: "triangle",
    label: label("shape.kind.triangle"),
    outline: (path, w, h) => {
      path.moveTo(w / 2, 0);
      path.lineTo(w, h);
      path.lineTo(0, h);
      path.closePath();
    },
    contains: (x, y, w, h, t) => {
      if (y < -t || y > h + t || h <= 0) return false;
      // Half the width of the triangle at height y, grown by the tolerance.
      const half = (w / 2) * Math.min(1, Math.max(0, y / h)) + t;
      return Math.abs(x - w / 2) <= half;
    },
  },
];

export const KINDS = TEMPLATES.map((t) => t.kind);

function template(kind: string): ShapeTemplate {
  return TEMPLATES.find((t) => t.kind === kind) ?? TEMPLATES[0]!;
}

export interface ShapeModel {
  readonly kind: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly cornerRadius: number;
  readonly opacity: number;
}

export const shapeView = defineElementView<ShapeModel>({
  name: "shape",
  label: label("shape.name"),
  typeVersion: 1,
  read(data, _typeVersion, report) {
    return {
      // A kind from a newer version of the extension draws as a rectangle.
      kind: readChoice(data, "kind", KINDS, "rect", report),
      fill: readColor(data, "fill", "#93c5fd", report, true),
      stroke: readColor(data, "stroke", "#1e3a8a", report, true),
      strokeWidth: readNumber(data, "strokeWidth", 2, report, { min: 0, max: 1e6 }),
      cornerRadius: readNumber(data, "cornerRadius", 0, report, { min: 0, max: 1e6 }),
      opacity: readNumber(data, "opacity", 1, report, { min: 0, max: 1 }),
    };
  },
  draw(model, ctx, box) {
    const path = ctx.createPath();
    template(model.kind).outline(path, box.w, box.h, model.cornerRadius);
    ctx.withOpacity(model.opacity, () => {
      if (model.fill !== null) ctx.fill(path, model.fill);
      // Thin detail is left out when the shape is tiny on screen.
      if (model.stroke !== null && model.strokeWidth > 0 && ctx.detail !== "box")
        ctx.stroke(path, {
          color: model.stroke,
          width: model.strokeWidth,
          join: "round",
        });
    });
  },
  bounds(model, box) {
    const out = model.stroke !== null ? model.strokeWidth / 2 : 0;
    return { x: -out, y: -out, w: box.w + 2 * out, h: box.h + 2 * out };
  },
  hitTest(model, point, box, tolerance) {
    const grow = tolerance + (model.stroke !== null ? model.strokeWidth / 2 : 0);
    return template(model.kind).contains(point.x, point.y, box.w, box.h, grow);
  },
});

export const shapeViewExtension = defineViewExtension({
  id: SHAPE_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
  elementTypes: [shapeView],
});
