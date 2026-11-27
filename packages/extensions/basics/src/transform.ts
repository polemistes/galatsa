// SPDX-License-Identifier: GPL-3.0-or-later

// Moving, resizing, scaling and rotating elements. Each command writes in one
// transaction, so a drag that ends in one of them is one document update.

import { FRAME_TYPE, GROUP_TYPE, type ElementId, type Point } from "@galatsa/core";
import {
  edit,
  moveElement,
  reparent as reparentElement,
  resizeElement,
  rotateElement,
} from "@galatsa/core/ydoc";
import {
  applyScale,
  capabilitiesOf,
  defineCommand,
  planScale,
  LockedError,
  type CommandContext,
} from "@galatsa/extension-api/editing";
import {
  backToFront,
  canTargetAll,
  canTarget,
  isOpenContainer,
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
  /**
   * A frame or group to move them into first, or null for the canvas: a drag
   * that ends in another container (docs/adr/0001, section 5.3). Those already
   * seen there only move. Absent: they stay in their containers.
   */
  readonly target?: ElementId | null;
}

interface MovePlan {
  readonly ids: ElementId[];
  readonly dx: number;
  readonly dy: number;
  /** The outermost moved elements that change container, back to front. */
  readonly into: ElementId[];
  readonly target: ElementId | null;
}

function readMove(ctx: CommandContext, args: unknown): MovePlan | undefined {
  const ids = readIds(args);
  const { dx, dy, target } = (args ?? {}) as Partial<MoveArgs>;
  if (ids === undefined || !isFiniteNumber(dx) || !isFiniteNumber(dy)) return undefined;
  if (target !== undefined && target !== null && !isId(target)) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  let into: ElementId[] = [];
  if (target !== undefined) {
    if (!isOpenContainer(r, target)) return undefined;
    // Nothing goes into itself or into something inside it.
    if (target !== null && ids.some((id) => r.isWithin(target, id))) return undefined;
    into = backToFront(
      r,
      outermost(r, ids).filter((id) => r.logicalParentOf(id) !== target),
    );
  }
  if (dx === 0 && dy === 0 && into.length === 0) return undefined;
  return { ids, dx, dy, into, target: target ?? null };
}

/**
 * Moves elements by an offset, and into another container first when a
 * target is given (a drag into or out of a frame); one undo step. Elements
 * inside another moved element move with it and are not moved again.
 * Elements of a missing extension can be moved.
 */
export const move = defineCommand<MoveArgs, void>({
  name: "move",
  label: label("move"),
  undoLabel: label("move.step"),
  quick: true,
  enabled: (ctx, args) => readMove(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readMove(ctx, args) ?? refuse("move");
    // A change of container keeps the place on the canvas; the move then
    // writes positions in the new container's space (0001, section 5.3).
    // Reparenting is one transaction per element, as it may re-key a list.
    for (const id of a.into) reparentElement(ctx.doc, id, a.target);
    if (a.dx === 0 && a.dy === 0) return;
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
  /**
   * New top-left corner (resizing from a left or top handle), in the space of
   * the container the user sees the element in: the nearest container that is
   * not gone, or the root. (An element of a dissolved group is stored in the
   * group's space; the command converts.)
   */
  readonly x?: number;
  readonly y?: number;
}

interface ResizePlan {
  readonly id: ElementId;
  readonly w: number;
  readonly h: number;
  /** The new corner in the element's own (effective) parent space. */
  readonly at?: Point;
}

function readResize(ctx: CommandContext, args: unknown): ResizePlan | undefined {
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
  if (x === undefined || y === undefined) return { id, w, h };
  const d = r.offset(r.logicalParentOf(id), r.parentOf(id));
  return { id, w, h, at: { x: x + d.x, y: y + d.y } };
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
    // What is in a frame is placed in the frame's space, whose origin is the
    // frame's corner: when the corner moves (a left or top handle), what is
    // inside is moved back by as much, so it stays where it is on the canvas
    // (docs/adr/0014). Every child in the effective tree, gone ones too, so
    // that what comes back with an undo of a delete is in place as well.
    const r = resolve(ctx);
    const kept: { id: ElementId; x: number; y: number }[] = [];
    if (a.at !== undefined && r.get(a.id)?.type === FRAME_TYPE) {
      const was = r.localPosition(a.id);
      const dx = a.at.x - was.x;
      const dy = a.at.y - was.y;
      if (dx !== 0 || dy !== 0)
        for (const child of r.children(a.id)) {
          const at = r.localPosition(child);
          kept.push({ id: child, x: at.x - dx, y: at.y - dy });
        }
    }
    edit(ctx.doc, () => {
      if (a.at !== undefined) moveElement(ctx.doc, a.id, a.at.x, a.at.y);
      resizeElement(ctx.doc, a.id, a.w, a.h);
      for (const child of kept) moveElement(ctx.doc, child.id, child.x, child.y);
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
  const plan = { ids, anchor: { x: anchor.x, y: anchor.y }, factor };
  try {
    // Refused if it would change a locked element inside a group or frame.
    planScale(ctx, ids, plan.anchor, factor);
  } catch (error) {
    if (error instanceof LockedError) return undefined;
    throw error;
  }
  return plan;
}

/**
 * Scales elements about a point, keeping proportions, with everything inside
 * groups and frames. Elements that may not be resized (from a missing
 * extension) move with the others and keep their size (docs/adr/0005, 3.7).
 * Refused if anything it would change is locked.
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
  /**
   * With `by`: a point in root space the elements turn about together (the
   * centre of a selection), so each element's centre moves around it as well.
   * Without it, each element turns about its own centre.
   */
  readonly about?: Point;
}

const TURN = 2 * Math.PI;

interface RotatePlan {
  readonly ids: readonly ElementId[];
  readonly rot?: number;
  readonly by?: number;
  readonly about?: Point;
}

function readRotate(ctx: CommandContext, args: unknown): RotatePlan | undefined {
  const ids = readIds(args);
  const { rot, by, about } = (args ?? {}) as Partial<RotateArgs>;
  if (ids === undefined || (rot === undefined) === (by === undefined)) return undefined;
  if (!optionalNumber(rot) || !optionalNumber(by)) return undefined;
  if (about !== undefined) {
    if (by === undefined || about === null || typeof about !== "object") return undefined;
    if (!isFiniteNumber(about.x) || !isFiniteNumber(about.y)) return undefined;
  }
  if (!canTargetAll(ctx, resolve(ctx), ids, { rotate: true })) return undefined;
  if (rot !== undefined) return { ids, rot };
  return about === undefined
    ? { ids, by: by! }
    : { ids, by: by!, about: { x: about.x, y: about.y } };
}

/**
 * Rotates each element about the centre of its own box: to `rot`, or by `by`;
 * with `about`, by `by` about that point, so the elements turn together. The
 * stored angle is kept in [0, 2π). Refused for frames and groups, for types
 * that forbid rotating, and for elements of a missing extension. One
 * transaction.
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
    const cos = Math.cos(a.by ?? 0);
    const sin = Math.sin(a.by ?? 0);
    // An element inside another one being turned keeps its own place in the
    // container (containers only translate, and groups and frames cannot be
    // turned), so each id is turned on its own.
    const turns = a.ids.map((id) => {
      const angle = a.rot ?? (r.get(id)?.rot ?? 0) + a.by!;
      const turned = ((angle % TURN) + TURN) % TURN;
      let at: Point | undefined;
      if (a.about !== undefined) {
        const size = r.get(id)?.size ?? { w: 0, h: 0 };
        const origin = r.worldOrigin(id);
        const cx = origin.x + size.w / 2 - a.about.x;
        const cy = origin.y + size.h / 2 - a.about.y;
        // The centre turned about the point; the same shift in every space.
        const dx = a.about.x + cx * cos - cy * sin - (origin.x + size.w / 2);
        const dy = a.about.y + cx * sin + cy * cos - (origin.y + size.h / 2);
        const local = r.localPosition(id);
        at = { x: local.x + dx, y: local.y + dy };
      }
      return { id, rot: turned < TURN ? turned : 0, at };
    });
    edit(ctx.doc, () => {
      for (const { id, rot, at } of turns) {
        if (at !== undefined) moveElement(ctx.doc, id, at.x, at.y);
        rotateElement(ctx.doc, id, rot);
      }
    });
  },
});
