// SPDX-License-Identifier: GPL-3.0-or-later

// Cropping: the geometry of a crop, which keeps the part of the image still
// shown where it is on the canvas (the element's box shrinks or grows with the
// crop, as in other presentation programs), and the crop tool, which drags the
// edges of the shown part over the whole image and ends in one command.

import type { AssetId, ElementId, Point, Rect, Size } from "@galatsa/core";
import type {
  DrawContext,
  ElementPlacement,
  ToolDefinition,
  ToolPointerEvent,
  ToolSession,
} from "@galatsa/extension-api/editing";

/** An element's box: top-left corner of the unrotated box, size, rotation about its centre. */
export interface CropBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
}

/** The smallest crop, in pixels of the image. */
export const MIN_CROP_PIXELS = 1;

/** The whole image as a crop rectangle. */
export function fullCrop(natural: Size): Rect {
  return { x: 0, y: 0, w: natural.w, h: natural.h };
}

/**
 * A crop rectangle kept inside the image and at least MIN_CROP_PIXELS on each
 * side (for images smaller than that, the whole image). Null if the image has
 * no size.
 */
export function clampCrop(crop: Rect, natural: Size): Rect | null {
  if (!(natural.w > 0) || !(natural.h > 0)) return null;
  const axis = (start: number, length: number, max: number): [number, number] => {
    const min = Math.min(MIN_CROP_PIXELS, max);
    let a = Math.min(Math.max(start, 0), max - min);
    let b = Math.min(Math.max(start + length, a + min), max);
    if (!Number.isFinite(a) || !Number.isFinite(b)) [a, b] = [0, max];
    return [a, b - a];
  };
  const [x, w] = axis(crop.x, crop.w, natural.w);
  const [y, h] = axis(crop.y, crop.h, natural.h);
  return { x, y, w, h };
}

/** True if two crops are the same rectangle. */
export function sameCrop(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * The box that shows the part `next` of the image where the box `box`, which
 * shows the part `current`, shows it: the image keeps its place and scale on
 * the canvas, and the box takes the new part's place, turned as before.
 * Undefined if the box or the crop has no size.
 */
export function boxForCrop(
  box: CropBox,
  current: Rect,
  next: Rect,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!(box.w > 0) || !(box.h > 0) || !(current.w > 0) || !(current.h > 0))
    return undefined;
  // World units per pixel of the image, along each side.
  const sx = box.w / current.w;
  const sy = box.h / current.h;
  // The new box in the old box's own frame (unrotated, from its top-left).
  const left = (next.x - current.x) * sx;
  const top = (next.y - current.y) * sy;
  const w = next.w * sx;
  const h = next.h * sy;
  // Its centre, turned about the old centre.
  const dx = left + w / 2 - box.w / 2;
  const dy = top + h / 2 - box.h / 2;
  const cos = Math.cos(box.rot);
  const sin = Math.sin(box.rot);
  const cx = box.x + box.w / 2 + dx * cos - dy * sin;
  const cy = box.y + box.h / 2 + dx * sin + dy * cos;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** A point in root space in the box's own frame (unrotated, from its top-left). */
export function toBoxFrame(p: Point, box: CropBox): Point {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const cos = Math.cos(-box.rot);
  const sin = Math.sin(-box.rot);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: dx * cos - dy * sin + box.w / 2, y: dx * sin + dy * cos + box.h / 2 };
}

/** A point in the box's own frame in root space. */
export function fromBoxFrame(p: Point, box: CropBox): Point {
  const cos = Math.cos(box.rot);
  const sin = Math.sin(box.rot);
  const dx = p.x - box.w / 2;
  const dy = p.y - box.h / 2;
  return {
    x: box.x + box.w / 2 + dx * cos - dy * sin,
    y: box.y + box.h / 2 + dx * sin + dy * cos,
  };
}

/** Which edges a crop handle moves: -1 the left or top edge, 1 the right or bottom one. */
export interface Handle {
  readonly h: -1 | 0 | 1;
  readonly v: -1 | 0 | 1;
}

export const HANDLES: readonly Handle[] = [
  { h: -1, v: -1 },
  { h: 0, v: -1 },
  { h: 1, v: -1 },
  { h: 1, v: 0 },
  { h: 1, v: 1 },
  { h: 0, v: 1 },
  { h: -1, v: 1 },
  { h: -1, v: 0 },
];

/**
 * The crop after dragging a handle by (dx, dy) in the box's frame (world
 * units): the edges the handle moves follow, within the image.
 */
export function dragCrop(
  current: Rect,
  box: { readonly w: number; readonly h: number },
  natural: Size,
  handle: Handle,
  dx: number,
  dy: number,
): Rect | null {
  const sx = current.w / box.w;
  const sy = current.h / box.h;
  let { x, y } = current;
  let right = current.x + current.w;
  let bottom = current.y + current.h;
  if (handle.h === -1) x = Math.min(x + dx * sx, right - MIN_CROP_PIXELS);
  if (handle.h === 1) right = Math.max(right + dx * sx, x + MIN_CROP_PIXELS);
  if (handle.v === -1) y = Math.min(y + dy * sy, bottom - MIN_CROP_PIXELS);
  if (handle.v === 1) bottom = Math.max(bottom + dy * sy, y + MIN_CROP_PIXELS);
  x = Math.max(0, x);
  y = Math.max(0, y);
  right = Math.min(natural.w, right);
  bottom = Math.min(natural.h, bottom);
  return clampCrop({ x, y, w: right - x, h: bottom - y }, natural);
}

/** What the crop tool needs to know about an image, from the document. */
export interface CropTarget {
  readonly id: ElementId;
  /** The image's asset, drawn whole under the shade where the overlay can (unturned images). */
  readonly asset?: AssetId;
  readonly placement: ElementPlacement;
  /** The image's natural size. */
  readonly natural: Size;
  /** The part shown now (the whole image when not cropped). */
  readonly crop: Rect;
}

/** How the crop tool reaches the document, given by the editing part. */
export interface CropToolParts {
  readonly name: string;
  readonly label: ToolDefinition["label"];
  readonly shortcuts?: ToolDefinition["shortcuts"];
  /** The image the tool works on, if `id` is one it may crop. */
  target(session: ToolSession, id: ElementId): CropTarget | null;
  /** The command that crops (`{ id, crop }`). */
  readonly command: string;
}

/** Handles are this many CSS pixels across, and hit this far around. */
const HANDLE_PX = 8;
const HIT_PX = 10;

/** The crop tool. */
export function cropTool(parts: CropToolParts): ToolDefinition {
  return {
    name: parts.name,
    label: parts.label,
    ...(parts.shortcuts ? { shortcuts: parts.shortcuts } : {}),
    quick: true,
    icon: "crop",
    cursor: "default",
    start(session) {
      const services = () => session.environment().services;
      /** World units per CSS pixel. */
      const px = (): number => {
        const zoom = services().camera.get().zoom;
        return Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;
      };
      const selected = (): CropTarget | null => {
        const ids = services().selection.get();
        return ids.length === 1 ? parts.target(session, ids[0]!) : null;
      };
      let target = selected();
      let drag: { handle: Handle; from: Point; crop: Rect } | null = null;
      let preview: Rect | null = null;

      const boxOf = (t: CropTarget): CropBox => ({
        x: t.placement.worldX,
        y: t.placement.worldY,
        w: t.placement.w,
        h: t.placement.h,
        rot: t.placement.rot,
      });
      const refresh = (): void => {
        if (target !== null) target = parts.target(session, target.id);
      };
      const handleAt = (t: CropTarget, world: Point): Handle | null => {
        const local = toBoxFrame(world, boxOf(t));
        const tolerance = HIT_PX * px();
        for (const handle of HANDLES) {
          const hx = ((handle.h + 1) / 2) * t.placement.w;
          const hy = ((handle.v + 1) / 2) * t.placement.h;
          if (Math.abs(local.x - hx) <= tolerance && Math.abs(local.y - hy) <= tolerance)
            return handle;
        }
        return null;
      };
      const reset = (): void => {
        drag = null;
        preview = null;
        session.requestOverlay();
      };
      const nextCrop = (event: ToolPointerEvent): Rect | null => {
        if (drag === null || target === null) return null;
        const box = boxOf(target);
        const a = toBoxFrame(drag.from, box);
        const b = toBoxFrame(event.world, box);
        return dragCrop(
          drag.crop,
          target.placement,
          target.natural,
          drag.handle,
          b.x - a.x,
          b.y - a.y,
        );
      };
      session.requestOverlay();
      return {
        pointerDown(event) {
          if (event.button !== 0) return;
          refresh();
          const handle = target === null ? null : handleAt(target, event.world);
          if (target !== null && handle !== null) {
            drag = { handle, from: event.world, crop: target.crop };
            preview = target.crop;
            return;
          }
          // Another image: crop that one. Anything else: back to the default tool.
          const hit = services().scene.elementAt(event.world, HIT_PX * px());
          const other = hit === null ? null : parts.target(session, hit);
          if (other !== null) {
            target = other;
            services().selection.set([other.id]);
            session.requestOverlay();
          } else session.done();
        },
        pointerMove(event) {
          if (drag === null) return;
          preview = nextCrop(event);
          session.requestOverlay();
        },
        pointerUp(event) {
          if (drag === null || target === null) return;
          const crop = nextCrop(event);
          const id = target.id;
          const before = drag.crop;
          reset();
          if (crop !== null && !sameCrop(crop, before))
            session.run(parts.command, { id, crop });
          refresh();
          session.requestOverlay();
        },
        pointerCancel: reset,
        keyDown(event) {
          if (event.key === "Escape") {
            if (drag !== null) reset();
            else session.done();
            return true;
          }
          if (event.key === "Enter") {
            session.done();
            return true;
          }
          return false;
        },
        drawOverlay(ctx) {
          refresh();
          if (target === null) return;
          drawCropOverlay(ctx, target, preview ?? target.crop, px());
        },
        stop: reset,
      };
    },
  };
}

/**
 * The crop overlay in root space: the whole image's outline, a shade over the
 * part outside the crop, the crop's outline and its handles.
 */
export function drawCropOverlay(
  ctx: DrawContext,
  target: CropTarget,
  crop: Rect,
  px: number,
): void {
  const box: CropBox = {
    x: target.placement.worldX,
    y: target.placement.worldY,
    w: target.placement.w,
    h: target.placement.h,
    rot: target.placement.rot,
  };
  const sx = box.w / target.crop.w;
  const sy = box.h / target.crop.h;
  // In the box's frame: the whole image, and the crop being shown.
  const whole = {
    x: -target.crop.x * sx,
    y: -target.crop.y * sy,
    w: target.natural.w * sx,
    h: target.natural.h * sy,
  };
  const inner = {
    x: (crop.x - target.crop.x) * sx,
    y: (crop.y - target.crop.y) * sy,
    w: crop.w * sx,
    h: crop.h * sy,
  };
  const corners = (r: Rect): Point[] =>
    [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ].map((p) => fromBoxFrame(p, box));
  const outline = (
    path: ReturnType<DrawContext["createPath"]>,
    pts: Point[],
    reverse = false,
  ) => {
    const list = reverse ? [...pts].reverse() : pts;
    list.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    path.closePath();
  };
  // The whole image under a shade, so the user sees what the crop leaves
  // out. The overlay only translates, so a turned image gets the shade alone.
  if (target.asset !== undefined && box.rot === 0) {
    const at = fromBoxFrame({ x: whole.x, y: whole.y }, box);
    ctx.drawImage(target.asset, { x: at.x, y: at.y, w: whole.w, h: whole.h });
  }
  const shade = ctx.createPath();
  outline(shade, corners(whole));
  outline(shade, corners(inner), true);
  ctx.fill(shade, "rgba(15, 23, 42, 0.55)");
  const wholePath = ctx.createPath();
  outline(wholePath, corners(whole));
  ctx.stroke(wholePath, { color: "#64748b", width: px, dash: [4 * px, 4 * px] });
  const cropPath = ctx.createPath();
  outline(cropPath, corners(inner));
  ctx.stroke(cropPath, { color: "#2563eb", width: 2 * px });
  const half = (HANDLE_PX / 2) * px;
  for (const handle of HANDLES) {
    const c = fromBoxFrame(
      {
        x: inner.x + ((handle.h + 1) / 2) * inner.w,
        y: inner.y + ((handle.v + 1) / 2) * inner.h,
      },
      box,
    );
    const square = ctx.createPath();
    square.rect(c.x - half, c.y - half, 2 * half, 2 * half);
    ctx.fill(square, "#ffffff");
    ctx.stroke(square, { color: "#2563eb", width: px });
  }
}
