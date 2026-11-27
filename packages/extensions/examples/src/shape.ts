// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the shape extension, editing part: style properties, and one
// drawing tool per template that shows a preview while the user drags and
// makes the shape with one command at the end.

import type { ElementId, Point } from "@galatsa/core";
import {
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  updateElementData,
  type CommandContext,
  type ToolDefinition,
  type ToolHandler,
  type ToolPointerEvent,
} from "@galatsa/extension-api/editing";
import { label, readFieldChange } from "./common.ts";
import {
  KINDS,
  SHAPE_EXTENSION,
  SHAPE_TYPE,
  TEMPLATES,
  shapeView,
  shapeViewExtension,
  type ShapeTemplate,
} from "./shape-view.ts";

export * from "./shape-view.ts";

export const SHAPE_INSERT = `${SHAPE_EXTENSION}/insert`;
export const SHAPE_SET_STYLE = `${SHAPE_EXTENSION}/set-style`;

export const shapeEditing = defineElementEditing(shapeView, {
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

export const shapeExtension = defineEditExtension({
  view: shapeViewExtension,
  contributes: {
    elementTypes: [shapeEditing],
    commands: [insertShape, setStyle],
    tools: TEMPLATES.map(shapeTool),
  },
});
