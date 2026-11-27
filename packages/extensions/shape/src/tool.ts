// SPDX-License-Identifier: GPL-3.0-or-later

// The drawing tool of a shape kind: while the user drags, the overlay shows
// the shape as it will be made, in its real style; on release one command
// makes it (one undo step); Escape cancels without writing anything.

import type { Point } from "@galatsa/core";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerEvent,
  ToolSession,
} from "@galatsa/extension-api/editing";
import { drawShape, placedContext } from "./draw.ts";
import type { ShapeKind } from "./kind.ts";
import {
  MAX_LENGTH,
  newShapeData,
  readShape,
  type KindTable,
  type ShapeModel,
  type ShapeStyle,
} from "./model.ts";

/** Arguments of the insert command. */
export interface InsertShapeArgs {
  readonly kind: string;
  /** Top-left corner of the unrotated box, in the parent's space. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Rotation about the box centre, in radians (default 0). */
  readonly rot?: number;
  readonly parent?: string | null;
  /** Style values over the defaults. */
  readonly style?: Partial<ShapeStyle>;
}

/** Outline width of a new shape, in screen pixels at the zoom it is drawn at. */
export const STROKE_PIXELS = 2;

/** The length, in world units, that is `pixels` long on screen at `zoom`. */
function lengthAt(pixels: number, zoom: number): number {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return Math.min(MAX_LENGTH, pixels / z);
}

/** The outline width, in world units, that is STROKE_PIXELS wide on screen at `zoom`. */
export function strokeWidthAt(zoom: number): number {
  return lengthAt(STROKE_PIXELS, zoom);
}

/**
 * The lengths of the style a new shape of `kind` gets at `zoom`: the outline
 * width, and the kind's own default lengths (ShapeKind.defaults), as many
 * world units as they are screen pixels at zoom 1.
 */
export function newStyleAt(kind: ShapeKind, zoom: number): Partial<ShapeStyle> {
  const { strokeWidth, cornerRadius } = kind.defaults ?? {};
  return {
    strokeWidth:
      strokeWidth !== undefined ? lengthAt(strokeWidth, zoom) : strokeWidthAt(zoom),
    ...(cornerRadius !== undefined ? { cornerRadius: lengthAt(cornerRadius, zoom) } : {}),
  };
}

/** Size of a shape made by a click without dragging, in screen pixels. */
export const CLICK_SIZE = 100;
/** A drag shorter than this many screen pixels counts as a click. */
export const CLICK_SLOP = 3;
/** Shift keeps a line's angle to multiples of this. */
export const ANGLE_STEP = Math.PI / 12;

const TAU = 2 * Math.PI;

/** A rotation in [0, 2π). */
export function normalizeRotation(rot: number): number {
  const r = ((rot % TAU) + TAU) % TAU;
  return r === TAU ? 0 : r;
}

type Placed = Omit<InsertShapeArgs, "kind" | "parent">;

/** The box a drag from `a` to `b` describes: Shift for a square, Alt to draw from the centre. */
export function dragBox(
  a: Point,
  b: Point,
  square: boolean,
  fromCentre: boolean,
): Placed {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (square) w = h = Math.max(w, h);
  if (fromCentre) return { x: a.x - w, y: a.y - h, w: 2 * w, h: 2 * h, rot: 0 };
  return { x: b.x < a.x ? a.x - w : a.x, y: b.y < a.y ? a.y - h : a.y, w, h, rot: 0 };
}

/**
 * The line a drag from `a` to `b` describes: a box as long as the drag and 0
 * high, centred between the two points and turned in the drag's direction.
 * With `snap`, the angle is kept to multiples of ANGLE_STEP.
 */
export function dragLine(a: Point, b: Point, snap: boolean): Placed {
  let length = Math.hypot(b.x - a.x, b.y - a.y);
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  if (snap) angle = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
  if (!(length > 0)) length = 0;
  const cx = a.x + (Math.cos(angle) * length) / 2;
  const cy = a.y + (Math.sin(angle) * length) / 2;
  return { x: cx - length / 2, y: cy, w: length, h: 0, rot: normalizeRotation(angle) };
}

/** The shape a click at `at` makes: CLICK_SIZE screen pixels across at `zoom` pixels per unit. */
export function clickShape(kind: ShapeKind, at: Point, zoom: number): Placed {
  const size = CLICK_SIZE / (zoom > 0 && Number.isFinite(zoom) ? zoom : 1);
  if (kind.drawing === "line")
    return { x: at.x - size / 2, y: at.y, w: size, h: 0, rot: 0 };
  return { x: at.x - size / 2, y: at.y - size / 2, w: size, h: size, rot: 0 };
}

function zoomOf(session: ToolSession): number {
  try {
    return session.environment().services.camera.get().zoom;
  } catch {
    return 1;
  }
}

/** The drawing tool of `kind`, which runs `insertCommand` with InsertShapeArgs. */
export function shapeTool(
  table: KindTable,
  typeId: string,
  kind: ShapeKind,
  insertCommand: string,
): ToolDefinition {
  // The preview is drawn with the style a new shape gets at the zoom.
  const modelAt = (zoom: number): ShapeModel =>
    readShape(table, newShapeData(table, kind.kind, newStyleAt(kind, zoom)), () => {});
  const placed = (from: ToolPointerEvent, to: ToolPointerEvent): Placed =>
    kind.drawing === "line"
      ? dragLine(from.world, to.world, to.modifiers.shift)
      : dragBox(from.world, to.world, to.modifiers.shift, to.modifiers.alt);
  return {
    name: kind.kind,
    label: kind.label,
    ...(kind.shortcut !== undefined ? { shortcuts: [kind.shortcut] } : {}),
    quick: kind.quick ?? true,
    group: "shapes",
    cursor: "crosshair",
    start(session): ToolHandler {
      let start: ToolPointerEvent | null = null;
      let current: ToolPointerEvent | null = null;
      const reset = (): void => {
        if (start === null) return;
        start = current = null;
        session.requestOverlay();
      };
      return {
        pointerDown(event) {
          if (event.button !== 0) return;
          start = current = event;
          session.requestOverlay();
        },
        pointerMove(event) {
          if (start === null) return;
          current = event;
          session.requestOverlay();
        },
        pointerUp(event) {
          if (start === null) return;
          const from = start;
          reset();
          const moved = Math.hypot(
            event.screen.x - from.screen.x,
            event.screen.y - from.screen.y,
          );
          const zoom = zoomOf(session);
          const box =
            moved < CLICK_SLOP ? clickShape(kind, from.world, zoom) : placed(from, event);
          session.run(insertCommand, {
            kind: kind.kind,
            ...box,
            style: newStyleAt(kind, zoom),
          } satisfies InsertShapeArgs);
          session.done();
        },
        pointerCancel: reset,
        keyDown(event) {
          if (event.key !== "Escape" || start === null) return false;
          reset();
          return true;
        },
        drawOverlay(ctx) {
          if (start === null || current === null) return;
          const moved = Math.hypot(
            current.screen.x - start.screen.x,
            current.screen.y - start.screen.y,
          );
          if (moved < CLICK_SLOP) return;
          const p = placed(start, current);
          const rot = p.rot ?? 0;
          // The overlay draws in root space and only translates; the kind
          // draws in its box, turned about the box centre.
          const cx = p.x + p.w / 2;
          const cy = p.y + p.h / 2;
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const placedCtx = placedContext(ctx, {
            rot,
            dx: cx - (cos * p.w) / 2 + (sin * p.h) / 2,
            dy: cy - (sin * p.w) / 2 - (cos * p.h) / 2,
          });
          drawShape(table, typeId, modelAt(zoomOf(session)), placedCtx, {
            w: p.w,
            h: p.h,
          });
        },
        stop: reset,
      };
    },
  };
}
