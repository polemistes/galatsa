// SPDX-License-Identifier: GPL-3.0-or-later

// Transitions: how the camera gets from one stop to the next, and the comfort
// settings that keep camera motion from making viewers unwell. See
// docs/adr/0005-extension-interface.md, section 7.

import type { CameraView, Json } from "@galatsa/core";
import type { ContributionId, IconRef, Label } from "./ids.ts";

/**
 * Settings that limit camera motion. The player fills them from the system's
 * "reduce motion" setting, the user's settings and the presenter's toggle
 * during a presentation.
 */
export interface ComfortSettings {
  /**
   * No camera motion: a transition may cut or cross-fade between the start and
   * the goal, but must not show any other view. The player enforces this (see
   * guardComfort) whatever the transition does.
   */
  readonly reducedMotion: boolean;
  /**
   * Above this zoom ratio between start and goal (larger divided by smaller), a
   * transition should cross-fade instead of flying.
   */
  readonly maxFlightZoomRatio: number;
  /**
   * Above this distance between the two centres, in widths of the larger of
   * the two views, a transition should cross-fade instead of flying.
   */
  readonly maxFlightDistance: number;
  /**
   * Above this duration in milliseconds, at normal speed (before
   * durationScale), a transition should cross-fade instead of flying. It
   * catches flights that are within both limits above but long because they
   * combine a large zoom with a long distance; and because it is measured
   * before durationScale, slowing transitions down does not turn flights into
   * cross-fades.
   */
  readonly maxFlightDuration: number;
  /** Multiplies durations; 1 is normal, above 1 slower. */
  readonly durationScale: number;
}

/**
 * Calm defaults, used until the user changes them. At the speed of the
 * built-in flight, a zoom by 32 (3.8 s), a pan of 3 screen widths (4.0 s) and
 * the duration limit (4.2 s) each mark about four seconds of flight. See
 * section 7 of docs/adr/0005-extension-interface.md.
 */
export const DEFAULT_COMFORT: ComfortSettings = {
  reducedMotion: false,
  maxFlightZoomRatio: 32,
  maxFlightDistance: 3,
  maxFlightDuration: 4200,
  durationScale: 1,
};

/** One frame of a camera motion. */
export type MotionFrame =
  | { readonly kind: "view"; readonly view: CameraView }
  /** A cross-fade: `to` drawn over `from` with opacity `mix` (0 to 1). */
  | {
      readonly kind: "blend";
      readonly from: CameraView;
      readonly to: CameraView;
      readonly mix: number;
    };

/** A planned camera motion. */
export interface CameraMotion {
  /** In milliseconds; 0 for a cut. */
  readonly duration: number;
  /**
   * The frame at `time` milliseconds after the start, for 0 <= time <=
   * duration. At `duration` it shows the goal.
   */
  frame(time: number): MotionFrame;
}

export interface TransitionRequest<O> {
  /** Start and goal, anchored in the same space (the player converts them). */
  readonly from: CameraView;
  readonly to: CameraView;
  /** The stop's options, as read by the transition's `read`. */
  readonly options: O;
  readonly comfort: ComfortSettings;
  /** Size of the screen in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * A transition. The stop's `transition` value in the document is
 * `{ "type": "<transition id>", "options": <JSON> }`, or null for the route's
 * default. A transition whose extension is missing plays as the default and
 * its value is kept.
 */
export interface TransitionDefinition<O> {
  /** Transition name; the transition id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  readonly icon?: IconRef;
  /** Offered in quick mode too. Every transition is offered in advanced mode. */
  readonly quick?: boolean;
  /** Reads the stored options; total, like an element type's `read`. */
  read(options: Json): O;
  /**
   * Plans the motion. Must honour `comfort`: with reducedMotion, show only the
   * start and the goal (a cut or a cross-fade); above the flight limits, prefer
   * a cross-fade.
   */
  plan(request: TransitionRequest<O>): CameraMotion;
}

export type AnyTransition = TransitionDefinition<unknown>;

export function defineTransition<O>(
  definition: TransitionDefinition<O>,
): TransitionDefinition<O> {
  return definition;
}

/** A stop's transition value, read; null when it names none or is not one. */
export function readTransitionValue(
  value: Json,
): { readonly type: ContributionId; readonly options: Json } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const type = value["type"];
  if (typeof type !== "string" || !type.includes("/")) return null;
  return { type, options: Object.hasOwn(value, "options") ? value["options"]! : null };
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.space === b.space && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}

/**
 * The player's guard around every transition: with reduced motion, any frame
 * that would show a view other than the start or the goal becomes a cross-fade
 * from the start to the goal, so no extension can move the camera against the
 * viewer's setting. Without reduced motion the motion is returned unchanged.
 */
export function guardComfort(
  motion: CameraMotion,
  from: CameraView,
  to: CameraView,
  comfort: ComfortSettings,
): CameraMotion {
  if (!comfort.reducedMotion) return motion;
  const duration = Number.isFinite(motion.duration) ? Math.max(0, motion.duration) : 0;
  return {
    duration,
    frame(time: number): MotionFrame {
      const progress = duration === 0 ? 1 : Math.min(1, Math.max(0, time / duration));
      let frame: MotionFrame;
      try {
        frame = motion.frame(time);
      } catch {
        frame = { kind: "view", view: progress < 1 ? from : to };
      }
      if (frame.kind === "view") {
        if (sameView(frame.view, from) || sameView(frame.view, to)) return frame;
        return { kind: "blend", from, to, mix: progress };
      }
      if (
        (sameView(frame.from, from) || sameView(frame.from, to)) &&
        (sameView(frame.to, from) || sameView(frame.to, to))
      ) {
        return frame;
      }
      return { kind: "blend", from, to, mix: progress };
    },
  };
}
