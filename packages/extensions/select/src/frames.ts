// SPDX-License-Identifier: GPL-3.0-or-later

// Frames on the canvas while editing (docs/adr/0014-stacking-and-frames.md):
// each frame on screen gets a thin outline and its name above its top-left
// corner, at a fixed size on screen, so that frames without a fill or a line
// of their own can be seen and taken. The name is a handle: a press on it
// selects the frame and a drag moves it. Not document content: drawn as an
// overlay, never exported and never shown by the player.

import {
  FRAME_TYPE,
  Resolver,
  type ElementId,
  type Point,
  type Rect,
} from "@galatsa/core";
import { roots, yLookup } from "@galatsa/core/ydoc";
import { messageKey, type Label } from "@galatsa/extension-api";
import type {
  CommandContext,
  EditorServices,
  OverlayDefinition,
} from "@galatsa/extension-api/editing";
import { elementName } from "@galatsa/extension-basics";
import type * as Y from "yjs";
import { selectMessages } from "./messages/index.ts";

/** Height of the name above a frame, in CSS pixels. */
export const LABEL_HEIGHT = 18;
/** The narrowest a name can be taken, in CSS pixels, however small the frame is on screen. */
export const LABEL_MIN_WIDTH = 48;
/** The widest a name is drawn, in CSS pixels. */
const LABEL_MAX_WIDTH = 320;
/** Font size of the name, in CSS pixels. */
const LABEL_FONT = 12;
/** Frames narrower than this on screen get no name drawn (their outline only). */
const LABEL_MIN_FRAME = 24;

const OUTLINE = "rgba(100, 116, 139, 0.7)";
const NAME = "#475569";

/** The name shown for a frame without one. */
export const UNNAMED_FRAME: Label = messageKey(selectMessages, "frame.unnamed");

/** A frame shown on screen. */
export interface ShownFrame {
  readonly id: ElementId;
  /** Its box in root space. */
  readonly box: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/**
 * Whether an element is a frame, read straight from its record: much
 * cheaper than resolving it, for the many elements that are not frames.
 */
function frameTest(doc: Y.Doc): (id: ElementId) => boolean {
  const elements = roots(doc).elements;
  return (id) => {
    const record = elements.get(id) as { get?(key: string): unknown } | undefined;
    return typeof record?.get === "function" && record.get("type") === FRAME_TYPE;
  };
}

/** The frames of a document, found again after each change of it. */
const frameIds = new WeakMap<Y.Doc, { ids: ElementId[] | null }>();

function framesOf(doc: Y.Doc): readonly ElementId[] {
  let entry = frameIds.get(doc);
  if (entry === undefined) {
    const made = { ids: null as ElementId[] | null };
    doc.on("update", () => {
      made.ids = null;
    });
    frameIds.set(doc, made);
    entry = made;
  }
  if (entry.ids === null) {
    const frame = frameTest(doc);
    entry.ids = [...roots(doc).elements.keys()].filter(frame);
  }
  return entry.ids;
}

/**
 * The frames the user sees on screen, nested ones included: outer frames
 * before the frames inside them, so a name drawn later (and found first) is
 * that of the inner frame. Drawn in every frame on screen, so the frames are
 * found by their type alone, once per change of the document, and only they
 * are resolved.
 */
export function shownFrames(services: EditorServices, doc: Y.Doc): ShownFrame[] {
  const r = new Resolver(yLookup(doc));
  const view = services.camera.viewport();
  const out: { id: ElementId; box: Rect; depth: number }[] = [];
  for (const id of framesOf(doc)) {
    if (r.isGone(id)) continue;
    const size = r.get(id)?.size;
    if (size === undefined) continue;
    const at = r.worldOrigin(id);
    const box = { x: at.x, y: at.y, w: size.w, h: size.h };
    if (!intersects(box, view)) continue;
    let depth = 0;
    for (let p = r.logicalParentOf(id); p !== null; p = r.logicalParentOf(p)) depth++;
    out.push({ id, box, depth });
  }
  out.sort((a, b) => a.depth - b.depth);
  return out.map(({ id, box }) => ({ id, box }));
}

/** Where a frame's name can be taken, in root space, at a zoom (CSS pixels per unit). */
export function labelRect(box: Rect, zoom: number): Rect {
  const h = LABEL_HEIGHT / zoom;
  return { x: box.x, y: box.y - h, w: Math.max(box.w, LABEL_MIN_WIDTH / zoom), h };
}

/** The frontmost frame whose name is under a point (root space), or null. */
export function labelAt(
  frames: readonly ShownFrame[],
  point: Point,
  zoom: number,
): ElementId | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const rect = labelRect(frames[i]!.box, zoom);
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h
    )
      return frames[i]!.id;
  }
  return null;
}

/** A frame elements can be dropped into, with the frames inside it, back to front. */
export interface DropFrame {
  readonly id: ElementId;
  readonly box: Rect;
  readonly inside: readonly DropFrame[];
}

/**
 * The frames elements being dragged can be dropped into: open (seen, not
 * locked) and not among the dragged elements or inside them, nested as in
 * the document, back to front. Worked out once when a drag starts, since the
 * document does not change during it.
 */
export function dropFrames(doc: Y.Doc, exclude: readonly ElementId[]): DropFrame[] {
  const r = new Resolver(yLookup(doc));
  const skip = (id: ElementId): boolean => exclude.some((e) => r.isWithin(id, e));
  // The frames alone, found by type, each under the frame it is seen in:
  // walking every container's children would read every element.
  interface Node {
    readonly id: ElementId;
    readonly box: Rect;
    readonly parent: ElementId | null;
    /** Its stacking among its siblings: the slot it is in, then its own place. */
    readonly key: readonly string[];
    readonly inside: Node[];
  }
  const nodes = new Map<ElementId, Node>();
  for (const id of framesOf(doc)) {
    if (r.isGone(id) || r.isLocked(id) || skip(id)) continue;
    const envelope = r.get(id);
    if (envelope?.size === undefined) continue;
    const at = r.worldOrigin(id);
    const parent = r.logicalParentOf(id);
    const holder = r.slotIn(id, parent) ?? id;
    const key = [r.get(holder)?.order ?? "", holder, envelope.order, id];
    const box = { x: at.x, y: at.y, w: envelope.size.w, h: envelope.size.h };
    nodes.set(id, { id, box, parent, key, inside: [] });
  }
  const top: Node[] = [];
  for (const node of nodes.values()) {
    // A frame inside one that cannot be dropped into is not offered either.
    if (node.parent === null) top.push(node);
    else nodes.get(node.parent)?.inside.push(node);
  }
  const compare = (a: Node, b: Node): number => {
    for (let i = 0; i < a.key.length; i++) {
      const x = a.key[i]!;
      const y = b.key[i]!;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  const sorted = (list: Node[]): DropFrame[] =>
    list.sort(compare).map((n) => ({ id: n.id, box: n.box, inside: sorted(n.inside) }));
  return sorted(top);
}

/**
 * Where a drop at a point (root space) puts elements: the innermost frame
 * that holds the point, into the frontmost at each level, or null for the
 * canvas. The same rule as the basics' `frameAt`.
 */
export function dropTarget(frames: readonly DropFrame[], point: Point): ElementId | null {
  let found: ElementId | null = null;
  let level = frames;
  for (;;) {
    let next: DropFrame | null = null;
    for (let i = level.length - 1; i >= 0; i--) {
      const { box } = level[i]!;
      if (
        point.x >= box.x &&
        point.x <= box.x + box.w &&
        point.y >= box.y &&
        point.y <= box.y + box.h
      ) {
        next = level[i]!;
        break;
      }
    }
    if (next === null) return found;
    found = next.id;
    level = next.inside;
  }
}

/** A frame's box in root space, from the drop frames. */
export function dropBox(frames: readonly DropFrame[], id: ElementId): Rect | null {
  for (const frame of frames) {
    if (frame.id === id) return frame.box;
    const inner = dropBox(frame.inside, id);
    if (inner !== null) return inner;
  }
  return null;
}

/** Draws the outline and the name of every frame on screen. */
export const frameOverlay: OverlayDefinition = {
  name: "frames",
  quick: true,
  draw(ctx, context: CommandContext) {
    const zoom = context.services.camera.get().zoom;
    const px = 1 / zoom;
    for (const { id, box } of shownFrames(context.services, context.doc)) {
      const outline = ctx.createPath();
      outline.rect(box.x, box.y, box.w, box.h);
      ctx.stroke(outline, { color: OUTLINE, width: px, dash: [4 * px, 3 * px] });
      if (box.w * zoom < LABEL_MIN_FRAME) continue;
      const name = elementName(context.doc, id) || ctx.t(UNNAMED_FRAME);
      const width = Math.min(Math.max(box.w * zoom, LABEL_MIN_WIDTH), LABEL_MAX_WIDTH);
      const text = ctx.layoutText(
        name,
        {
          fontFamily: "system-ui, sans-serif",
          fontSize: LABEL_FONT * px,
          color: NAME,
          align: "left",
        },
        width * px,
      );
      // One line: what does not fit the width is cut off.
      ctx.withClip(labelPath(ctx, box, zoom, width), () =>
        ctx.drawText(text, box.x, box.y - (LABEL_HEIGHT - 3) * px),
      );
    }
  },
};

function labelPath(
  ctx: Parameters<OverlayDefinition["draw"]>[0],
  box: Rect,
  zoom: number,
  width: number,
) {
  const path = ctx.createPath();
  path.rect(box.x, box.y - LABEL_HEIGHT / zoom, width / zoom, LABEL_HEIGHT / zoom);
  return path;
}
