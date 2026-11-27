// SPDX-License-Identifier: GPL-3.0-or-later

// Commands that change where elements are in the tree and the stacking order,
// whether they can be changed, and whether they are there at all: moving into
// another container, z-order, grouping, locking and deleting.

import { GROUP_TYPE, type ElementId, type Resolver } from "@galatsa/core";
import {
  bringForward,
  bringToFront,
  deleteElements,
  dissolve,
  edit,
  group as groupElements,
  reparent as reparentElement,
  sendBackward,
  sendToBack,
  setLocked,
  slotsOf,
} from "@galatsa/core/ydoc";
import {
  defineCommand,
  type CommandContext,
  type CommandDefinition,
} from "@galatsa/extension-api/editing";
import {
  backToFront,
  canTarget,
  canTargetAll,
  isId,
  isOpenContainer,
  label,
  outermost,
  readIds,
  refuse,
  resolve,
} from "./common.ts";

/** Arguments of the commands that act on a list of elements. */
export interface IdsArgs {
  readonly ids: readonly ElementId[];
}

// ---------------------------------------------------------------------------
// Moving into another container
// ---------------------------------------------------------------------------

export interface ReparentArgs {
  readonly ids: readonly ElementId[];
  /** The frame or group to move them into; null for the canvas root. */
  readonly target: ElementId | null;
  /** Stacking index of the first among the target's slots; default: in front. */
  readonly index?: number;
}

interface ReparentPlan {
  readonly ids: ElementId[];
  readonly target: ElementId | null;
  readonly index?: number;
}

function planReparent(ctx: CommandContext, args: unknown): ReparentPlan | undefined {
  const ids = readIds(args);
  const { target, index } = (args ?? {}) as Partial<ReparentArgs>;
  if (ids === undefined || (target !== null && !isId(target))) return undefined;
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
    return undefined;
  const r = resolve(ctx);
  if (!isOpenContainer(r, target) || !canTargetAll(ctx, r, ids)) return undefined;
  // Nothing can go into itself or into something inside it.
  if (target !== null && ids.some((id) => r.isWithin(target, id))) return undefined;
  // Elements inside another moved element go with it; those already there stay.
  const moving = backToFront(r, outermost(r, ids)).filter(
    (id) => r.parentOf(id) !== target,
  );
  if (moving.length === 0) return undefined;
  return { ids: moving, target, ...(index !== undefined ? { index } : {}) };
}

/**
 * Moves elements into a frame or group, or out to the root, without moving
 * them on the canvas (docs/adr/0001, section 5.3). They keep their stacking
 * order among each other and go in front, or from `index` on.
 */
export const reparent = defineCommand<ReparentArgs, void>({
  name: "reparent",
  label: label("reparent"),
  undoLabel: label("reparent.step"),
  quick: true,
  enabled: (ctx, args) => planReparent(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planReparent(ctx, args) ?? refuse("reparent");
    plan.ids.forEach((id, i) =>
      reparentElement(
        ctx.doc,
        id,
        plan.target,
        plan.index !== undefined ? { index: plan.index + i } : {},
      ),
    );
  },
});

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

/** The slots of the container an element is seen in, back to front, and the element's slot. */
function slotsAround(r: Resolver, id: ElementId) {
  const logical = r.logicalParentOf(id);
  const slots = slotsOf(r, logical).map((s) => s.id);
  const holder = r.slotIn(id, logical) ?? id;
  return { slots, at: slots.indexOf(holder) };
}

type Direction = "front" | "back" | "forward" | "backward";

/**
 * Whether restacking would change anything: some chosen slot can pass a slot
 * that is not chosen, towards the front or the back.
 */
function wouldRestack(r: Resolver, ids: readonly ElementId[], dir: Direction): boolean {
  const toFront = dir === "front" || dir === "forward";
  const chosen = new Set<ElementId>();
  for (const id of ids) {
    const { slots, at } = slotsAround(r, id);
    if (at >= 0) chosen.add(slots[at]!);
  }
  return ids.some((id) => {
    const { slots, at } = slotsAround(r, id);
    if (at < 0) return false;
    if (dir === "forward" || dir === "backward") {
      const next = slots[toFront ? at + 1 : at - 1];
      return next !== undefined && !chosen.has(next);
    }
    // To the front or back: some slot on that side is not chosen.
    const side = toFront ? slots.slice(at + 1) : slots.slice(0, at);
    return side.some((s) => !chosen.has(s));
  });
}

function readRestack(
  ctx: CommandContext,
  args: unknown,
  dir: Direction,
): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids) || !wouldRestack(r, ids, dir)) return undefined;
  return ids;
}

/**
 * The four z-order commands. Several elements keep their order among each
 * other. One step moves an element past the slot directly in front of (or
 * behind) it; a run of chosen elements moves together, and one that is
 * already at the end stays (docs/adr/0001, section 4.2).
 */
function restackCommand(
  name: "bring-to-front" | "send-to-back" | "bring-forward" | "send-backward",
  dir: Direction,
  shortcuts: readonly string[],
  quick: boolean,
): CommandDefinition<IdsArgs, void> {
  return defineCommand<IdsArgs, void>({
    name,
    label: label(name),
    undoLabel: label(`${name}.step`),
    shortcuts,
    quick,
    enabled: (ctx, args) => readRestack(ctx, args, dir) !== undefined,
    execute(ctx, args) {
      const ids = readRestack(ctx, args, dir) ?? refuse(name);
      const order = backToFront(resolve(ctx), ids);
      // To the front: back to front, so the frontmost ends in front. One step
      // forward: front to back, so a run of chosen elements opens a gap first.
      const sequence = dir === "front" || dir === "backward" ? order : order.reverse();
      const chosen = new Set(ids);
      for (const id of sequence) {
        if (dir === "front") bringToFront(ctx.doc, id);
        else if (dir === "back") sendToBack(ctx.doc, id);
        else {
          const r = resolve(ctx);
          const { slots, at } = slotsAround(r, id);
          const next = slots[dir === "forward" ? at + 1 : at - 1];
          // Blocked at the end, or by a chosen neighbour that could not move.
          if (next === undefined || chosen.has(next)) continue;
          if (r.isContainer(next) && ids.some((other) => r.isWithin(other, next)))
            continue;
          if (dir === "forward") bringForward(ctx.doc, id);
          else sendBackward(ctx.doc, id);
        }
      }
    },
  });
}

// Shortcuts (docs/adr/0014-stacking-and-frames.md): the brackets, as many
// drawing programs have them, and the arrow keys, which are in the same place
// on every keyboard layout; on a Norwegian keyboard the brackets are Ctrl with
// the two keys right of P, or Ctrl with AltGr+8 and AltGr+9 on Linux.
export const bringToFrontCommand = restackCommand(
  "bring-to-front",
  "front",
  ["Mod+Shift+]", "Mod+Shift+ArrowUp"],
  true,
);
export const sendToBackCommand = restackCommand(
  "send-to-back",
  "back",
  ["Mod+Shift+[", "Mod+Shift+ArrowDown"],
  true,
);
export const bringForwardCommand = restackCommand(
  "bring-forward",
  "forward",
  ["Mod+]", "Mod+ArrowUp"],
  true,
);
export const sendBackwardCommand = restackCommand(
  "send-backward",
  "backward",
  ["Mod+[", "Mod+ArrowDown"],
  true,
);

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function readGroup(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  // Members must be seen in the same container (docs/adr/0001, section 5.4).
  const parent = r.logicalParentOf(ids[0]!);
  if (ids.some((id) => r.logicalParentOf(id) !== parent)) return undefined;
  return ids;
}

/** Groups elements seen in the same container; selects the new group and returns its id. */
export const group = defineCommand<IdsArgs, ElementId>({
  name: "group",
  label: label("group"),
  undoLabel: label("group.step"),
  shortcuts: ["Mod+G"],
  quick: true,
  enabled: (ctx, args) => readGroup(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readGroup(ctx, args) ?? refuse("group");
    const id = groupElements(ctx.doc, ids);
    ctx.services.selection.set([id]);
    return id;
  },
});

function readUngroup(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  return ids.every((id) => r.get(id)?.type === GROUP_TYPE) ? ids : undefined;
}

/**
 * Ungroups: the groups are dissolved and their members stay where they are, on
 * the canvas and in the stacking order (docs/adr/0001, section 5.5). Selects
 * the former members.
 */
export const ungroup = defineCommand<IdsArgs, void>({
  name: "ungroup",
  label: label("ungroup"),
  undoLabel: label("ungroup.step"),
  shortcuts: ["Mod+Shift+G"],
  quick: true,
  enabled: (ctx, args) => readUngroup(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readUngroup(ctx, args) ?? refuse("ungroup");
    for (const id of ids) dissolve(ctx.doc, id);
    const r = resolve(ctx);
    ctx.services.selection.set(ids.flatMap((id) => r.logicalChildren(id)));
  },
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function readLock(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  return canTargetAll(ctx, resolve(ctx), ids) ? ids : undefined;
}

/** Locks elements: they cannot be selected by clicking or changed until unlocked. */
export const lock = defineCommand<IdsArgs, void>({
  name: "lock",
  label: label("lock"),
  undoLabel: label("lock.step"),
  shortcuts: ["Mod+Shift+L"],
  enabled: (ctx, args) => readLock(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readLock(ctx, args) ?? refuse("lock");
    edit(ctx.doc, () => {
      for (const id of ids) setLocked(ctx.doc, id, true);
    });
    const locked = new Set(ids);
    ctx.services.selection.set(
      ctx.services.selection.get().filter((id) => !locked.has(id)),
    );
  },
});

function readUnlock(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  // Each must be locked itself, in a container that is not locked.
  const ok = ids.every((id) => {
    const parent = r.logicalParentOf(id);
    return (
      canTarget(ctx, r, id, { locked: true }) &&
      r.get(id)?.locked === true &&
      (parent === null || !r.isLocked(parent))
    );
  });
  return ok ? ids : undefined;
}

/** Unlocks elements that are locked themselves (not only by a locked container). */
export const unlock = defineCommand<IdsArgs, void>({
  name: "unlock",
  label: label("unlock"),
  undoLabel: label("unlock.step"),
  enabled: (ctx, args) => readUnlock(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readUnlock(ctx, args) ?? refuse("unlock");
    edit(ctx.doc, () => {
      for (const id of ids) setLocked(ctx.doc, id, false);
    });
  },
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

function readDelete(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  return canTargetAll(ctx, r, ids) ? outermost(r, ids) : undefined;
}

/**
 * Deletes elements, with everything in them. The delete hides only what this
 * user sees; what someone else adds or changes meanwhile survives
 * (docs/adr/0001, section 5.5). Elements of a missing extension can be deleted.
 */
export const deleteCommand = defineCommand<IdsArgs, void>({
  name: "delete",
  label: label("delete"),
  undoLabel: label("delete.step"),
  shortcuts: ["Delete", "Backspace"],
  quick: true,
  enabled: (ctx, args) => readDelete(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readDelete(ctx, args) ?? refuse("delete");
    deleteElements(ctx.doc, ids);
    const r = resolve(ctx);
    ctx.services.selection.set(
      ctx.services.selection.get().filter((id) => !r.isGone(id)),
    );
  },
});
