// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-shape: the shape extension with its editing part. Shapes
// are described as data (kind.ts); the kinds are in kinds/. A viewer imports
// "@galatsa/extension-shape/view", which has only the viewing part. See
// docs/adr/0010-shapes.md and README.md.

import { Resolver, type ElementData, type ElementId, type Json } from "@galatsa/core";
import { dataMap, edit, moveElement, resizeElement, yLookup } from "@galatsa/core/ydoc";
import { canTarget, isOpenContainer } from "@galatsa/extension-basics";
import {
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  readData,
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
  normalizeValue,
  readShape,
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
  STROKE_PIXELS,
  strokeWidthAt,
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

/**
 * True if every id is a shape the user may change: one they see, not locked
 * and not in a locked container (the rules of the basic commands), whose type
 * is loaded and not older than it.
 */
function allEditableShapes(
  ctx: CommandContext,
  r: Resolver,
  ids: readonly ElementId[],
): boolean {
  try {
    return (
      ids.length > 0 &&
      ids.every(
        (id) =>
          canTarget(ctx, r, id) &&
          elementFacts(ctx, id).type === SHAPE_TYPE &&
          capabilitiesOf(ctx, id).editContent,
      )
    );
  } catch {
    // An id that is not an element.
    return false;
  }
}

/** The document as resolved now. */
function resolve(ctx: Pick<CommandContext, "doc">): Resolver {
  return new Resolver(yLookup(ctx.doc));
}

/**
 * The data writes of a change, for one shape: the key itself, and for a
 * change of kind the new kind's parameters with their defaults (the old
 * kind's are removed, `removed`). Undefined if the change is not possible:
 * a change of kind from a kind this version does not know.
 */
function writesFor(
  table: KindTable,
  data: ElementData,
  change: FieldChange,
): { writes: ElementData; removed: string[] } | undefined {
  const value = normalizeValue(change.value);
  if (change.key !== "kind") return { writes: { [change.key]: value }, removed: [] };
  const from = table.kinds.get(readShape(table, data, () => {}).kind);
  const to = table.kinds.get(value as string);
  if (from === undefined || to === undefined) return undefined;
  const writes: Record<string, Json> = { kind: to.kind };
  for (const param of to.params ?? [])
    writes[param.key] =
      from.params?.includes(param) && Object.hasOwn(data, param.key)
        ? (data[param.key] as Json)
        : param.default;
  const removed = (from.params ?? [])
    .map((p) => p.key)
    .filter((key) => !Object.hasOwn(writes, key) && Object.hasOwn(data, key));
  return { writes: writes as ElementData, removed };
}

/** True if the data with `writes` reads without a report: what `updateElementData` checks. */
function readsCleanly(table: KindTable, data: ElementData, writes: ElementData): boolean {
  let clean = true;
  readShape(table, { ...data, ...writes }, () => (clean = false));
  return clean;
}

/**
 * The box a shape gets when its kind changes, keeping its centre and
 * rotation: a kind drawn as a line gets a box 0 high; a box 0 high (a line)
 * that becomes a kind drawn as a box gets a square as wide as the line.
 * Undefined when the box stays as it is.
 */
function boxFor(
  r: Resolver,
  id: ElementId,
  to: ShapeKind,
): { x: number; y: number; w: number; h: number } | undefined {
  const size = r.get(id)?.size;
  if (size === undefined) return undefined;
  const { w, h } = size;
  let next: number;
  if (to.drawing === "line") next = 0;
  else if (h === 0) next = w;
  else return undefined;
  if (next === h) return undefined;
  const at = r.localPosition(id);
  return { x: at.x, y: at.y + (h - next) / 2, w, h: next };
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
    enabled: (ctx, args) => {
      const a = readInsertArgs(table, args);
      return a !== undefined && isOpenContainer(resolve(ctx), a.parent ?? null);
    },
    execute(ctx, args) {
      const a = readInsertArgs(table, args);
      // Into the root or a container the user sees that is not locked.
      if (a === undefined || !isOpenContainer(resolve(ctx), a.parent ?? null))
        throw new Error("Invalid shape insert arguments");
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

  /**
   * What a change does to each shape, checked as a whole: every shape may be
   * changed, the value is one this version writes, and each shape's data
   * with the change reads cleanly (as `updateElementData` will check).
   */
  const plan = (ctx: CommandContext, args: unknown) => {
    const change = readFieldChange(args);
    if (change === undefined || !isValidValue(table, change.key, change.value))
      return undefined;
    const r = resolve(ctx);
    if (!allEditableShapes(ctx, r, change.ids)) return undefined;
    const steps = [];
    for (const id of new Set(change.ids)) {
      const data = readData(ctx, id);
      const planned = writesFor(table, data, change);
      if (planned === undefined || !readsCleanly(table, data, planned.writes))
        return undefined;
      const box =
        change.key === "kind"
          ? boxFor(r, id, table.kinds.get(change.value as string)!)
          : undefined;
      steps.push({ id, ...planned, box });
    }
    return steps;
  };

  const set = defineCommand<unknown, void>({
    name: "set-style",
    label: shapeLabel("set-style"),
    undoLabel: shapeLabel("set-style.step"),
    quick: true,
    enabled: (ctx, args) => plan(ctx, args) !== undefined,
    execute(ctx, args) {
      const steps = plan(ctx, args);
      if (steps === undefined) throw new Error("Invalid shape change");
      for (const { id, writes, removed, box } of steps) {
        updateElementData(ctx, id, writes);
        if (removed.length > 0)
          edit(ctx.doc, () => {
            for (const key of removed) dataMap(ctx.doc, id).delete(key);
          });
        if (box !== undefined) {
          resizeElement(ctx.doc, id, box.w, box.h);
          moveElement(ctx.doc, id, box.x, box.y);
        }
      }
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
