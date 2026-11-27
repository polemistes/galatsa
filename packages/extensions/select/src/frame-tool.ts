// SPDX-License-Identifier: GPL-3.0-or-later

// The frame tool (docs/adr/0014-stacking-and-frames.md): a drag draws a new
// frame, in the innermost frame under the point where the drag starts, and
// what lies wholly inside the drawn rectangle there goes into it. A click
// makes a frame of a set size on screen (16:9) with its corner at the point.
// The new frame is selected and the selection tool comes back. One undo step.

import { Resolver, type ElementId, type Point, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import type {
  DrawContext,
  ToolHandler,
  ToolPointerEvent,
  ToolSession,
} from "@galatsa/extension-api/editing";
import { BASICS, frameAt } from "@galatsa/extension-basics";

/** A press that moves less than this (CSS pixels) is a click. */
const CLICK = 3;
/** The size of a frame made with a click, in CSS pixels on screen. */
export const CLICK_FRAME = { w: 480, h: 270 } as const;
const COLOR = "#2563eb";

function rectOf(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function inside(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function startFrameTool(session: ToolSession): ToolHandler {
  const services = () => session.environment().services;
  const zoom = (): number => services().camera.get().zoom;
  let drag: { readonly start: ToolPointerEvent; current: Point } | null = null;

  const finish = (event: ToolPointerEvent): void => {
    const start = drag!.start;
    drag = null;
    session.requestOverlay();
    const still =
      Math.hypot(event.screen.x - start.screen.x, event.screen.y - start.screen.y) <
      CLICK;
    const k = zoom();
    const world = still
      ? { x: start.world.x, y: start.world.y, w: CLICK_FRAME.w / k, h: CLICK_FRAME.h / k }
      : rectOf(start.world, event.world);
    if (!(world.w > 0) || !(world.h > 0)) return;
    const r = new Resolver(yLookup(session.environment().doc));
    const parent = frameAt(r, start.world);
    // The rectangle in the parent's space, and what lies wholly inside it there.
    const shift = services().scene.offset(null, parent);
    const rect = { x: world.x + shift.x, y: world.y + shift.y, w: world.w, h: world.h };
    const ids: ElementId[] = still
      ? []
      : r.logicalChildren(parent).filter((id) => {
          if (r.isLocked(id)) return false;
          const b = r.boundsIn(id, parent);
          return b !== null && inside(rect, b);
        });
    const outcome = session.run(BASICS.frame, {
      rect,
      parent,
      ...(ids.length > 0 ? { ids } : {}),
    });
    if (outcome.ok) session.done();
  };

  return {
    pointerDown(event) {
      if (event.button !== 0) return;
      drag = { start: event, current: event.world };
    },
    pointerMove(event) {
      if (drag === null) return;
      drag.current = event.world;
      session.requestOverlay();
    },
    pointerUp(event) {
      if (drag === null) return;
      finish(event);
    },
    pointerCancel() {
      drag = null;
      session.requestOverlay();
    },
    keyDown(event) {
      if (event.key !== "Escape") return false;
      if (drag !== null) {
        drag = null;
        session.requestOverlay();
      } else session.done();
      return true;
    },
    drawOverlay(ctx: DrawContext) {
      if (drag === null) return;
      const px = 1 / zoom();
      const r = rectOf(drag.start.world, drag.current);
      const path = ctx.createPath();
      path.rect(r.x, r.y, r.w, r.h);
      ctx.stroke(path, { color: COLOR, width: px, dash: [6 * px, 4 * px] });
    },
    stop() {
      drag = null;
    },
  } satisfies ToolHandler & { drawOverlay(ctx: DrawContext): void };
}
