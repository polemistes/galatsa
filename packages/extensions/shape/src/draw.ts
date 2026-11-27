// SPDX-License-Identifier: GPL-3.0-or-later

// Drawing, hit testing and bounds of shapes, from the kind's outline alone.

import type { ElementId, Rect } from "@galatsa/core";
import { drawPlaceholder, type DrawContext, type Path } from "@galatsa/extension-api";
import {
  extent,
  flatten,
  insideFill,
  outlineDistance,
  PlacedPath,
  RecordingPath,
  type Flattened,
  type Placement,
} from "./geometry.ts";
import type { ShapeGeometry, ShapeKind, ShapeOutline } from "./kind.ts";
import type { KindTable, ShapeModel } from "./model.ts";

interface Box {
  readonly w: number;
  readonly h: number;
  /** The element, when drawing one (not for previews). */
  readonly id?: ElementId;
}

/** What the kind draws from, for a model in a box. */
export function geometryOf(kind: ShapeKind, model: ShapeModel, box: Box): ShapeGeometry {
  const half = Math.max(0, Math.min(box.w, box.h) / 2);
  return {
    w: box.w,
    h: box.h,
    cornerRadius: kind.corners === true ? Math.min(model.cornerRadius, half) : 0,
    strokeWidth: model.stroke !== null ? model.strokeWidth : 0,
    params: model.params,
  };
}

/** Draws a shape in its local box. A kind this version does not know is drawn as a placeholder. */
export function drawShape(
  table: KindTable,
  typeId: string,
  model: ShapeModel,
  ctx: DrawContext,
  box: Box,
): void {
  const kind = table.kinds.get(model.kind);
  if (kind === undefined) {
    drawPlaceholder(
      ctx,
      { id: box.id ?? "", w: box.w, h: box.h },
      "newer",
      `${typeId}: ${model.kind}`,
    );
    return;
  }
  const body = ctx.createPath();
  let marks: Path | null = null;
  const out: ShapeOutline = {
    body,
    get marks() {
      return (marks ??= ctx.createPath());
    },
  };
  kind.outline(out, geometryOf(kind, model, box));
  const filled = kind.closed && model.fill !== null;
  const stroked = model.stroke !== null && model.strokeWidth > 0;
  ctx.withOpacity(model.opacity, () => {
    if (filled) ctx.fill(body, model.fill!);
    // A filled shape a few pixels across is drawn as its fill alone.
    if (stroked && !(filled && ctx.detail === "box"))
      ctx.stroke(body, {
        color: model.stroke!,
        width: model.strokeWidth,
        join: kind.join ?? "round",
        cap: kind.cap ?? "round",
      });
    if (marks !== null && model.stroke !== null) ctx.fill(marks, model.stroke);
  });
}

/** The outline of a shape, recorded. */
function recorded(kind: ShapeKind, model: ShapeModel, box: Box) {
  const body = new RecordingPath();
  let marks: RecordingPath | null = null;
  kind.outline(
    {
      body,
      get marks() {
        return (marks ??= new RecordingPath());
      },
    },
    geometryOf(kind, model, box),
  );
  return { body, marks: marks as RecordingPath | null };
}

function strokeReach(kind: ShapeKind, model: ShapeModel): number {
  if (model.stroke === null) return 0;
  return model.strokeWidth * (kind.strokeReach ?? 0.5);
}

/** Chord error wanted for bounds, which the error is added to: a thousandth of the box. */
function boundsTolerance(box: Box): number {
  return Math.max(Math.abs(box.w), Math.abs(box.h), Number.MIN_VALUE) / 1024;
}

/** The area a shape draws on, in its local box: its outline and marks with the outline's reach, and the box. */
export function shapeBounds(table: KindTable, model: ShapeModel, box: Box): Rect {
  const kind = table.kinds.get(model.kind);
  let area: Rect = { x: 0, y: 0, w: box.w, h: box.h };
  if (kind === undefined) return area;
  const { body, marks } = recorded(kind, model, box);
  const tolerance = boundsTolerance(box);
  const grow = (rect: Rect, by: number): Rect => ({
    x: rect.x - by,
    y: rect.y - by,
    w: rect.w + 2 * by,
    h: rect.h + 2 * by,
  });
  const union = (a: Rect, b: Rect): Rect => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
  };
  const bodyLines = flatten(body.ops, tolerance);
  const bodyExtent = extent(bodyLines.lines);
  if (bodyExtent !== null)
    area = union(area, grow(bodyExtent, bodyLines.error + strokeReach(kind, model)));
  if (marks !== null && model.stroke !== null) {
    const markLines = flatten(marks.ops, tolerance);
    const markExtent = extent(markLines.lines);
    if (markExtent !== null) area = union(area, grow(markExtent, markLines.error));
  }
  return area;
}

/**
 * True if a point in the local box hits the shape, within `tolerance` world
 * units: inside the fill of a filled closed shape, on the outline (within half
 * the outline width), or on a mark. A shape without fill is hit on its outline
 * only, so what is behind it can be clicked through its middle.
 */
export function hitShape(
  table: KindTable,
  model: ShapeModel,
  point: { readonly x: number; readonly y: number },
  box: Box,
  tolerance: number,
): boolean {
  const kind = table.kinds.get(model.kind);
  if (kind === undefined)
    return (
      point.x >= -tolerance &&
      point.y >= -tolerance &&
      point.x <= box.w + tolerance &&
      point.y <= box.h + tolerance
    );
  const { body, marks } = recorded(kind, model, box);
  const size = Math.max(Math.abs(box.w), Math.abs(box.h));
  const flat = (ops: RecordingPath): Flattened =>
    flatten(ops.ops, Math.max(tolerance / 4, size / 4096, Number.MIN_VALUE));
  const bodyLines = flat(body);
  if (kind.closed && model.fill !== null && insideFill(bodyLines.lines, point.x, point.y))
    return true;
  const reach = model.stroke !== null ? model.strokeWidth / 2 : 0;
  if (
    outlineDistance(bodyLines.lines, point.x, point.y) <=
    tolerance + reach + bodyLines.error
  )
    return true;
  if (marks !== null && model.stroke !== null) {
    const markLines = flat(marks);
    if (insideFill(markLines.lines, point.x, point.y)) return true;
    if (outlineDistance(markLines.lines, point.x, point.y) <= tolerance + markLines.error)
      return true;
  }
  return false;
}

/**
 * A drawing context that places what is drawn into it: paths are turned by
 * `placement.rot` about the origin and moved by (dx, dy) before they reach
 * `ctx`. For previews of turned shapes in a context that only translates
 * (a tool's overlay). Images and text cannot be turned there and are left out.
 */
export function placedContext(ctx: DrawContext, placement: Placement): DrawContext {
  const inner = (path: Path): Path => (path instanceof PlacedPath ? path.target : path);
  let current = placement;
  return {
    get scale() {
      return ctx.scale;
    },
    get detail() {
      return ctx.detail;
    },
    createPath: () => new PlacedPath(ctx.createPath(), current),
    fill: (path, color) => ctx.fill(inner(path), color),
    stroke: (path, style) => ctx.stroke(inner(path), style),
    withOpacity: (alpha, draw) => ctx.withOpacity(alpha, draw),
    withClip: (path, draw) => ctx.withClip(inner(path), draw),
    withOffset(x, y, draw) {
      const before = current;
      const cos = Math.cos(before.rot);
      const sin = Math.sin(before.rot);
      current = {
        rot: before.rot,
        dx: before.dx + x * cos - y * sin,
        dy: before.dy + x * sin + y * cos,
      };
      try {
        draw();
      } finally {
        current = before;
      }
    },
    drawImage: () => "missing",
    layoutText: (content, style, width) => ctx.layoutText(content, style, width),
    drawText: () => {},
    t: (label, values) => ctx.t(label, values),
  };
}
