// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-shape: the shape extension with its editing part. Shapes
// are described as data (kind.ts); the kinds are in kinds/. A viewer imports
// "@galatsa/extension-shape/view", which has only the viewing part. See
// docs/adr/0008-shapes.md and README.md.

import type { ElementId, Json } from "@galatsa/core";
import {
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  updateElementData,
  type CommandContext,
  type EditExtension,
  type ElementTypeEditing,
  type FieldChange,
  type FieldDefinition,
} from "@galatsa/extension-api/editing";
import { shapeLabel, type ShapeKind, type ShapeParam } from "./kind.ts";
import { SHAPE_KINDS } from "./kinds/index.ts";
import {
  isValidValue,
  newShapeData,
  STYLE_KEYS,
  type KindTable,
  type ShapeModel,
  type ShapeStyle,
} from "./model.ts";
import { normalizeRotation, shapeTool, type InsertShapeArgs } from "./tool.ts";
import {
  SHAPE_EXTENSION,
  SHAPE_TYPE,
  createShapeView,
  shapeViewParts,
  type ShapeViewParts,
} from "./view.ts";

export * from "./view.ts";
export {
  ANGLE_STEP,
  CLICK_SIZE,
  CLICK_SLOP,
  clickShape,
  dragBox,
  dragLine,
  normalizeRotation,
  type InsertShapeArgs,
} from "./tool.ts";

/** Makes a shape: InsertShapeArgs, with an optional `style` over the defaults. Returns the new id and selects it. */
export const SHAPE_INSERT = `${SHAPE_EXTENSION}/insert`;
/** Changes one data key of shapes: a FieldChange. Every field of the shape type runs it. */
export const SHAPE_SET = `${SHAPE_EXTENSION}/set-style`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Insert arguments, checked: a known kind, a finite box of size 0 or more, a valid style. */
function readInsertArgs(
  table: KindTable,
  args: unknown,
): (InsertShapeArgs & { style: Partial<ShapeStyle> }) | undefined {
  if (!isRecord(args)) return undefined;
  const { kind, x, y, w, h, rot, parent, style } = args;
  if (typeof kind !== "string" || !table.kinds.has(kind)) return undefined;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w < 0 || h < 0)
    return undefined;
  if (rot !== undefined && !finite(rot)) return undefined;
  if (parent !== undefined && parent !== null && typeof parent !== "string")
    return undefined;
  if (style !== undefined && !isRecord(style)) return undefined;
  const checked: Partial<Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(style ?? {})) {
    if (
      !(STYLE_KEYS as readonly string[]).includes(key) ||
      !isValidValue(table, key, value)
    )
      return undefined;
    checked[key] = value;
  }
  return {
    kind,
    x,
    y,
    w,
    h,
    rot: normalizeRotation(rot ?? 0),
    parent: parent ?? null,
    style: checked as Partial<ShapeStyle>,
  };
}

/** Field arguments, checked. */
function readFieldChange(args: unknown): FieldChange | undefined {
  if (!isRecord(args)) return undefined;
  const { ids, key, value } = args;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  if (typeof key !== "string" || value === undefined) return undefined;
  return { ids, key, value: value as Json };
}

function allEditableShapes(ctx: CommandContext, ids: readonly ElementId[]): boolean {
  try {
    return (
      ids.length > 0 &&
      ids.every(
        (id) =>
          elementFacts(ctx, id).type === SHAPE_TYPE &&
          capabilitiesOf(ctx, id).editContent,
      )
    );
  } catch {
    // An id that is not an element.
    return false;
  }
}

/** The field of a kind parameter, for the kinds that list it. */
function paramField(table: KindTable, param: ShapeParam): FieldDefinition<ShapeModel> {
  const users = table.paramKinds.get(param.key)!;
  const common = {
    key: param.key,
    label: param.label,
    quick: param.quick ?? false,
    get: (m: ShapeModel) => m.params[param.key] ?? param.default,
    applies: (m: ShapeModel) => users.has(m.kind),
    command: SHAPE_SET,
  };
  switch (param.type) {
    case "number":
      return {
        ...common,
        control: {
          kind: "number",
          min: param.min,
          max: param.max,
          ...(param.step !== undefined ? { step: param.step } : {}),
        },
      };
    case "choice":
      return {
        ...common,
        control: {
          kind: "select",
          options: param.options.map((o) => ({ value: o.value, label: o.label })),
        },
      };
    case "toggle":
      return { ...common, control: { kind: "toggle" } };
  }
}

/** The properties of the shape type: the style, the kind, and each kind parameter once. */
function shapeFields(table: KindTable): FieldDefinition<ShapeModel>[] {
  const kindOf = (m: ShapeModel): ShapeKind | undefined => table.kinds.get(m.kind);
  return [
    {
      key: "fill",
      label: shapeLabel("fill"),
      quick: true,
      control: { kind: "color", allowNone: true },
      get: (m) => m.fill,
      applies: (m) => kindOf(m)?.closed === true,
      command: SHAPE_SET,
    },
    {
      key: "stroke",
      label: shapeLabel("stroke"),
      quick: true,
      control: { kind: "color", allowNone: true },
      get: (m) => m.stroke,
      command: SHAPE_SET,
    },
    {
      key: "strokeWidth",
      label: shapeLabel("stroke-width"),
      quick: true,
      control: { kind: "number", min: 0, max: 200, step: 1 },
      get: (m) => m.strokeWidth,
      command: SHAPE_SET,
    },
    {
      key: "cornerRadius",
      label: shapeLabel("corner-radius"),
      control: { kind: "number", min: 0, max: 1000, step: 1 },
      get: (m) => m.cornerRadius,
      applies: (m) => kindOf(m)?.corners === true,
      command: SHAPE_SET,
    },
    {
      key: "opacity",
      label: shapeLabel("opacity"),
      control: { kind: "number", min: 0, max: 1, step: 0.05 },
      get: (m) => m.opacity,
      command: SHAPE_SET,
    },
    {
      key: "kind",
      label: shapeLabel("kind"),
      control: {
        kind: "select",
        options: [...table.kinds.values()].map((k) => ({
          value: k.kind,
          label: k.label,
        })),
      },
      get: (m) => m.kind,
      // A kind from a newer version cannot be changed to another here.
      applies: (m) => kindOf(m) !== undefined,
      command: SHAPE_SET,
    },
    ...[...table.params.values()].map((param) => paramField(table, param)),
  ];
}

/** The shape extension, both parts, for a list of kinds. */
export interface ShapeExtensionParts extends ShapeViewParts {
  readonly editing: ElementTypeEditing<ShapeModel>;
  readonly editExtension: EditExtension;
}

/**
 * Builds the shape extension for `kinds`. The program uses it once, with
 * SHAPE_KINDS (`shapeExtension`); tests use it to show that a kind written in
 * a file of its own needs no change to the framework.
 */
export function createShapeExtension(
  kinds: readonly ShapeKind[],
  view: ShapeViewParts = createShapeView(kinds),
): ShapeExtensionParts {
  const parts = view;
  const { table } = parts;
  const editing = defineElementEditing(parts.view, { properties: shapeFields(table) });

  const insert = defineCommand<unknown, ElementId>({
    name: "insert",
    label: shapeLabel("insert"),
    undoLabel: shapeLabel("insert.step"),
    quick: true,
    enabled: (_ctx, args) => readInsertArgs(table, args) !== undefined,
    execute(ctx, args) {
      const a = readInsertArgs(table, args);
      if (a === undefined) throw new Error("Invalid shape insert arguments");
      const id = insertElement(ctx, {
        type: SHAPE_TYPE,
        parent: a.parent ?? null,
        x: a.x,
        y: a.y,
        size: { w: a.w, h: a.h },
        rot: a.rot ?? 0,
        data: newShapeData(table, a.kind, a.style),
      });
      ctx.services.selection.set([id]);
      return id;
    },
  });

  const set = defineCommand<unknown, void>({
    name: "set-style",
    label: shapeLabel("set-style"),
    undoLabel: shapeLabel("set-style.step"),
    quick: true,
    enabled(ctx, args) {
      const change = readFieldChange(args);
      return (
        change !== undefined &&
        isValidValue(table, change.key, change.value) &&
        allEditableShapes(ctx, change.ids)
      );
    },
    execute(ctx, args) {
      const change = readFieldChange(args);
      if (
        change === undefined ||
        !isValidValue(table, change.key, change.value) ||
        !allEditableShapes(ctx, change.ids)
      )
        throw new Error("Invalid shape change");
      for (const id of change.ids)
        updateElementData(ctx, id, { [change.key]: change.value });
    },
  });

  const editExtension = defineEditExtension({
    view: parts.extension,
    contributes: {
      elementTypes: [editing],
      commands: [insert, set],
      tools: kinds.map((kind) => shapeTool(table, SHAPE_TYPE, kind, SHAPE_INSERT)),
    },
  });
  return { ...parts, editing, editExtension };
}

const parts = createShapeExtension(SHAPE_KINDS, shapeViewParts);

/** The editing part of the shape type, with the program's kinds. */
export const shapeEditing: ElementTypeEditing<ShapeModel> = parts.editing;
/** The shape extension, with the program's kinds and their tools. */
export const shapeExtension: EditExtension = parts.editExtension;
