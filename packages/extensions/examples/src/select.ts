// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the selection tool, written as an extension against the editor's
// services: click to select (Shift adds or removes), drag a rubber band to
// select what it touches, drag the selection to move it. A drag previews the
// move without changing the document, snaps the left and top edges to other
// elements' edges, and ends in one move command (one transaction, one undo
// step); Escape cancels it. Also scaling that keeps proportions, and "select
// all". The real selection tool is the editor's own; this shows that the
// interface lets it be written as an extension.

import { Resolver, type ElementId, type Point, type Rect } from "@galatsa/core";
import { edit, moveElement, yLookup } from "@galatsa/core/ydoc";
import {
  applyScale,
  defineCommand,
  defineEditExtension,
  defineViewExtension,
  planScale,
  type CommandContext,
  type Gesture,
  type ToolHandler,
  type ToolPointerEvent,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import { API, label } from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const SELECT_EXTENSION = "examples.select";
export const SELECT_MOVE = `${SELECT_EXTENSION}/move`;
export const SELECT_SCALE = `${SELECT_EXTENSION}/scale`;
export const SELECT_ALL = `${SELECT_EXTENSION}/all`;

/** How close, in screen pixels, an edge must come to another to snap to it. */
export const SNAP_PIXELS = 6;
/** A drag shorter than this many screen pixels is a click. */
const CLICK_SLOP = 3;
/** Pick tolerance, in screen pixels. */
const PICK_PIXELS = 4;

export interface MoveArgs {
  readonly ids: readonly ElementId[];
  readonly dx: number;
  readonly dy: number;
}

function isMoveArgs(args: unknown): args is MoveArgs {
  const a = args as Partial<MoveArgs> | null | undefined;
  return (
    Array.isArray(a?.ids) &&
    a.ids.length > 0 &&
    Number.isFinite(a.dx) &&
    Number.isFinite(a.dy)
  );
}

/** Moves elements by an offset, all in one transaction. */
const move = defineCommand<MoveArgs, void>({
  name: "move",
  label: label("select.move"),
  quick: true,
  enabled: (_ctx, args) => isMoveArgs(args),
  execute(ctx, { ids, dx, dy }) {
    const r = new Resolver(yLookup(ctx.doc));
    // Containers have translation-only spaces, so the offset is the same in each.
    const targets = ids.map((id) => ({ id, at: r.localPosition(id) }));
    edit(ctx.doc, () => {
      for (const { id, at } of targets) moveElement(ctx.doc, id, at.x + dx, at.y + dy);
    });
  },
});

export interface ScaleArgs {
  readonly ids: readonly ElementId[];
  /** Fixed point of the scaling, in root space. */
  readonly anchor: Point;
  readonly factor: number;
}

/**
 * Scales elements, groups included, keeping proportions. Elements that may not
 * be resized (from a missing extension) move with the others and keep their
 * size.
 */
const scale = defineCommand<ScaleArgs, void>({
  name: "scale",
  label: label("select.scale"),
  quick: true,
  enabled: (_ctx, a) =>
    a !== undefined && a.ids.length > 0 && Number.isFinite(a.factor) && a.factor > 0,
  execute: (ctx, a) => applyScale(ctx, planScale(ctx, a.ids, a.anchor, a.factor)),
});

/** Selects every selectable element. Changes no document content. */
const selectAll = defineCommand<undefined, void>({
  name: "all",
  label: label("select.all"),
  shortcuts: ["Mod+A"],
  quick: true,
  undoable: false,
  execute(ctx) {
    const everywhere = { x: -1e15, y: -1e15, w: 2e15, h: 2e15 };
    ctx.services.selection.set(ctx.services.scene.elementsIn(everywhere, "touching"));
  },
});

function union(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * The offset adjusted so that the moved selection's left and top edges land on
 * another element's left or top edge when they come within the snap distance.
 */
function snap(
  ctx: Pick<CommandContext, "services">,
  moving: readonly ElementId[],
  box: Rect,
  dx: number,
  dy: number,
  tolerance: number,
): { dx: number; dy: number } {
  const scene = ctx.services.scene;
  let bestX: number | undefined;
  let bestY: number | undefined;
  for (const id of scene.visible()) {
    if (moving.includes(id)) continue;
    const other = scene.bounds(id);
    if (other === null) continue;
    const ox = other.x - (box.x + dx);
    const oy = other.y - (box.y + dy);
    if (
      Math.abs(ox) <= tolerance &&
      (bestX === undefined || Math.abs(ox) < Math.abs(bestX))
    )
      bestX = ox;
    if (
      Math.abs(oy) <= tolerance &&
      (bestY === undefined || Math.abs(oy) < Math.abs(bestY))
    )
      bestY = oy;
  }
  return { dx: dx + (bestX ?? 0), dy: dy + (bestY ?? 0) };
}

type Drag =
  | {
      readonly kind: "move";
      readonly start: ToolPointerEvent;
      readonly gesture: Gesture;
      readonly ids: readonly ElementId[];
      readonly box: Rect;
      offset: { dx: number; dy: number };
    }
  | {
      readonly kind: "band";
      readonly start: ToolPointerEvent;
      current: Point;
      readonly add: boolean;
    };

function selectTool(session: ToolSession): ToolHandler {
  let drag: Drag | null = null;
  const env = () => session.environment();

  const placementsPreview = (ids: readonly ElementId[], dx: number, dy: number) => {
    const scene = env().services.scene;
    const out: Record<string, { x: number; y: number }> = {};
    for (const id of ids) {
      const p = scene.placement(id);
      if (p) out[id] = { x: p.x + dx, y: p.y + dy };
    }
    return out;
  };

  const bandRect = (a: Point, b: Point): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  });

  return {
    pointerDown(event) {
      if (event.button !== 0) return;
      const { services } = env();
      const hit = services.scene.elementAt(event.world, PICK_PIXELS / session.scale());
      const selected = services.selection.get();
      if (hit === null) {
        if (!event.modifiers.shift) services.selection.set([]);
        drag = {
          kind: "band",
          start: event,
          current: event.world,
          add: event.modifiers.shift,
        };
        return;
      }
      if (event.modifiers.shift) {
        services.selection.set(
          selected.includes(hit)
            ? selected.filter((id) => id !== hit)
            : [...selected, hit],
        );
        return;
      }
      const ids = selected.includes(hit) ? selected : [hit];
      services.selection.set(ids);
      const box = union(
        ids.map((id) => services.scene.bounds(id)).filter((b): b is Rect => b !== null),
      );
      if (box === null) return;
      drag = {
        kind: "move",
        start: event,
        gesture: session.gesture(),
        ids,
        box,
        offset: { dx: 0, dy: 0 },
      };
    },
    pointerMove(event) {
      if (drag === null) return;
      if (drag.kind === "band") {
        drag.current = event.world;
        session.requestOverlay();
        return;
      }
      const dx = event.world.x - drag.start.world.x;
      const dy = event.world.y - drag.start.world.y;
      drag.offset = event.modifiers.alt
        ? { dx, dy }
        : snap(env(), drag.ids, drag.box, dx, dy, SNAP_PIXELS / session.scale());
      drag.gesture.preview(placementsPreview(drag.ids, drag.offset.dx, drag.offset.dy));
    },
    pointerUp(event) {
      if (drag === null) return;
      const d = drag;
      drag = null;
      if (d.kind === "band") {
        session.requestOverlay();
        const scene = env().services.scene;
        const found = scene.elementsIn(bandRect(d.start.world, event.world), "touching");
        const selection = env().services.selection;
        selection.set(d.add ? [...new Set([...selection.get(), ...found])] : found);
        return;
      }
      const moved = Math.hypot(
        event.screen.x - d.start.screen.x,
        event.screen.y - d.start.screen.y,
      );
      if (moved < CLICK_SLOP) d.gesture.cancel();
      else d.gesture.commit(SELECT_MOVE, { ids: d.ids, ...d.offset });
    },
    pointerCancel() {
      if (drag?.kind === "move") drag.gesture.cancel();
      drag = null;
      session.requestOverlay();
    },
    keyDown(event) {
      if (event.key !== "Escape" || drag === null) return false;
      if (drag.kind === "move") drag.gesture.cancel();
      drag = null;
      session.requestOverlay();
      return true;
    },
    drawOverlay(ctx) {
      if (drag?.kind !== "band") return;
      const r = bandRect(drag.start.world, drag.current);
      const px = 1 / ctx.scale;
      const path = ctx.createPath();
      path.rect(r.x, r.y, r.w, r.h);
      ctx.stroke(path, { color: "#2563eb", width: px, dash: [4 * px, 4 * px] });
    },
    stop() {
      if (drag?.kind === "move") drag.gesture.cancel();
      drag = null;
    },
  };
}

export const selectViewExtension = defineViewExtension({
  id: SELECT_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
});

export const selectExtension = defineEditExtension({
  view: selectViewExtension,
  contributes: {
    commands: [move, scale, selectAll],
    tools: [
      {
        name: "select",
        label: label("select.tool"),
        shortcuts: ["v"],
        quick: true,
        group: "select",
        cursor: "default",
        start: selectTool,
      },
    ],
  },
});
