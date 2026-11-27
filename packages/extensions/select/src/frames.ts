// SPDX-License-Identifier: GPL-3.0-or-later

// Frames on the canvas while editing (docs/adr/0014-stacking-and-frames.md):
// each frame on screen gets a thin outline and its name above its top-left
// corner, at a fixed size on screen, so that frames without a fill or a line
// of their own can be seen and taken. The name is a handle: a press on it
// selects the frame and a drag moves it. Not document content: drawn as an
// overlay, never exported and never shown by the player.

import { Resolver, type ElementId, type Point, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import { messageKey, type Label } from "@galatsa/extension-api";
import type {
  CommandContext,
  EditorServices,
  OverlayDefinition,
} from "@galatsa/extension-api/editing";
import { elementName, isFrame } from "@galatsa/extension-basics";
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
 * The frames the user sees on screen, nested ones included, back to front:
 * the visible top-level elements from the renderer, and the frames inside
 * each frame shown, from the document.
 */
export function shownFrames(services: EditorServices, doc: Y.Doc): ShownFrame[] {
  const r = new Resolver(yLookup(doc));
  const view = services.camera.viewport();
  const out: ShownFrame[] = [];
  const visit = (id: ElementId): void => {
    if (!isFrame(r, id) || r.isGone(id)) return;
    const size = r.get(id)?.size;
    if (size === undefined) return;
    const at = r.worldOrigin(id);
    const box = { x: at.x, y: at.y, w: size.w, h: size.h };
    if (!intersects(box, view)) return;
    out.push({ id, box });
    for (const child of r.logicalChildren(id)) visit(child);
  };
  for (const id of services.scene.visible()) visit(id);
  return out;
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
export function dropFrames(r: Resolver, exclude: readonly ElementId[]): DropFrame[] {
  const skip = (id: ElementId): boolean => exclude.some((e) => r.isWithin(id, e));
  const collect = (parent: ElementId | null): DropFrame[] => {
    const out: DropFrame[] = [];
    for (const id of r.logicalChildren(parent)) {
      if (!isFrame(r, id) || r.isLocked(id) || skip(id)) continue;
      const size = r.get(id)?.size;
      if (size === undefined) continue;
      const at = r.worldOrigin(id);
      out.push({
        id,
        box: { x: at.x, y: at.y, w: size.w, h: size.h },
        inside: collect(id),
      });
    }
    return out;
  };
  return collect(null);
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
