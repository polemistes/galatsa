// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the shape extension: shapes described as data (a template draws
// the outline and decides hits), with fill, outline, corner rounding and
// opacity, and one drawing tool per template that shows a preview while the
// user drags and makes the shape with one command at the end.

import type { ElementId, Point } from "@galatsa/core";
import {
  capabilitiesOf,
  defineCommand,
  defineElementType,
  defineExtension,
  elementFacts,
  insertElement,
  updateElementData,
  type CommandContext,
  type Label,
  type Path,
  type ToolDefinition,
  type ToolHandler,
  type ToolPointerEvent,
} from "@galatsa/extension-api";
import {
  API,
  label,
  readChoice,
  readColor,
  readFieldChange,
  readNumber,
} from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const SHAPE_EXTENSION = "examples.shape";
export const SHAPE_TYPE = `${SHAPE_EXTENSION}/shape`;
export const SHAPE_INSERT = `${SHAPE_EXTENSION}/insert`;
export const SHAPE_SET_STYLE = `${SHAPE_EXTENSION}/set-style`;

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

const KINDS = TEMPLATES.map((t) => t.kind);

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

export const shapeType = defineElementType<ShapeModel>({
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
  properties: [
    {
      key: "fill",
      label: label("shape.fill"),
      quick: true,
      control: { kind: "color", allowNone: true },
      get: (m) => m.fill,
      command: SHAPE_SET_STYLE,
    },
    {
      key: "stroke",
      label: label("shape.stroke"),
      quick: true,
      control: { kind: "color", allowNone: true },
      get: (m) => m.stroke,
      command: SHAPE_SET_STYLE,
    },
    {
      key: "strokeWidth",
      label: label("shape.stroke-width"),
      quick: true,
      control: { kind: "number", min: 0, max: 200, step: 1 },
      get: (m) => m.strokeWidth,
      command: SHAPE_SET_STYLE,
    },
    {
      key: "kind",
      label: label("shape.kind"),
      control: {
        kind: "select",
        options: TEMPLATES.map((t) => ({ value: t.kind, label: t.label })),
      },
      get: (m) => m.kind,
      command: SHAPE_SET_STYLE,
    },
    {
      key: "cornerRadius",
      label: label("shape.corner-radius"),
      control: { kind: "number", min: 0, max: 1000, step: 1 },
      get: (m) => m.cornerRadius,
      command: SHAPE_SET_STYLE,
    },
    {
      key: "opacity",
      label: label("shape.opacity"),
      control: { kind: "number", min: 0, max: 1, step: 0.05 },
      get: (m) => m.opacity,
      command: SHAPE_SET_STYLE,
    },
  ],
});

export interface InsertShapeArgs {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly parent?: ElementId | null;
}

function isInsertArgs(args: unknown): args is InsertShapeArgs {
  if (args === null || typeof args !== "object") return false;
  const a = args as Record<string, unknown>;
  return (
    typeof a["kind"] === "string" &&
    KINDS.includes(a["kind"]) &&
    ["x", "y", "w", "h"].every((k) => typeof a[k] === "number" && Number.isFinite(a[k]))
  );
}

const insertShape = defineCommand<InsertShapeArgs, ElementId>({
  name: "insert",
  label: label("shape.insert"),
  quick: true,
  enabled: (_ctx, args) => isInsertArgs(args) && args.w >= 0 && args.h >= 0,
  execute(ctx, args) {
    return insertElement(ctx, {
      type: SHAPE_TYPE,
      parent: args.parent ?? null,
      x: args.x,
      y: args.y,
      size: { w: args.w, h: args.h },
      data: {
        kind: args.kind,
        fill: "#93c5fd",
        stroke: "#1e3a8a",
        strokeWidth: 2,
        cornerRadius: 0,
        opacity: 1,
      },
    });
  },
});

const STYLE_KEYS = new Set([
  "fill",
  "stroke",
  "strokeWidth",
  "kind",
  "cornerRadius",
  "opacity",
]);

function allEditableShapes(ctx: CommandContext, ids: readonly ElementId[]): boolean {
  return (
    ids.length > 0 &&
    ids.every(
      (id) =>
        elementFacts(ctx, id).type === SHAPE_TYPE && capabilitiesOf(ctx, id).editContent,
    )
  );
}

const setStyle = defineCommand<unknown, void>({
  name: "set-style",
  label: label("shape.set-style"),
  quick: true,
  enabled(ctx, args) {
    const change = readFieldChange(args);
    return (
      change !== undefined &&
      STYLE_KEYS.has(change.key) &&
      allEditableShapes(ctx, change.ids)
    );
  },
  execute(ctx, args) {
    const change = readFieldChange(args)!;
    for (const id of change.ids)
      updateElementData(ctx, id, { [change.key]: change.value });
  },
});

/** Size of a shape made by a click without dragging. */
const CLICK_SIZE = 100;
/** A drag shorter than this many screen pixels counts as a click. */
const CLICK_SLOP = 3;

/** The box a drag from `a` to `b` describes; with Shift, a square. */
function dragBox(
  a: Point,
  b: Point,
  square: boolean,
): { x: number; y: number; w: number; h: number } {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (square) w = h = Math.max(w, h);
  return { x: b.x < a.x ? a.x - w : a.x, y: b.y < a.y ? a.y - h : a.y, w, h };
}

function shapeTool(t: ShapeTemplate): ToolDefinition {
  return {
    name: t.kind,
    label: t.label,
    ...(t.shortcut !== undefined ? { shortcuts: [t.shortcut] } : {}),
    quick: true,
    group: "shapes",
    cursor: "crosshair",
    start(session): ToolHandler {
      let start: ToolPointerEvent | null = null;
      let current: ToolPointerEvent | null = null;
      const reset = (): void => {
        start = current = null;
        session.requestOverlay();
      };
      return {
        pointerDown(event) {
          if (event.button !== 0) return;
          start = current = event;
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
          const box =
            moved < CLICK_SLOP
              ? {
                  x: from.world.x - CLICK_SIZE / 2,
                  y: from.world.y - CLICK_SIZE / 2,
                  w: CLICK_SIZE,
                  h: CLICK_SIZE,
                }
              : dragBox(from.world, event.world, event.modifiers.shift);
          session.run(SHAPE_INSERT, { kind: t.kind, ...box });
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
          // The overlay draws in root space; the template draws in its own box.
          const box = dragBox(start.world, current.world, current.modifiers.shift);
          const px = 1 / ctx.scale;
          ctx.withOffset(box.x, box.y, () => {
            const path = ctx.createPath();
            t.outline(path, box.w, box.h, 0);
            ctx.stroke(path, { color: "#2563eb", width: px, dash: [4 * px, 4 * px] });
          });
        },
        stop: reset,
      };
    },
  };
}

export const shapeExtension = defineExtension({
  id: SHAPE_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
  contributes: {
    elementTypes: [shapeType],
    commands: [insertShape, setStyle],
    tools: TEMPLATES.map(shapeTool),
  },
});
