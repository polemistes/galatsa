// SPDX-License-Identifier: GPL-3.0-or-later

// Frames on the canvas while editing (docs/adr/0014-stacking-and-frames.md):
// each frame on screen gets a thin outline and its name above its top-left
// corner, at a fixed size on screen, so that frames without a fill or a line
// of their own can be seen and taken. The name is a handle: a press on it
// selects the frame and a drag moves it. Not document content: drawn as an
// overlay, never exported and never shown by the player. And where a drag of
// the selection puts it: into a frame, out of one, or where it is.

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
  DrawContext,
  EditorServices,
  OverlayDefinition,
} from "@galatsa/extension-api/editing";
import {
  drawingPath,
  elementName,
  isFrame,
  openFrames,
  topFrameAt,
  type OpenFrame,
} from "@galatsa/extension-basics";
import type * as Y from "yjs";
import { selectMessages } from "./messages/index.ts";

/** Height of the name above a frame, in CSS pixels. */
export const LABEL_HEIGHT = 18;
/** The widest a name is drawn, in CSS pixels. */
export const LABEL_MAX_WIDTH = 320;
/** Font size of the name, in CSS pixels. */
const LABEL_FONT = 12;
/** Space around the name's text, in CSS pixels, on each side. */
const LABEL_PAD = 4;
/** Frames narrower than this on screen get no name (their outline only). */
export const LABEL_MIN_FRAME = 24;

const OUTLINE = "rgba(100, 116, 139, 0.7)";
const NAME = "#475569";

/** The name shown for a frame without one. */
export const UNNAMED_FRAME: Label = messageKey(selectMessages, "frame.unnamed");

/** A frame shown on screen. */
export interface ShownFrame {
  readonly id: ElementId;
  /** Its box in root space, as the user sees it (a drag's preview included). */
  readonly box: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function holds(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

// ---------------------------------------------------------------------------
// The frames on screen
// ---------------------------------------------------------------------------

/** The frames of a document, found again after each change of it. */
const frameIdsOf = new WeakMap<Y.Doc, { ids: ElementId[] | null }>();

function framesOf(doc: Y.Doc): readonly ElementId[] {
  let entry = frameIdsOf.get(doc);
  if (entry === undefined) {
    const made = { ids: null as ElementId[] | null };
    doc.on("update", () => {
      made.ids = null;
    });
    frameIdsOf.set(doc, made);
    entry = made;
  }
  if (entry.ids === null) {
    const elements = roots(doc).elements;
    entry.ids = [...elements.keys()].filter((id) => {
      const record = elements.get(id) as { get?(key: string): unknown } | undefined;
      return typeof record?.get === "function" && record.get("type") === FRAME_TYPE;
    });
  }
  return entry.ids;
}

/**
 * The frames the user sees on screen, nested ones included, in drawing
 * order, back to front: a name drawn later (and found first) is that of the
 * frame on top. Their boxes follow a drag's preview (the offset of a frame's
 * own space is where its corner is). Drawn in every frame on screen, so the
 * frames are found by their type alone, once per change of the document.
 */
export function shownFrames(services: EditorServices, doc: Y.Doc): ShownFrame[] {
  const r = new Resolver(yLookup(doc));
  const view = services.camera.viewport();
  const out: { id: ElementId; box: Rect; path: string[] }[] = [];
  for (const id of framesOf(doc)) {
    if (r.isGone(id)) continue;
    const size = r.get(id)?.size;
    if (size === undefined) continue;
    const at = services.scene.offset(id, null);
    const box = { x: at.x, y: at.y, w: size.w, h: size.h };
    if (!intersects(box, view)) continue;
    out.push({ id, box, path: drawingPath(r, id) });
  }
  out.sort((a, b) => {
    const n = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < n; i++)
      if (a.path[i] !== b.path[i]) return a.path[i]! < b.path[i]! ? -1 : 1;
    return a.path.length - b.path.length;
  });
  return out.map(({ id, box }) => ({ id, box }));
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * How wide each frame's name was drawn, in CSS pixels (the size of the text
 * does not change with the zoom), so that a name is taken exactly where it is
 * drawn. Until a name has been drawn, its width is estimated.
 */
const nameWidths = new WeakMap<Y.Doc, Map<ElementId, { name: string; px: number }>>();

function widthsOf(doc: Y.Doc): Map<ElementId, { name: string; px: number }> {
  let map = nameWidths.get(doc);
  if (map === undefined) nameWidths.set(doc, (map = new Map()));
  return map;
}

/**
 * Where a frame's name is drawn and taken, in root space, at a zoom (CSS
 * pixels per unit); null where no name is drawn (a frame under
 * LABEL_MIN_FRAME pixels wide). It is the name's text with a little room,
 * never wider than the frame on screen nor LABEL_MAX_WIDTH.
 */
export function labelRect(box: Rect, zoom: number, textPx: number): Rect | null {
  const frame = box.w * zoom;
  if (frame < LABEL_MIN_FRAME) return null;
  const px = Math.min(textPx + 2 * LABEL_PAD, frame, LABEL_MAX_WIDTH);
  const h = LABEL_HEIGHT / zoom;
  return { x: box.x, y: box.y - h, w: px / zoom, h };
}

/**
 * The width of a frame's name in CSS pixels: as last drawn for the name the
 * frame has now, or estimated before it is drawn (a frame without a name
 * shows a short word).
 */
function textWidth(doc: Y.Doc, id: ElementId): number {
  const raw = elementName(doc, id);
  const known = widthsOf(doc).get(id);
  if (known !== undefined && known.name === raw) return known.px;
  return Math.max([...raw].length, 6) * LABEL_FONT * 0.6;
}

/**
 * The frame whose drawn name is under a point (root space), or null: the
 * one drawn last, on top, where names overlap.
 */
export function labelAt(
  doc: Y.Doc,
  frames: readonly ShownFrame[],
  point: Point,
  zoom: number,
): ElementId | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const { id, box } = frames[i]!;
    const rect = labelRect(box, zoom, textWidth(doc, id));
    if (rect !== null && holds(rect, point)) return id;
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
    const widths = widthsOf(context.doc);
    for (const { id, box } of shownFrames(context.services, context.doc)) {
      const outline = ctx.createPath();
      outline.rect(box.x, box.y, box.w, box.h);
      ctx.stroke(outline, { color: OUTLINE, width: px, dash: [4 * px, 3 * px] });
      const raw = elementName(context.doc, id);
      const name = raw || ctx.t(UNNAMED_FRAME);
      const text = ctx.layoutText(
        name,
        {
          fontFamily: "system-ui, sans-serif",
          fontSize: LABEL_FONT * px,
          color: NAME,
          align: "left",
        },
        LABEL_MAX_WIDTH * px,
      );
      widths.set(id, { name: raw, px: text.width * zoom });
      const rect = labelRect(box, zoom, text.width * zoom);
      if (rect === null) continue;
      // One line: what does not fit is cut off at the frame's width.
      ctx.withClip(rectPath(ctx, rect), () =>
        ctx.drawText(text, box.x + LABEL_PAD * px, box.y - (LABEL_HEIGHT - 3) * px),
      );
    }
  },
};

function rectPath(ctx: DrawContext, r: Rect) {
  const path = ctx.createPath();
  path.rect(r.x, r.y, r.w, r.h);
  return path;
}

// ---------------------------------------------------------------------------
// Where a drag of the selection puts it
// ---------------------------------------------------------------------------

/** What a drag needs to decide where the selection goes, worked out when it starts. */
export interface DropPlan {
  /** The frames it can go into, in drawing order (the document does not change during a drag). */
  readonly frames: readonly OpenFrame[];
  /**
   * The frame the dragged elements are in (through groups, which they stay
   * in), or null for the canvas; undefined when they are in different ones.
   */
  readonly from: ElementId | null | undefined;
  /** The centre of the selection's bounds when the drag started (root space). */
  readonly start: Point;
  /** The frame on top at the start centre. */
  readonly startTarget: ElementId | null;
  /**
   * How far the centre must move, without crossing a frame's edge, before a
   * selection that started outside its frame's box leaves it: half its larger
   * side, at least a few pixels.
   */
  readonly reach: number;
}

/** The frame an element is in, through groups (null for the canvas). */
function frameOf(r: Resolver, id: ElementId): ElementId | null {
  let at = r.logicalParentOf(id);
  while (at !== null && !isFrame(r, at)) at = r.logicalParentOf(at);
  return at;
}

export function planDrop(
  doc: Y.Doc,
  moving: readonly ElementId[],
  bounds: Rect,
  minReach: number,
): DropPlan {
  const r = new Resolver(yLookup(doc));
  const frames = openFrames(doc, r, framesOf(doc), moving);
  const containers = new Set(moving.map((id) => frameOf(r, id)));
  const from = containers.size === 1 ? [...containers][0]! : undefined;
  const start = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  return {
    frames,
    from,
    start,
    startTarget: topFrameAt(frames, start),
    reach: Math.max(Math.max(bounds.w, bounds.h) / 2, minReach),
  };
}

/**
 * Where the selection goes when let go with its centre at `centre` (root
 * space, the offset it is dragged by, Shift's lock included): a frame, null
 * for the canvas, or undefined where it stays in the containers it is in.
 * It stays unless it clearly lands elsewhere:
 *
 * 1. Where the frame on top under the centre is the frame it is in, it stays.
 * 2. Where the centre has crossed a frame's edge since the drag started (the
 *    frame on top under it is another than at the start), it goes into the
 *    frame on top there, or out to the canvas.
 * 3. Otherwise (it started with its centre outside its frame, over the same
 *    frame or canvas as now), it stays, until the centre has moved `reach`
 *    away from where it started.
 *
 * A selection in different frames stays unless its centre crosses a frame's
 * edge. Groups are passed through: elements in a group in the frame stay in
 * the group while the frame is the one under them.
 */
export function dropInto(plan: DropPlan, centre: Point): ElementId | null | undefined {
  const target = topFrameAt(plan.frames, centre);
  if (plan.from === undefined) return target !== plan.startTarget ? target : undefined;
  if (target === plan.from) return undefined;
  if (target !== plan.startTarget) return target;
  const moved = Math.hypot(centre.x - plan.start.x, centre.y - plan.start.y);
  return moved >= plan.reach ? target : undefined;
}

/** A frame's box in root space, from a drop plan. */
export function dropBox(plan: DropPlan, id: ElementId): Rect | null {
  return plan.frames.find((f) => f.id === id)?.box ?? null;
}
