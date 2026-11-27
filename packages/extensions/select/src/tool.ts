// SPDX-License-Identifier: GPL-3.0-or-later

// The selection tool (docs/adr/0008-selection.md), written against the editor
// services and the basics' commands like any extension:
//
// - Click selects (the outermost group, as the editor's hit test decides);
//   Shift-click adds or removes; a drag across empty canvas selects what the
//   band touches (with Shift, in addition). Locked elements are passed over.
// - Dragging the selection moves it; Shift keeps the move horizontal or
//   vertical. Corner handles scale with proportions kept (Alt: about the
//   centre; Shift: a free resize of a single element); side handles resize a
//   single element along one axis; the handle above the box rotates (Shift: in
//   steps of 15 degrees).
// - A drag previews its result through a gesture and ends in one command: one
//   undo step, nothing written before it ends. Escape cancels it.
// - A handle is shown only where its command would be accepted, so locked
//   elements get none, elements of a missing extension can be moved but not
//   scaled, and groups and frames are not rotated.
// - Arrow keys nudge the selection by one screen pixel (Shift: ten); Escape
//   with nothing to cancel clears the selection.
// - Frames (docs/adr/0014-stacking-and-frames.md): a frame's name above it
//   takes the frame; a click on its background selects it and a drag moves
//   it, as any element; with Shift, a drag on its background draws a band
//   among what is in it. A drag of the selection let go over a frame moves
//   it into the frame, and let go outside its frame moves it out.

import { Resolver, type ElementId, type Point, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import {
  LockedError,
  planScale,
  type Cursor,
  type DrawContext,
  type ElementPlacement,
  type Gesture,
  type PreviewChanges,
  type ToolHandler,
  type ToolPointerEvent,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import { BASICS, isFrame } from "@galatsa/extension-basics";
import {
  dropBox,
  dropFrames,
  dropTarget,
  labelAt,
  shownFrames,
  type DropFrame,
  type ShownFrame,
} from "./frames.ts";
import {
  CORNERS,
  SIDES,
  angleAbout,
  boxFromRect,
  fromBox,
  handleAt,
  handlePoint,
  insideBox,
  normalizeAngle,
  resizeCursor,
  resizedBox,
  scaleFactor,
  snapAngle,
  union,
  type Box,
  type Handle,
} from "./geometry.ts";

// Distances in CSS pixels on screen, whatever the zoom.
/** A press that moves less than this is a click. */
export const CLICK_SLOP = 3;
/** How far from an element a click still hits it. */
const PICK = 4;
/** The side of a drawn handle. */
export const HANDLE_SIZE = 8;
/** How far from a handle's centre a press still takes it. */
export const HANDLE_REACH = 7;
/** How far above the box the rotation handle stands. */
export const ROTATE_LIFT = 24;
/**
 * Handles stand on the box enlarged to at least this size on screen in each
 * direction: on a small or flat box (a line) they stand outside it, so a
 * press on the element itself moves it.
 */
export const HANDLE_FRAME_MIN = 28;
/** The smallest size a resize or scaling leaves, on screen. */
const MIN_SIZE = 2;
/** Rotation steps with Shift. */
export const ROTATE_STEP = Math.PI / 12;
/** Arrow keys nudge by this much, with Shift by ten times as much. */
const NUDGE = 1;

const COLOR = "#2563eb";
const HANDLE_FILL = "#ffffff";

/** The selection as the handles see it, worked out once per selection and document state. */
interface Frame {
  readonly ids: readonly ElementId[];
  readonly box: Box;
  /** The selected element when one element with a size (not a group) is selected. */
  readonly single: { readonly id: ElementId; readonly at: ElementPlacement } | null;
  readonly move: boolean;
  readonly scale: boolean;
  readonly resize: boolean;
  readonly rotate: boolean;
}

interface Placed {
  readonly id: ElementId;
  readonly at: ElementPlacement;
}

type Drag =
  | {
      readonly kind: "move";
      readonly start: ToolPointerEvent;
      readonly items: readonly Placed[];
      readonly ids: readonly ElementId[];
      /** A selected element that was clicked: a click without a move selects it alone. */
      readonly clicked: ElementId | null;
      gesture: Gesture | null;
      offset: Point;
      /** The frames the selection can be dropped into, found when the drag starts. */
      frames: readonly DropFrame[];
      /** The containers the moved elements are seen in now. */
      readonly from: ReadonlySet<ElementId | null>;
      /** The container a drop here moves them into; undefined: they stay where they are. */
      target: ElementId | null | undefined;
    }
  | {
      readonly kind: "band";
      readonly start: ToolPointerEvent;
      current: Point;
      readonly add: boolean;
      /**
       * A band drawn with Shift from a frame's background selects among what
       * is in the frame, adding to the selection; a Shift-click there (no
       * drag) adds or removes the frame.
       */
      readonly within?: ElementId;
    }
  | {
      readonly kind: "corner";
      readonly start: ToolPointerEvent;
      readonly gesture: Gesture;
      readonly frame: Frame;
      readonly handle: { readonly u: -1 | 1; readonly v: -1 | 1 };
      /** What the pointer does now: scale the selection, or resize the one element (Shift). */
      result:
        | { readonly kind: "scale"; readonly anchor: Point; readonly factor: number }
        | { readonly kind: "resize"; readonly args: ResizeResult }
        | null;
    }
  | {
      readonly kind: "side";
      readonly start: ToolPointerEvent;
      readonly gesture: Gesture;
      readonly frame: Frame;
      readonly handle: { readonly u: -1 | 0 | 1; readonly v: -1 | 0 | 1 };
      result: ResizeResult | null;
    }
  | {
      readonly kind: "rotate";
      readonly start: ToolPointerEvent;
      readonly gesture: Gesture;
      readonly frame: Frame;
      readonly items: readonly Placed[];
      readonly pivot: Point;
      readonly from: number;
      by: number;
    };

/** A resize of the one selected element: the command's arguments. */
interface ResizeResult {
  readonly id: ElementId;
  readonly w: number;
  readonly h: number;
  /** The new corner in the space of the container the user sees it in. */
  readonly x: number;
  readonly y: number;
  /** The same corner in the element's own parent space (a dissolved group's, say), for the preview. */
  readonly px: number;
  readonly py: number;
}

function bandRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function touches(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** The resize command's arguments. */
function resizeArgs(r: ResizeResult) {
  return { id: r.id, w: r.w, h: r.h, x: r.x, y: r.y };
}

/** The ids that are not inside another of them (a preview of both would move the inner one twice). */
function outermost(r: Resolver, ids: readonly ElementId[]): ElementId[] {
  const chosen = new Set(ids);
  return ids.filter((id) => {
    for (let at = r.parentOf(id); at !== null; at = r.parentOf(at))
      if (chosen.has(at)) return false;
    return true;
  });
}

export function startSelectTool(session: ToolSession): ToolHandler {
  const env = () => session.environment();
  const services = () => env().services;
  /** CSS pixels per root unit. */
  const zoom = (): number => services().camera.get().zoom;
  const resolver = (): Resolver => new Resolver(yLookup(env().doc));

  // The frame is worked out again when the selection, the document or the mode changes.
  const doc = env().doc;
  let docVersion = 0;
  const bump = (): void => {
    docVersion++;
  };
  doc.on("update", bump);
  let cached: {
    readonly selection: readonly ElementId[];
    readonly doc: number;
    readonly mode: string;
    readonly frame: Frame | null;
  } | null = null;

  const computeFrame = (): Frame | null => {
    const { scene, selection } = services();
    const items: Placed[] = [];
    for (const id of selection.get()) {
      const at = scene.placement(id);
      if (at !== null) items.push({ id, at });
    }
    if (items.length === 0) return null;
    const ids = items.map((item) => item.id);
    let box: Box;
    let single: Frame["single"] = null;
    const only = items.length === 1 ? items[0]! : null;
    if (only !== null && (only.at.w > 0 || only.at.h > 0)) {
      const at = only.at;
      box = {
        cx: at.worldX + at.w / 2,
        cy: at.worldY + at.h / 2,
        w: at.w,
        h: at.h,
        rot: at.rot,
      };
      single = only;
    } else {
      const rect = union(
        ids.map((id) => scene.bounds(id)).filter((b): b is Rect => b !== null),
      );
      if (rect === null) return null;
      box = boxFromRect(rect);
    }
    const centre = { x: box.cx, y: box.cy };
    return {
      ids,
      box,
      single,
      move: session.isEnabled(BASICS.move, { ids, dx: 1, dy: 0 }),
      scale: session.isEnabled(BASICS.scale, { ids, anchor: centre, factor: 2 }),
      resize:
        single !== null &&
        session.isEnabled(BASICS.resize, {
          id: single.id,
          w: single.at.w,
          h: single.at.h,
        }),
      rotate: session.isEnabled(
        BASICS.rotate,
        single !== null ? { ids, by: 1 } : { ids, by: 1, about: centre },
      ),
    };
  };

  const frame = (): Frame | null => {
    const selection = services().selection.get();
    const mode = services().mode.get();
    if (
      cached === null ||
      cached.selection !== selection ||
      cached.doc !== docVersion ||
      cached.mode !== mode
    )
      cached = { selection, doc: docVersion, mode, frame: computeFrame() };
    return cached.frame;
  };

  /** The handles a frame offers. */
  const handlesOf = (f: Frame): Handle[] => {
    const out: Handle[] = [];
    if (f.scale) out.push(...CORNERS);
    // The handle frame is at least HANDLE_FRAME_MIN on screen, so side
    // handles never crowd the corners.
    if (f.resize) out.push(...SIDES);
    if (f.rotate) out.push({ kind: "rotate" });
    return out;
  };

  /** The box the handles stand on: the selection's, at least HANDLE_FRAME_MIN on screen. */
  const handleFrame = (f: Frame): Box => {
    const least = HANDLE_FRAME_MIN / zoom();
    return { ...f.box, w: Math.max(f.box.w, least), h: Math.max(f.box.h, least) };
  };

  const handleUnder = (f: Frame, p: Point): Handle | null => {
    const k = zoom();
    return handleAt(handleFrame(f), handlesOf(f), p, HANDLE_REACH / k, ROTATE_LIFT / k);
  };

  const placed = (ids: readonly ElementId[]): Placed[] => {
    const scene = services().scene;
    const out: Placed[] = [];
    for (const id of ids) {
      const at = scene.placement(id);
      if (at !== null) out.push({ id, at });
    }
    return out;
  };

  let drag: Drag | null = null;
  let cursor: Cursor | null = null;
  const setCursor = (next: Cursor): void => {
    if (next === cursor) return;
    cursor = next;
    session.setCursor(next);
  };

  const endDrag = (cancel: boolean): void => {
    const d = drag;
    drag = null;
    if (d !== null && cancel && d.kind !== "band") d.gesture?.cancel();
    session.requestOverlay();
  };

  // -------------------------------------------------------------------------
  // Starting a drag
  // -------------------------------------------------------------------------

  const startHandle = (event: ToolPointerEvent, f: Frame, handle: Handle): void => {
    const gesture = session.gesture();
    if (handle.kind === "corner") {
      drag = { kind: "corner", start: event, gesture, frame: f, handle, result: null };
    } else if (handle.kind === "side") {
      drag = { kind: "side", start: event, gesture, frame: f, handle, result: null };
    } else {
      const pivot = { x: f.box.cx, y: f.box.cy };
      drag = {
        kind: "rotate",
        start: event,
        gesture,
        frame: f,
        items: placed(f.ids),
        pivot,
        from: angleAbout(pivot, event.world),
        by: 0,
      };
      setCursor("grabbing");
    }
  };

  const startMove = (
    event: ToolPointerEvent,
    ids: readonly ElementId[],
    clicked: ElementId | null,
  ): void => {
    const r = resolver();
    const moving = outermost(r, ids);
    drag = {
      kind: "move",
      start: event,
      items: placed(moving),
      ids,
      clicked,
      gesture: null,
      offset: { x: 0, y: 0 },
      frames: [],
      from: new Set(moving.map((id) => r.logicalParentOf(id))),
      target: undefined,
    };
  };

  // The frames on screen, for their names, worked out again when the
  // document or the camera changes.
  let shown: {
    readonly doc: number;
    readonly camera: unknown;
    readonly frames: readonly ShownFrame[];
  } | null = null;
  const framesShown = (): readonly ShownFrame[] => {
    const camera = services().camera.get();
    if (shown === null || shown.doc !== docVersion || shown.camera !== camera)
      shown = { doc: docVersion, camera, frames: shownFrames(services(), doc) };
    return shown.frames;
  };

  /**
   * The frame whose name is under a point, where nothing but a frame's
   * background (or nothing) is hit there: an element on top of a name wins.
   */
  const nameUnder = (point: Point, hit: ElementId | null): ElementId | null => {
    const r = resolver();
    if (hit !== null && !isFrame(r, hit)) return null;
    const id = labelAt(framesShown(), point, zoom());
    return id === null || r.isLocked(id) ? null : id;
  };

  // -------------------------------------------------------------------------
  // Following the pointer
  // -------------------------------------------------------------------------

  const moveTo = (d: Extract<Drag, { kind: "move" }>, event: ToolPointerEvent): void => {
    const far = Math.hypot(
      event.screen.x - d.start.screen.x,
      event.screen.y - d.start.screen.y,
    );
    if (d.gesture === null) {
      if (far < CLICK_SLOP) return;
      d.gesture = session.gesture();
      d.frames = dropFrames(
        doc,
        d.items.map((item) => item.id),
      );
      setCursor("move");
    }
    let dx = event.world.x - d.start.world.x;
    let dy = event.world.y - d.start.world.y;
    if (event.modifiers.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    d.offset = { x: dx, y: dy };
    // Let go here, the selection goes into the frame under the pointer, or
    // out to the canvas (docs/adr/0014); where all of it is seen already, it
    // stays.
    const target = dropTarget(d.frames, event.world);
    const into = d.from.size !== 1 || !d.from.has(target) ? target : undefined;
    if (into !== d.target) {
      d.target = into;
      session.requestOverlay();
    }
    const changes: Record<ElementId, { x: number; y: number }> = {};
    for (const { id, at } of d.items) changes[id] = { x: at.x + dx, y: at.y + dy };
    d.gesture.preview(changes);
  };

  const scaleTo = (
    d: Extract<Drag, { kind: "corner" }>,
    event: ToolPointerEvent,
  ): void => {
    const f = d.frame;
    const { u, v } = d.handle;
    if (event.modifiers.shift && f.resize && f.single !== null) {
      const args = resizeTo(f, u, v, d.start, event);
      d.result = { kind: "resize", args };
      d.gesture.preview(resizePreview(args));
      return;
    }
    const corner = fromBox(f.box, { x: (u * f.box.w) / 2, y: (v * f.box.h) / 2 });
    const anchor = event.modifiers.alt
      ? { x: f.box.cx, y: f.box.cy }
      : fromBox(f.box, { x: (-u * f.box.w) / 2, y: (-v * f.box.h) / 2 });
    const longest = Math.max(f.box.w, f.box.h);
    const min = longest > 0 ? MIN_SIZE / zoom() / longest : 1e-9;
    // The corner follows the pointer from where it was taken.
    const to = {
      x: corner.x + event.world.x - d.start.world.x,
      y: corner.y + event.world.y - d.start.world.y,
    };
    const factor = scaleFactor(anchor, corner, to, min);
    d.result = { kind: "scale", anchor, factor };
    let steps;
    try {
      steps = planScale(
        { doc: env().doc, extensions: session.extensions },
        f.ids,
        anchor,
        factor,
      );
    } catch (error) {
      if (error instanceof LockedError) return;
      throw error;
    }
    const changes: Record<ElementId, { x: number; y: number; w?: number; h?: number }> =
      {};
    for (const step of steps)
      changes[step.id] =
        step.w !== undefined && step.h !== undefined
          ? { x: step.x, y: step.y, w: step.w, h: step.h }
          : { x: step.x, y: step.y };
    d.gesture.preview(changes);
  };

  /** The resize of the one selected element that the pointer asks for. */
  const resizeTo = (
    f: Frame,
    u: -1 | 0 | 1,
    v: -1 | 0 | 1,
    start: ToolPointerEvent,
    event: ToolPointerEvent,
  ): ResizeResult => {
    const single = f.single!;
    // The handle follows the pointer from where it was taken.
    const handle = fromBox(f.box, { x: (u * f.box.w) / 2, y: (v * f.box.h) / 2 });
    const next = resizedBox(
      f.box,
      u,
      v,
      {
        x: handle.x + event.world.x - start.world.x,
        y: handle.y + event.world.y - start.world.y,
      },
      MIN_SIZE / zoom(),
      event.modifiers.alt,
    );
    // The stored corner is that of the unturned box, in the parent's space;
    // the box turns about its centre, so the corner follows the centre.
    const x = single.at.x + (next.cx - f.box.cx) - (next.w - f.box.w) / 2;
    const y = single.at.y + (next.cy - f.box.cy) - (next.h - f.box.h) / 2;
    // The command takes the corner in the space of the container the user
    // sees the element in (not a dissolved group it is stored in).
    const r = resolver();
    const d = r.offset(r.parentOf(single.id), r.logicalParentOf(single.id));
    return { id: single.id, w: next.w, h: next.h, x: x + d.x, y: y + d.y, px: x, py: y };
  };

  /** The preview of a resize: the corner in the element's own parent space. */
  const resizePreview = (args: ResizeResult): PreviewChanges => ({
    [args.id]: { x: args.px, y: args.py, w: args.w, h: args.h },
  });

  const rotateTo = (
    d: Extract<Drag, { kind: "rotate" }>,
    event: ToolPointerEvent,
  ): void => {
    let by = normalizeAngle(angleAbout(d.pivot, event.world) - d.from);
    const single = d.frame.single;
    if (event.modifiers.shift) {
      if (single !== null)
        by = snapAngle(single.at.rot + by, ROTATE_STEP) - single.at.rot;
      else by = snapAngle(by, ROTATE_STEP);
    }
    d.by = by;
    const cos = Math.cos(by);
    const sin = Math.sin(by);
    const changes: Record<ElementId, { x?: number; y?: number; rot: number }> = {};
    for (const { id, at } of d.items) {
      if (single !== null) {
        changes[id] = { rot: at.rot + by };
        continue;
      }
      const cx = at.worldX + at.w / 2 - d.pivot.x;
      const cy = at.worldY + at.h / 2 - d.pivot.y;
      const nx = cx * cos - cy * sin;
      const ny = cx * sin + cy * cos;
      changes[id] = { x: at.x + nx - cx, y: at.y + ny - cy, rot: at.rot + by };
    }
    d.gesture.preview(changes);
  };

  const hover = (event: ToolPointerEvent): void => {
    const f = frame();
    if (f !== null) {
      const handle = handleUnder(f, event.world);
      if (handle !== null) {
        setCursor(handle.kind === "rotate" ? "grab" : resizeCursor(handle, f.box.rot));
        return;
      }
    }
    const scene = services().scene;
    const hit = scene.elementAt(event.world, PICK / zoom());
    const overSelection =
      f !== null &&
      f.move &&
      (hit === null ? insideBox(f.box, event.world) : f.ids.includes(hit));
    const overName = nameUnder(event.world, hit) !== null;
    setCursor(hit !== null || overSelection || overName ? "move" : "default");
  };

  /** Follows the pointer during a drag. */
  const follow = (d: Drag, event: ToolPointerEvent): void => {
    switch (d.kind) {
      case "band":
        d.current = event.world;
        session.requestOverlay();
        return;
      case "move":
        moveTo(d, event);
        return;
      case "corner":
        scaleTo(d, event);
        return;
      case "side": {
        const args = resizeTo(d.frame, d.handle.u, d.handle.v, d.start, event);
        d.result = args;
        d.gesture.preview(resizePreview(args));
        return;
      }
      case "rotate":
        rotateTo(d, event);
        return;
    }
  };

  // -------------------------------------------------------------------------
  // The handler
  // -------------------------------------------------------------------------

  return {
    pointerDown(event) {
      if (event.button !== 0) return;
      if (drag !== null) endDrag(true);
      const s = services();
      const selection = s.selection.get();
      const f = frame();
      // A handle comes first, also with Shift (a free resize from a corner).
      if (f !== null) {
        const handle = handleUnder(f, event.world);
        if (handle !== null) {
          startHandle(event, f, handle);
          return;
        }
      }
      const found = s.scene.elementAt(event.world, PICK / zoom());
      // A frame's name above it is a handle: it takes the frame, whatever
      // else is behind it (an element on top of the name wins).
      const name = nameUnder(event.world, found);
      const hit = name ?? found;
      /** The press is on a frame's background (not its name, nor an element in it). */
      const background = hit !== null && name === null && isFrame(resolver(), hit);
      if (event.modifiers.shift) {
        // On a frame's background, a drag draws a band among what is in the
        // frame, adding to the selection; a click adds or removes the frame.
        if (background) {
          drag = {
            kind: "band",
            start: event,
            current: event.world,
            add: true,
            within: hit,
          };
          return;
        }
        if (hit !== null) {
          s.selection.set(
            selection.includes(hit)
              ? selection.filter((id) => id !== hit)
              : [...selection, hit],
          );
          return;
        }
        drag = { kind: "band", start: event, current: event.world, add: true };
        return;
      }
      const already = hit !== null && selection.includes(hit);
      // Between the elements of a selection, on the background of a frame
      // they are in, the selection is moved, as on the canvas.
      if (
        background &&
        !already &&
        f !== null &&
        f.move &&
        insideBox(f.box, event.world)
      ) {
        startMove(event, f.ids, null);
        return;
      }
      if (hit !== null) {
        const ids = already ? selection : [hit];
        if (!already) s.selection.set(ids);
        if (session.isEnabled(BASICS.move, { ids: [...ids], dx: 1, dy: 0 }))
          startMove(event, ids, already && selection.length > 1 ? hit : null);
        return;
      }
      if (f !== null && f.move && insideBox(f.box, event.world)) {
        startMove(event, f.ids, null);
        return;
      }
      s.selection.set([]);
      drag = { kind: "band", start: event, current: event.world, add: false };
    },

    pointerMove(event) {
      const d = drag;
      if (d === null) {
        hover(event);
        return;
      }
      follow(d, event);
    },

    pointerUp(event) {
      const d = drag;
      if (d === null) return;
      // Where the pointer was let go counts, also without a move event there;
      // a handle pressed and let go without moving changes nothing.
      const still =
        Math.hypot(event.screen.x - d.start.screen.x, event.screen.y - d.start.screen.y) <
        CLICK_SLOP;
      if (still && d.kind !== "band" && d.kind !== "move") {
        endDrag(true);
        hover(event);
        return;
      }
      follow(d, event);
      drag = null;
      session.requestOverlay();
      switch (d.kind) {
        case "band": {
          const s = services();
          // A Shift-click on a frame's background adds or removes the frame.
          // A click on empty canvas is not a band: it would select what only
          // the bounding box of a turned or round element covers.
          if (still) {
            const id = d.within;
            if (id !== undefined) {
              const now = s.selection.get();
              s.selection.set(
                now.includes(id) ? now.filter((other) => other !== id) : [...now, id],
              );
            }
            return;
          }
          const r = resolver();
          const rect = bandRect(d.start.world, event.world);
          const found = (
            d.within === undefined
              ? s.scene.elementsIn(rect, "touching")
              : r.logicalChildren(d.within).filter((id) => {
                  const b = s.scene.bounds(id);
                  return b !== null && touches(rect, b);
                })
          ).filter((id) => !r.isLocked(id));
          s.selection.set(d.add ? [...s.selection.get(), ...found] : found);
          return;
        }
        case "move":
          if (d.gesture === null) {
            if (d.clicked !== null) services().selection.set([d.clicked]);
            return;
          }
          d.gesture.commit(BASICS.move, {
            ids: [...d.ids],
            dx: d.offset.x,
            dy: d.offset.y,
            ...(d.target !== undefined ? { target: d.target } : {}),
          });
          break;
        case "corner":
          if (d.result === null) d.gesture.cancel();
          else if (d.result.kind === "scale")
            d.gesture.commit(BASICS.scale, {
              ids: [...d.frame.ids],
              anchor: d.result.anchor,
              factor: d.result.factor,
            });
          else d.gesture.commit(BASICS.resize, resizeArgs(d.result.args));
          break;
        case "side":
          if (d.result === null) d.gesture.cancel();
          else d.gesture.commit(BASICS.resize, resizeArgs(d.result));
          break;
        case "rotate":
          if (d.by === 0) d.gesture.cancel();
          else
            d.gesture.commit(
              BASICS.rotate,
              d.frame.single !== null
                ? { ids: [...d.frame.ids], by: d.by }
                : { ids: [...d.frame.ids], by: d.by, about: d.pivot },
            );
          break;
      }
      hover(event);
    },

    pointerCancel() {
      endDrag(true);
    },

    keyDown(event) {
      if (event.key === "Escape") {
        if (drag !== null) {
          endDrag(true);
          return true;
        }
        if (services().selection.get().length > 0) {
          services().selection.set([]);
          return true;
        }
        return false;
      }
      if (drag !== null || event.modifiers.mod || event.modifiers.alt) return false;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const arrow = arrows[event.key];
      const ids = services().selection.get();
      if (arrow === undefined || ids.length === 0) return false;
      const step = (NUDGE * (event.modifiers.shift ? 10 : 1)) / zoom();
      session.run(BASICS.move, {
        ids: [...ids],
        dx: arrow[0] * step,
        dy: arrow[1] * step,
      });
      return true;
    },

    drawOverlay(ctx) {
      const k = zoom();
      const px = 1 / k;
      if (drag?.kind === "band") {
        const r = bandRect(drag.start.world, drag.current);
        const path = ctx.createPath();
        path.rect(r.x, r.y, r.w, r.h);
        ctx.fill(path, "rgba(37, 99, 235, 0.08)");
        ctx.stroke(path, { color: COLOR, width: px, dash: [4 * px, 4 * px] });
        return;
      }
      // The frame a drop would move the selection into.
      if (drag?.kind === "move" && drag.target !== undefined && drag.target !== null) {
        const box = dropBox(drag.frames, drag.target);
        if (box !== null) {
          const path = ctx.createPath();
          path.rect(box.x, box.y, box.w, box.h);
          ctx.stroke(path, { color: COLOR, width: 2 * px });
        }
      }
      // While a handle or the selection is dragged, the editor's outline
      // follows the preview; the handles come back when it ends.
      if (drag !== null && (drag.kind !== "move" || drag.gesture !== null)) return;
      const f = frame();
      if (f === null) return;
      const box = f.box;
      if (f.ids.length > 1 || f.single === null) {
        const outline = ctx.createPath();
        CORNERS.forEach((corner, i) => {
          const at = handlePoint(box, corner, 0);
          if (i === 0) outline.moveTo(at.x, at.y);
          else outline.lineTo(at.x, at.y);
        });
        outline.closePath();
        ctx.stroke(outline, { color: COLOR, width: px, dash: [3 * px, 3 * px] });
      }
      const handles = handlesOf(f);
      const half = HANDLE_SIZE / 2 / k;
      const around = handleFrame(f);
      for (const handle of handles) {
        const at = handlePoint(around, handle, ROTATE_LIFT / k);
        const path = ctx.createPath();
        if (handle.kind === "rotate") {
          const top = handlePoint(around, { kind: "side", u: 0, v: -1 }, 0);
          const stem = ctx.createPath();
          stem.moveTo(top.x, top.y);
          stem.lineTo(at.x, at.y);
          ctx.stroke(stem, { color: COLOR, width: px });
          path.arc(at.x, at.y, half, 0, 2 * Math.PI);
        } else {
          path.rect(at.x - half, at.y - half, 2 * half, 2 * half);
        }
        ctx.fill(path, HANDLE_FILL);
        ctx.stroke(path, { color: COLOR, width: 1.5 * px });
      }
    },

    stop() {
      if (drag !== null && drag.kind !== "band") drag.gesture?.cancel();
      drag = null;
      doc.off("update", bump);
    },
  } satisfies ToolHandler & { drawOverlay(ctx: DrawContext): void };
}
