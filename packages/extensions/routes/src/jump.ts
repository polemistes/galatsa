// SPDX-License-Identifier: GPL-3.0-or-later

// Jumping the editor's camera to a stop, with the stop's transition from the
// built-in transitions (fly, fade, cut; docs/adr/0005, section 7.1) under the
// comfort guard. The editor has no cross-fade, so a fade shows the start
// until half way and then the goal; with reduced motion the guard makes every
// transition such a fade, so the camera never shows other views. Presenting
// is the player's (packages/player); this is only for finding one's way
// while editing.
//
// A jump runs on animation frames after the command that started it has
// returned (it changes only the camera, which is not document content). It
// stops when the camera is moved by anything else (the user scrolls, another
// jump starts), so the user can always take over.

import {
  Resolver,
  type CameraView,
  type ElementId,
  type Json,
  type Region,
} from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import {
  contributionId,
  guardComfort,
  readTransitionValue,
  type AnyTransition,
  type CameraMotion,
  type ComfortSettings,
} from "@galatsa/extension-api";
import type { EditorServices } from "@galatsa/extension-api/editing";
import {
  DEFAULT_COMFORT_PREFERENCES,
  REDUCED_MOTION_QUERY,
  TRANSITIONS_EXTENSION_ID,
  cut,
  fade,
  fly,
  resolveComfort,
} from "@galatsa/extension-transitions";
import type * as Y from "yjs";
import { cameraForRegion, screenOf } from "./model.ts";

/** Calls `frame` before the next repaint; returns how to cancel. */
export type FrameScheduler = (frame: () => void) => () => void;

/** What a jump needs from its surroundings; the defaults are the browser's. */
export interface JumpEnvironment {
  /** Null: no animation frames here (jump at once). */
  readonly schedule: FrameScheduler | null;
  /** Milliseconds, from any fixed start. */
  now(): number;
  readonly comfort: ComfortSettings;
}

const BUILT_IN: ReadonlyMap<string, AnyTransition> = new Map(
  [fly, fade, cut].map((t) => [
    contributionId(TRANSITIONS_EXTENSION_ID, t.name),
    t as AnyTransition,
  ]),
);

type Browserish = {
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  matchMedia?: (query: string) => { matches: boolean };
  performance?: { now(): number };
};

/** The browser's animation frames, clock and "reduce motion" setting, where there are any. */
export function browserJumpEnvironment(): JumpEnvironment {
  const g = globalThis as Browserish;
  const raf = g.requestAnimationFrame;
  const caf = g.cancelAnimationFrame;
  let reduced: boolean;
  try {
    reduced = g.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
  } catch {
    reduced = false;
  }
  return {
    schedule:
      typeof raf === "function"
        ? (frame) => {
            const id = raf(frame);
            return () => caf?.(id);
          }
        : null,
    now: () => g.performance?.now() ?? Date.now(),
    comfort: resolveComfort(DEFAULT_COMFORT_PREFERENCES, reduced),
  };
}

/** The containers from `space` up to the root (null last). */
function chain(r: Resolver, space: ElementId | null): (ElementId | null)[] {
  const out: (ElementId | null)[] = [];
  const seen = new Set<ElementId>();
  for (let at = space; at !== null && !seen.has(at); at = r.parentOf(at)) {
    seen.add(at);
    out.push(at);
  }
  out.push(null);
  return out;
}

/** A view carried into another space (exact: the offset is through their lowest common ancestor). */
function inSpace(
  services: EditorServices,
  view: CameraView,
  space: ElementId | null,
): CameraView {
  if (view.space === space) return view;
  const o = services.scene.offset(view.space, space);
  return { space, cx: view.cx + o.x, cy: view.cy + o.y, zoom: view.zoom };
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.space === b.space && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}

/** Jumps running per camera service (one editor), so a new one stops the last. */
const running = new WeakMap<object, () => void>();

/** Stops a running jump of this editor, if any; the camera stays where it is. */
export function stopJump(services: EditorServices): void {
  running.get(services.camera)?.();
}

/**
 * Plans a jump: the camera that shows the region, and the motion there from
 * the camera now, both in the space of the lowest common ancestor of the two
 * views' spaces (so a jump between stops deep in nested frames stays exact).
 */
export function planJump(
  doc: Y.Doc,
  services: EditorServices,
  region: Region,
  transition: Json,
  comfort: ComfortSettings,
): { readonly goal: CameraView; readonly motion: CameraMotion; readonly to: CameraView } {
  const screen = screenOf(services);
  const goal = cameraForRegion(region, screen);
  const start = services.camera.get();
  const r = new Resolver(yLookup(doc));
  const ups = new Set(chain(r, start.space));
  const common = chain(r, goal.space).find((space) => ups.has(space)) ?? null;
  const from = inSpace(services, start, common);
  const to = inSpace(services, goal, common);
  const value = readTransitionValue(transition);
  const definition =
    (value !== null ? BUILT_IN.get(value.type) : undefined) ??
    BUILT_IN.get(contributionId(TRANSITIONS_EXTENSION_ID, fly.name))!;
  const options = definition.read(value?.options ?? null);
  let motion: CameraMotion;
  try {
    motion = definition.plan({ from, to, options, comfort, viewport: screen });
  } catch {
    motion = { duration: 0, frame: () => ({ kind: "view", view: to }) };
  }
  return { goal, to, motion: guardComfort(motion, from, to, comfort) };
}

/**
 * Moves the camera to show the region: along the stop's transition when
 * `animate` and the environment has animation frames, otherwise at once.
 * Returns the camera it ends at (the region's own space).
 */
export function jumpTo(
  doc: Y.Doc,
  services: EditorServices,
  region: Region,
  transition: Json,
  options: { readonly animate: boolean; readonly environment?: JumpEnvironment },
): CameraView {
  stopJump(services);
  const env = options.environment ?? browserJumpEnvironment();
  const plan = planJump(doc, services, region, transition, env.comfort);
  const schedule = env.schedule;
  const duration = Number.isFinite(plan.motion.duration)
    ? Math.max(0, plan.motion.duration)
    : 0;
  if (!options.animate || schedule === null || duration === 0) {
    services.camera.set(plan.goal);
    return plan.goal;
  }
  const camera = services.camera;
  const begin = env.now();
  let last: CameraView = camera.get();
  let cancel: (() => void) | null = null;
  const stop = (): void => {
    cancel?.();
    cancel = null;
    if (running.get(camera) === stop) running.delete(camera);
  };
  const tick = (): void => {
    cancel = null;
    // Someone else moved the camera: they take over.
    if (!sameView(camera.get(), last)) return stop();
    const time = env.now() - begin;
    if (time >= duration) {
      camera.set(plan.goal);
      return stop();
    }
    let frame;
    try {
      frame = plan.motion.frame(time);
    } catch {
      camera.set(plan.goal);
      return stop();
    }
    camera.set(
      frame.kind === "view" ? frame.view : frame.mix < 0.5 ? frame.from : frame.to,
    );
    last = camera.get();
    cancel = schedule(tick);
  };
  running.set(camera, stop);
  cancel = schedule(tick);
  return plan.goal;
}
