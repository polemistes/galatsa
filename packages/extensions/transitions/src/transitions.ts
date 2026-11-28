// SPDX-License-Identifier: GPL-3.0-or-later

// The built-in transitions: a flight along the path of van Wijk and Nuij with
// a smooth start and stop, a cross-fade and a cut. The flight honours the
// comfort settings: with reduced motion, and above the flight limits, it
// cross-fades instead. See section 7 of docs/adr/0005-extension-interface.md
// for the numbers and where they come from.

import type { CameraView } from "@galatsa/core";
import {
  contributionId,
  defineTransition,
  defineViewExtension,
  EXTENSION_API_VERSION,
  messageKey,
  type CameraMotion,
  type ComfortSettings,
  type ContributionId,
  type MotionFrame,
  type TransitionRequest,
  type ViewExtension,
} from "@galatsa/extension-api";
import { fadeMix, RAMP, smoothProgress } from "./easing.ts";
import { flightPath, metricDistance } from "./flight.ts";
import { transitionMessages } from "./messages/index.ts";

export const TRANSITIONS_EXTENSION_ID = "galatsa.transitions";

/**
 * Peak speed of a flight, in units of the metric of van Wijk and Nuij per
 * second. The users in the paper's experiment chose 0.90 on average for a
 * constant speed on a notebook; an audience in front of a large screen has
 * more of its field of view in motion and did not choose the speed, so the
 * peak is lower. With rho = sqrt(2), 0.85 units per second means at most
 * 0.85 / rho = 0.60 screen widths per second of panning, or a zoom by
 * e^(0.85 rho) = 3.3 times per second, or a mix of the two within those bounds.
 */
export const FLIGHT_PEAK_SPEED = 0.85;

/**
 * Mean speed of a flight, in units of the metric per second: with the speed
 * profile's ramps (a quarter of the time each), the peak times 1 - 0.25.
 */
export const FLIGHT_SPEED = FLIGHT_PEAK_SPEED * (1 - RAMP);

/** Shortest flight in milliseconds, so that a small move is not abrupt. */
export const MIN_FLIGHT_DURATION = 500;

/**
 * The longest a flight takes, in milliseconds before `durationScale`: a longer
 * one flies faster instead. Within the default flight limits no flight comes
 * near it (they stop at 4.2 s at normal speed, 6 s calm); it bounds flights
 * when the limits are off (the motion sickness guard turned off,
 * withoutFlightLimits), or set higher than this. Claude's choice, see
 * docs/adr/0015-presentation.md.
 */
export const MAX_FLIGHT_DURATION = 6000;

/** How fast a flight into a stop goes: the stop's choice (the fly transition's option). */
export type FlightSpeed = "calm" | "normal" | "fast";

/**
 * The speed of a flight of each kind, as a factor of the peak speed (and so
 * of the mean speed: the profile keeps its shape, its start and its slowing
 * down are as much gentler or brisker). Claude's choice, see
 * docs/adr/0015-presentation.md. "fast" at 1.4 has a mean speed of
 * 0.85 x 0.75 x 1.4 = 0.89 units per second, what the users in the
 * experiment of van Wijk and Nuij chose on average for a constant speed on a
 * notebook (0.90): the fastest that was found comfortable to watch, and so a
 * ceiling for an audience that does not choose it. "calm" at 0.7 is as much
 * slower as "fast" is faster (1 / 1.4 = 0.71), so a flight takes about 1.4
 * times as long.
 */
export const FLIGHT_SPEEDS: { readonly [speed in FlightSpeed]: number } = {
  calm: 0.7,
  normal: 1,
  fast: 1.4,
};

/** The fly transition's options: its speed ("normal" for anything else). */
export function readFlightSpeed(options: unknown): FlightSpeed {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    return "normal";
  const speed = (options as { speed?: unknown }).speed;
  return speed === "calm" || speed === "fast" ? speed : "normal";
}

/** Duration of a cross-fade in milliseconds, at normal speed. */
export const FADE_DURATION = 700;

/**
 * Above this length in the metric a flight would reach numbers that overflow
 * (it is far beyond any limit a user can set; a zoom by 2^64 is 31 units).
 */
const MAX_FLIGHT_LENGTH = 300;

/** Screen width assumed when the request gives none that is usable. */
const FALLBACK_WIDTH = 1000;

function isUsable(view: CameraView): boolean {
  return (
    Number.isFinite(view.cx) &&
    Number.isFinite(view.cy) &&
    Number.isFinite(view.zoom) &&
    view.zoom > 0
  );
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.space === b.space && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}

function scaleOf(durationScale: number): number {
  return Number.isFinite(durationScale) && durationScale > 0 ? durationScale : 1;
}

function widthOf(viewport: { readonly width: number }): number {
  return Number.isFinite(viewport.width) && viewport.width > 0
    ? viewport.width
    : FALLBACK_WIDTH;
}

/** A motion that shows the goal at once. */
function cutTo(to: CameraView): CameraMotion {
  return { duration: 0, frame: () => ({ kind: "view", view: to }) };
}

/**
 * A cut for when there is nothing to show between start and goal: to the
 * goal, or, when the goal is not a usable view and the start is, a motion
 * that stays at the start, so the renderer never gets NaN or a zero zoom.
 */
function settle(from: CameraView, to: CameraView): CameraMotion {
  return isUsable(to) || !isUsable(from) ? cutTo(to) : cutTo(from);
}

/**
 * Duration in milliseconds of a flight of `length` (in the metric of van Wijk
 * and Nuij): the length at FLIGHT_SPEED times `speed` (FLIGHT_SPEEDS), at
 * least MIN_FLIGHT_DURATION (longer for a slower flight), times
 * `durationScale`. 0 for no length.
 *
 * The comfort settings win: a viewer who has slowed transitions down
 * (`durationScale` above 1) never gets a flight faster than normal, so
 * "fast" is then normal speed.
 */
export function flightDuration(length: number, durationScale: number, speed = 1): number {
  if (!(length > 0)) return 0;
  const scale = scaleOf(durationScale);
  let factor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (scale > 1) factor = Math.min(factor, 1);
  const natural = Math.max(
    MIN_FLIGHT_DURATION / Math.min(factor, 1),
    (length / (FLIGHT_SPEED * factor)) * 1000,
  );
  return Math.min(natural, MAX_FLIGHT_DURATION) * scale;
}

/**
 * True if the comfort settings say that a flight from `from` to `to` should
 * be a cross-fade: the zoom ratio, the distance (in widths of the wider view)
 * or the duration at normal speed is above its limit or the limit is not a
 * number, or the views are in different spaces.
 */
export function exceedsFlightLimits(
  from: CameraView,
  to: CameraView,
  viewport: { readonly width: number },
  comfort: ComfortSettings,
): boolean {
  if (from.space !== to.space) return true;
  const width = widthOf(viewport);
  const small = Math.min(from.zoom, to.zoom);
  if (!within(Math.max(from.zoom, to.zoom) / small, comfort.maxFlightZoomRatio))
    return true;
  const distance = (Math.hypot(to.cx - from.cx, to.cy - from.cy) * small) / width;
  if (!within(distance, comfort.maxFlightDistance)) return true;
  const length = metricDistance(from, to, width);
  if (!(length <= MAX_FLIGHT_LENGTH)) return true;
  return !within(flightDuration(length, 1), comfort.maxFlightDuration);
}

/**
 * True if `value` is at most `limit`. False when either is not a number (NaN,
 * or a limit missing from an older or damaged settings object), so that such
 * a limit gives a cross-fade rather than letting any flight through.
 */
function within(value: number, limit: unknown): boolean {
  return typeof limit === "number" && value <= limit;
}

/** A cross-fade from `from` to `to`, gentle at both ends. */
export function planFade(
  from: CameraView,
  to: CameraView,
  durationScale: number,
): CameraMotion {
  if (sameView(from, to)) return cutTo(to);
  const duration = FADE_DURATION * scaleOf(durationScale);
  return {
    duration,
    frame(time): MotionFrame {
      if (!(time > 0)) return { kind: "view", view: from };
      if (time >= duration) return { kind: "view", view: to };
      return { kind: "blend", from, to, mix: fadeMix(time / duration) };
    },
  };
}

/**
 * A flight from the request's start to its goal, or a cross-fade when the
 * comfort settings ask for one, or a cut when there is nothing to show between
 * them (the same view, or a view that is not usable; a goal that is not usable
 * leaves the camera at a usable start).
 */
export function planFlight(
  request: Omit<TransitionRequest<unknown>, "options">,
  speed: FlightSpeed = "normal",
): CameraMotion {
  const { from, to, comfort, viewport } = request;
  if (!isUsable(from) || !isUsable(to) || sameView(from, to)) return settle(from, to);
  if (comfort.reducedMotion || exceedsFlightLimits(from, to, viewport, comfort))
    return planFade(from, to, comfort.durationScale);
  const path = flightPath(from, to, widthOf(viewport));
  const duration = flightDuration(
    path.length,
    comfort.durationScale,
    FLIGHT_SPEEDS[speed],
  );
  if (!(duration > 0)) return cutTo(to);
  return {
    duration,
    frame(time): MotionFrame {
      if (!(time > 0)) return { kind: "view", view: from };
      if (time >= duration) return { kind: "view", view: to };
      // The first half is measured from the start, the second from the goal,
      // so both ends keep their precision and the flight back is the same
      // flight backwards.
      if (time <= duration / 2)
        return {
          kind: "view",
          view: path.at(path.length * smoothProgress(time / duration)),
        };
      return {
        kind: "view",
        view: path.atFromEnd(path.length * smoothProgress((duration - time) / duration)),
      };
    },
  };
}

/**
 * The view to continue from when a motion is broken off at `frame` (the
 * presenter takes over, or the next stop is chosen mid-flight): the view on
 * screen, or for a cross-fade the view that dominates it.
 */
export function restingView(frame: MotionFrame): CameraView {
  if (frame.kind === "view") return frame.view;
  return frame.mix < 0.5 ? frame.from : frame.to;
}

/**
 * Fly: the smooth and efficient path of van Wijk and Nuij. Options:
 * `{ speed: "calm" | "normal" | "fast" }` (FLIGHT_SPEEDS); none, or anything
 * else, is normal. The comfort settings still decide whether it flies at all.
 */
export const fly = defineTransition<FlightSpeed>({
  name: "fly",
  label: messageKey(transitionMessages, "fly.name"),
  quick: true,
  read: (options) => readFlightSpeed(options),
  plan: (request) => planFlight(request, request.options),
});

/** Cross-fade from the start to the goal. No options. */
export const fade = defineTransition<null>({
  name: "fade",
  label: messageKey(transitionMessages, "fade.name"),
  quick: true,
  read: () => null,
  plan: ({ from, to, comfort }) =>
    isUsable(from) && isUsable(to)
      ? planFade(from, to, comfort.durationScale)
      : settle(from, to),
});

/** Show the goal at once. No options. */
export const cut = defineTransition<null>({
  name: "cut",
  label: messageKey(transitionMessages, "cut.name"),
  quick: true,
  read: () => null,
  plan: ({ from, to }) => settle(from, to),
});

/** The transition a route uses for stops that name none. */
export const DEFAULT_TRANSITION: ContributionId = contributionId(
  TRANSITIONS_EXTENSION_ID,
  fly.name,
);

/** The built-in transitions, as a viewing extension. */
export const transitionsExtension: ViewExtension = defineViewExtension({
  id: TRANSITIONS_EXTENSION_ID,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [transitionMessages],
  transitions: [fly, fade, cut],
});
