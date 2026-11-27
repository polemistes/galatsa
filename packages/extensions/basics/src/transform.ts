// SPDX-License-Identifier: GPL-3.0-or-later

// Moving, resizing, scaling and rotating elements. Each command writes in one
// transaction, so a drag that ends in one of them is one document update.

import { GROUP_TYPE, type ElementId, type Point } from "@galatsa/core";
import { edit, moveElement, resizeElement, rotateElement } from "@galatsa/core/ydoc";
import {
  applyScale,
  capabilitiesOf,
  defineCommand,
  planScale,
  type CommandContext,
} from "@galatsa/extension-api/editing";
import {
  canTargetAll,
  canTarget,
  isFiniteNumber,
  isId,
  label,
  optionalNumber,
  outermost,
  readIds,
  refuse,
  resolve,
} from "./common.ts";

export interface MoveArgs {
  readonly ids: readonly ElementId[];
  /** Offset in world units. Containers only translate, so it is the same in every space. */
  readonly dx: number;
  readonly dy: number;
}

function readMove(ctx: CommandContext, args: unknown): MoveArgs | undefined {
  const ids = readIds(args);
  const { dx, dy } = (args ?? {}) as Partial<MoveArgs>;
  if (ids === undefined || !isFiniteNumber(dx) || !isFiniteNumber(dy)) return undefined;
  if (dx === 0 && dy === 0) return undefined;
  return canTargetAll(ctx, resolve(ctx), ids) ? { ids, dx, dy } : undefined;
}

/**
 * Moves elements by an offset. Elements inside another moved element move with
 * it and are not moved again. Elements of a missing extension can be moved.
 */
export const move = defineCommand<MoveArgs, void>({
  name: "move",
  label: label("move"),
  undoLabel: label("move.step"),
  quick: true,
  enabled: (ctx, args) => readMove(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readMove(ctx, args) ?? refuse("move");
    const r = resolve(ctx);
    const targets = outermost(r, a.ids).map((id) => ({ id, at: r.localPosition(id) }));
    edit(ctx.doc, () => {
      for (const { id, at } of targets)
        moveElement(ctx.doc, id, at.x + a.dx, at.y + a.dy);
    });
  },
});

export interface ResizeArgs {
  readonly id: ElementId;
  readonly w: number;
  readonly h: number;
  /** New top-left corner in the parent's space (resizing from a left or top handle). */
  readonly x?: number;
  readonly y?: number;
}

function readResize(ctx: CommandContext, args: unknown): ResizeArgs | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const { id, w, h, x, y } = args as Partial<ResizeArgs>;
  if (!isId(id) || !isFiniteNumber(w) || !isFiniteNumber(h) || w < 0 || h < 0)
    return undefined;
  if (!optionalNumber(x) || !optionalNumber(y) || (x === undefined) !== (y === undefined))
    return undefined;
  const r = resolve(ctx);
  // Groups have no size of their own; they are scaled.
  if (r.get(id)?.type === GROUP_TYPE) return undefined;
  if (!canTarget(ctx, r, id, { resize: true })) return undefined;
  return { id, w, h, ...(x !== undefined && y !== undefined ? { x, y } : {}) };
}

/**
 * Sets the size of one element, and its position when it is given. Refused for
 * groups (use scale), for elements whose type forbids resizing, and for
 * elements of a missing extension or a newer layout.
 */
export const resize = defineCommand<ResizeArgs, void>({
  name: "resize",
  label: label("resize"),
  undoLabel: label("resize.step"),
  quick: true,
  enabled: (ctx, args) => readResize(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readResize(ctx, args) ?? refuse("resize");
    edit(ctx.doc, () => {
      if (a.x !== undefined && a.y !== undefined) moveElement(ctx.doc, a.id, a.x, a.y);
      resizeElement(ctx.doc, a.id, a.w, a.h);
    });
  },
});

export interface ScaleArgs {
  readonly ids: readonly ElementId[];
  /** The point that stays where it is, in root space. */
  readonly anchor: Point;
  readonly factor: number;
}

function readScale(ctx: CommandContext, args: unknown): ScaleArgs | undefined {
  const ids = readIds(args);
  const { anchor, factor } = (args ?? {}) as Partial<ScaleArgs>;
  if (ids === undefined || !isFiniteNumber(factor) || factor <= 0 || factor === 1)
    return undefined;
  if (anchor === null || typeof anchor !== "object") return undefined;
  if (!isFiniteNumber(anchor.x) || !isFiniteNumber(anchor.y)) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  // Something must be resizable: scaling only placeholders would just move them.
  if (!outermost(r, ids).some((id) => capabilitiesOf(ctx, id).resize)) return undefined;
  return { ids, anchor: { x: anchor.x, y: anchor.y }, factor };
}

/**
 * Scales elements about a point, keeping proportions, with everything inside
 * groups and frames. Elements that may not be resized (from a missing
 * extension) move with the others and keep their size (docs/adr/0005, 3.7).
 */
export const scale = defineCommand<ScaleArgs, void>({
  name: "scale",
  label: label("scale"),
  undoLabel: label("scale.step"),
  quick: true,
  enabled: (ctx, args) => readScale(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readScale(ctx, args) ?? refuse("scale");
    applyScale(ctx, planScale(ctx, a.ids, a.anchor, a.factor));
  },
});

export interface RotateArgs {
  readonly ids: readonly ElementId[];
  /** The new rotation in radians, clockwise. */
  readonly rot?: number;
  /** Or an angle to add to each element's rotation. */
  readonly by?: number;
}

const TURN = 2 * Math.PI;

function readRotate(ctx: CommandContext, args: unknown): RotateArgs | undefined {
  const ids = readIds(args);
  const { rot, by } = (args ?? {}) as Partial<RotateArgs>;
  if (ids === undefined || (rot === undefined) === (by === undefined)) return undefined;
  if (!optionalNumber(rot) || !optionalNumber(by)) return undefined;
  if (!canTargetAll(ctx, resolve(ctx), ids, { rotate: true })) return undefined;
  return rot !== undefined ? { ids, rot } : { ids, by: by! };
}

/**
 * Rotates each element about the centre of its own box: to `rot`, or by `by`.
 * The stored angle is kept in [0, 2π). Refused for frames and groups, for
 * types that forbid rotating, and for elements of a missing extension.
 */
export const rotate = defineCommand<RotateArgs, void>({
  name: "rotate",
  label: label("rotate"),
  undoLabel: label("rotate.step"),
  quick: true,
  enabled: (ctx, args) => readRotate(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readRotate(ctx, args) ?? refuse("rotate");
    const r = resolve(ctx);
    const turns = a.ids.map((id) => {
      const angle = a.rot ?? (r.get(id)?.rot ?? 0) + a.by!;
      const turned = ((angle % TURN) + TURN) % TURN;
      return { id, rot: turned < TURN ? turned : 0 };
    });
    edit(ctx.doc, () => {
      for (const { id, rot } of turns) rotateElement(ctx.doc, id, rot);
    });
  },
});
