// SPDX-License-Identifier: GPL-3.0-or-later

// Frames as named containers (docs/adr/0014-stacking-and-frames.md): putting a
// frame around elements (or drawing one), removing a frame but keeping what is
// in it, naming elements, and moving elements into and out of frames. A frame
// is a core element type (docs/adr/0001, section 5.2): what is inside it
// follows it when it moves, and z-order applies within it.

import {
  FRAME_TYPE,
  Problems,
  envelopeField,
  type ElementId,
  type Point,
  type Rect,
  Resolver,
} from "@galatsa/core";
import {
  addElement,
  dissolve,
  edit,
  reparent as reparentElement,
  renameElement,
  roots,
  slotsOf,
  yLookup,
} from "@galatsa/core/ydoc";
import { defineCommand, type CommandContext } from "@galatsa/extension-api/editing";
import type * as Y from "yjs";
import {
  backToFront,
  canTarget,
  canTargetAll,
  isFiniteNumber,
  isId,
  isOpenContainer,
  label,
  outermost,
  readIds,
  refuse,
  resolve,
} from "./common.ts";

/** The margin around elements a frame is put around, as a share of their larger side. */
export const FRAME_PADDING = 0.05;
/** The longest name, in UTF-16 code units. */
export const MAX_NAME_LENGTH = 200;

/** Half of a surrogate pair without the other half: not a well-formed string. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// Finding frames
// ---------------------------------------------------------------------------

/**
 * An element's name as the user gave it ("" for none, or for no such
 * element), read with the document's grammar.
 */
export function elementName(doc: Y.Doc, id: ElementId): string {
  const record = roots(doc).elements.get(id);
  if (record === undefined || typeof record.get !== "function") return "";
  return envelopeField.name(record.get("name"), new Problems(0));
}

/** Whether an element is a frame (seen or not). */
export function isFrame(r: Resolver, id: ElementId | null): id is ElementId {
  return id !== null && r.get(id)?.type === FRAME_TYPE;
}

type YRecord = { get?(key: string): unknown } | undefined;

/**
 * The frames of a document, seen or not, found by the type key of each
 * record alone: much cheaper than resolving every element.
 */
export function frameIds(doc: Y.Doc): ElementId[] {
  const elements = roots(doc).elements;
  const out: ElementId[] = [];
  for (const [id, record] of elements.entries()) {
    const r = record as YRecord;
    if (typeof r?.get === "function" && r.get("type") === FRAME_TYPE) out.push(id);
  }
  return out;
}

/** Whether a frame draws its contents only inside its box (`data.clip`). */
function clips(doc: Y.Doc, id: ElementId): boolean {
  const record = roots(doc).elements.get(id) as YRecord;
  const data = typeof record?.get === "function" ? record.get("data") : undefined;
  if (data === null || typeof data !== "object") return false;
  const clip =
    typeof (data as YRecord)?.get === "function"
      ? (data as { get(key: string): unknown }).get("clip")
      : (data as { clip?: unknown }).clip;
  return clip === true;
}

/** A frame elements can be put into, as the user sees it. */
export interface OpenFrame {
  readonly id: ElementId;
  /** Its box in root space. */
  readonly box: Rect;
  /** Where it can be seen: inside every clipping frame around it (root space); null for everywhere. */
  readonly visible: Rect | null;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  };
}

function holds(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Compares two drawing paths: each is the list of (order key, id) of the
 * element and every container above it in the effective tree, from the root
 * down. Siblings sort by key and id, and a container before what is in it:
 * the order the renderer draws in (docs/adr/0001, section 4.2).
 */
function comparePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** The drawing path of an element (see comparePaths). */
export function drawingPath(r: Resolver, id: ElementId): string[] {
  const path: string[] = [];
  for (let at: ElementId | null = id; at !== null; at = r.parentOf(at)) {
    path.unshift(r.get(at)?.order ?? "", at);
    if (path.length > 2 * 4096) break; // a cycle the resolver would have broken
  }
  return path;
}

/**
 * The frames among `ids` the user can put elements into (seen and not
 * locked, neither among `exclude` nor inside one of them), in drawing order,
 * back to front, with their boxes in root space.
 */
export function openFrames(
  doc: Y.Doc,
  r: Resolver,
  ids: readonly ElementId[],
  exclude: readonly ElementId[] = [],
): OpenFrame[] {
  const skip = (id: ElementId): boolean => exclude.some((e) => r.isWithin(id, e));
  const out: { frame: OpenFrame; path: string[] }[] = [];
  for (const id of ids) {
    const size = r.get(id)?.size;
    if (!isFrame(r, id) || size === undefined) continue;
    if (r.isGone(id) || r.isLocked(id) || skip(id)) continue;
    const at = r.worldOrigin(id);
    let visible: Rect | null = null;
    for (let p = r.parentOf(id); p !== null; p = r.parentOf(p)) {
      if (!isFrame(r, p) || r.isGone(p) || !clips(doc, p)) continue;
      const s = r.get(p)!.size;
      if (s === undefined) continue;
      const o = r.worldOrigin(p);
      const box = { x: o.x, y: o.y, w: s.w, h: s.h };
      visible = visible === null ? box : intersect(visible, box);
    }
    const box = { x: at.x, y: at.y, w: size.w, h: size.h };
    out.push({ frame: { id, box, visible }, path: drawingPath(r, id) });
  }
  out.sort((a, b) => comparePaths(a.path, b.path));
  return out.map((o) => o.frame);
}

/**
 * The frame on top at a point (root space): the frontmost in drawing order
 * whose box holds the point where it can be seen, or null for the canvas. A
 * frame inside another one is found also where it reaches out of it, and
 * frames inside groups are found too.
 */
export function topFrameAt(frames: readonly OpenFrame[], point: Point): ElementId | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (holds(f.box, point) && (f.visible === null || holds(f.visible, point)))
      return f.id;
  }
  return null;
}

/**
 * The frame the user can put elements into on top at `point` (root space),
 * or null for the canvas (`topFrameAt` over every open frame). Frames in
 * `exclude`, and everything inside them, are passed over, so that elements
 * being moved are never put into themselves.
 */
export function frameAt(
  doc: Y.Doc,
  point: Point,
  exclude: readonly ElementId[] = [],
): ElementId | null {
  const r = new Resolver(yLookup(doc));
  return topFrameAt(openFrames(doc, r, frameIds(doc), exclude), point);
}

/** The union of the elements' bounds in `space`, or null if none has bounds. */
function boundsOf(r: Resolver, ids: readonly ElementId[], space: ElementId | null) {
  let out: Rect | null = null;
  for (const id of ids) {
    const b = r.boundsIn(id, space) ?? { ...r.positionIn(id, space), w: 0, h: 0 };
    if (out === null) out = b;
    else {
      const x = Math.min(out.x, b.x);
      const y = Math.min(out.y, b.y);
      out = {
        x,
        y,
        w: Math.max(out.x + out.w, b.x + b.w) - x,
        h: Math.max(out.y + out.h, b.y + b.h) - y,
      };
    }
  }
  return out;
}

/** Moves elements into a container, keeping their order among each other; one transaction each. */
function moveInto(
  ctx: CommandContext,
  ids: readonly ElementId[],
  target: ElementId | null,
) {
  for (const id of backToFront(resolve(ctx), ids)) reparentElement(ctx.doc, id, target);
}

// ---------------------------------------------------------------------------
// A frame around elements, or drawn
// ---------------------------------------------------------------------------

export interface FrameArgs {
  /**
   * Elements to put in the frame, all seen in the same container. Without
   * `rect`, the frame is put around them, with a margin (FRAME_PADDING).
   */
  readonly ids?: readonly ElementId[];
  /** The frame's box in the space of `parent` (a frame drawn with the frame tool). */
  readonly rect?: Rect;
  /** The container the frame goes into when `rect` is given; default: the canvas. */
  readonly parent?: ElementId | null;
}

interface FramePlan {
  readonly parent: ElementId | null;
  readonly box: Rect;
  readonly members: ElementId[];
  /** Stacking index among the parent's slots; undefined: in front. */
  readonly index?: number;
}

function readRect(value: unknown): Rect | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { x, y, w, h } = value as Partial<Rect>;
  if (![x, y, w, h].every(isFiniteNumber)) return undefined;
  if (!(w! > 0) || !(h! > 0)) return undefined;
  return { x: x!, y: y!, w: w!, h: h! };
}

function planFrame(ctx: CommandContext, args: unknown): FramePlan | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const given = args as { ids?: unknown; rect?: unknown; parent?: unknown };
  const r = resolve(ctx);
  const none = Array.isArray(given.ids) && given.ids.length === 0;
  const ids = given.ids === undefined || none ? [] : readIds(given);
  if (ids === undefined) return undefined;
  if (given.rect !== undefined) {
    const box = readRect(given.rect);
    const parent = given.parent ?? null;
    if (box === undefined || (parent !== null && !isId(parent))) return undefined;
    if (!isOpenContainer(r, parent) || !canTargetAll(ctx, r, ids)) return undefined;
    if (ids.some((id) => r.logicalParentOf(id) !== parent)) return undefined;
    return { parent, box, members: ids };
  }
  if (ids.length === 0 || given.parent !== undefined) return undefined;
  if (!canTargetAll(ctx, r, ids)) return undefined;
  // Members must be seen in the same container, as for a group (0001, section 5.4).
  const parent = r.logicalParentOf(ids[0]!);
  if (ids.some((id) => r.logicalParentOf(id) !== parent)) return undefined;
  if (!isOpenContainer(r, parent)) return undefined;
  const bounds = boundsOf(r, ids, parent)!;
  const pad = Math.max(bounds.w, bounds.h) * FRAME_PADDING || 1;
  const box = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    w: bounds.w + 2 * pad,
    h: bounds.h + 2 * pad,
  };
  // The frame goes into the frontmost member's slot, as a group does.
  const slots = slotsOf(r, parent).map((s) => s.id);
  const holders = new Set(ids.map((id) => r.slotIn(id, parent) ?? id));
  const front = slots.reduce((at, id, i) => (holders.has(id) ? i : at), -1);
  return { parent, box, members: ids, index: front + 1 };
}

/**
 * Puts a frame around elements seen in the same container (`{ ids }`), or
 * makes a frame at a rectangle (`{ rect, parent?, ids? }`) with the given
 * elements in it. The elements keep their place on the canvas and their order
 * among each other. Selects the frame and returns its id. One undo step.
 */
export const frame = defineCommand<FrameArgs, ElementId>({
  name: "frame",
  label: label("frame"),
  undoLabel: label("frame.step"),
  quick: true,
  enabled: (ctx, args) => planFrame(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planFrame(ctx, args) ?? refuse("frame");
    const id = addElement(ctx.doc, {
      type: FRAME_TYPE,
      parent: plan.parent,
      x: plan.box.x,
      y: plan.box.y,
      size: { w: plan.box.w, h: plan.box.h },
      data: { clip: false, fill: null, stroke: null },
      ...(plan.index !== undefined ? { index: plan.index } : {}),
    });
    moveInto(ctx, plan.members, id);
    ctx.services.selection.set([id]);
    return id;
  },
});

// ---------------------------------------------------------------------------
// Removing a frame, keeping what is in it
// ---------------------------------------------------------------------------

function readFrames(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  return ids.every((id) => isFrame(r, id)) ? ids : undefined;
}

/**
 * Removes frames but keeps what is in them, where it is on the canvas and in
 * the stacking order (the frame is dissolved, docs/adr/0001, section 5.5).
 * Selects what was in them.
 */
export const removeFrame = defineCommand<{ readonly ids: readonly ElementId[] }, void>({
  name: "remove-frame",
  label: label("remove-frame"),
  undoLabel: label("remove-frame.step"),
  quick: true,
  enabled: (ctx, args) => readFrames(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readFrames(ctx, args) ?? refuse("remove-frame");
    for (const id of ids) dissolve(ctx.doc, id);
    const r = resolve(ctx);
    ctx.services.selection.set(ids.flatMap((id) => r.logicalChildren(id)));
  },
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

export interface RenameArgs {
  readonly id: ElementId;
  readonly name: string;
}

function readRename(ctx: CommandContext, args: unknown): RenameArgs | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const { id, name } = args as Partial<RenameArgs>;
  if (!isId(id) || typeof name !== "string") return undefined;
  if (name.length > MAX_NAME_LENGTH || LONE_SURROGATE.test(name)) return undefined;
  const r = resolve(ctx);
  if (!canTarget(ctx, r, id) || elementName(ctx.doc, id) === name) return undefined;
  return { id, name };
}

/** Names an element (a frame's name is shown on the canvas and used for its stops). */
export const rename = defineCommand<RenameArgs, void>({
  name: "rename",
  label: label("rename"),
  undoLabel: label("rename.step"),
  quick: true,
  enabled: (ctx, args) => readRename(ctx, args) !== undefined,
  execute(ctx, args) {
    const a = readRename(ctx, args) ?? refuse("rename");
    edit(ctx.doc, () => renameElement(ctx.doc, a.id, a.name));
  },
});

// ---------------------------------------------------------------------------
// Into and out of frames
// ---------------------------------------------------------------------------

/** Moving elements out of the frame they are seen in, to the container the frame is in. */
function planOut(
  ctx: CommandContext,
  args: unknown,
): { ids: ElementId[]; target: ElementId | null } | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  const from = r.logicalParentOf(ids[0]!);
  if (!isFrame(r, from) || ids.some((id) => r.logicalParentOf(id) !== from))
    return undefined;
  const target = r.logicalParentOf(from);
  if (!isOpenContainer(r, target)) return undefined;
  return { ids: outermost(r, ids), target };
}

/**
 * Moves elements out of the frame they are in, into the container the frame
 * is in, in front of the frame (so they stay seen). They keep their place on
 * the canvas.
 */
export const moveOutOfFrame = defineCommand<{ readonly ids: readonly ElementId[] }, void>(
  {
    name: "move-out-of-frame",
    label: label("move-out-of-frame"),
    undoLabel: label("move-out-of-frame.step"),
    quick: true,
    enabled: (ctx, args) => planOut(ctx, args) !== undefined,
    execute(ctx, args) {
      const plan = planOut(ctx, args) ?? refuse("move-out-of-frame");
      const r = resolve(ctx);
      const from = r.logicalParentOf(plan.ids[0]!)!;
      // Just in front of the frame they leave.
      const slots = slotsOf(r, plan.target).map((s) => s.id);
      const at = slots.indexOf(r.slotIn(from, plan.target) ?? from);
      backToFront(r, plan.ids).forEach((id, i) =>
        reparentElement(ctx.doc, id, plan.target, { index: at + 1 + i }),
      );
    },
  },
);

export interface MoveIntoFrameArgs {
  readonly ids: readonly ElementId[];
  /**
   * The frame to move them into. Default: the innermost frame under the
   * centre of their bounds (`frameAt`), as a drop there would choose.
   */
  readonly target?: ElementId;
}

function planInto(
  ctx: CommandContext,
  args: unknown,
): { ids: ElementId[]; target: ElementId } | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  const given = (args as { target?: unknown }).target;
  if (given !== undefined && !isId(given)) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids)) return undefined;
  let target: ElementId | null;
  if (given !== undefined) target = given;
  else {
    const b = boundsOf(r, ids, null);
    if (b === null) return undefined;
    target = frameAt(ctx.doc, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, ids);
  }
  if (!isFrame(r, target) || !isOpenContainer(r, target)) return undefined;
  if (ids.some((id) => r.isWithin(target, id))) return undefined;
  const moving = outermost(r, ids).filter((id) => r.logicalParentOf(id) !== target);
  return moving.length === 0 ? undefined : { ids: moving, target };
}

/**
 * Moves elements into a frame, in front of what is in it, without moving them
 * on the canvas. Without a target, into the innermost frame under them.
 */
export const moveIntoFrame = defineCommand<MoveIntoFrameArgs, void>({
  name: "move-into-frame",
  label: label("move-into-frame"),
  undoLabel: label("move-into-frame.step"),
  quick: true,
  enabled: (ctx, args) => planInto(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planInto(ctx, args) ?? refuse("move-into-frame");
    moveInto(ctx, plan.ids, plan.target);
  },
});
