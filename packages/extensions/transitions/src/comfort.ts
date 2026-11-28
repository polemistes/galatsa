// SPDX-License-Identifier: GPL-3.0-or-later

// Comfort settings as the user stores them, the system's "reduce motion"
// setting, and the presenter's toggle during a presentation, combined into the
// ComfortSettings every transition gets. Environment-agnostic: the system
// setting is read through a matchMedia function the caller passes in.

import type { Json } from "@galatsa/core";
import {
  DEFAULT_COMFORT,
  messageKey,
  type ComfortSettings,
  type Label,
} from "@galatsa/extension-api";
import { transitionMessages } from "./messages/index.ts";

/**
 * Whether the camera may move: follow the system's setting, never move
 * (reduced motion), or move even if the system asks for reduced motion.
 */
export type MotionPreference = "system" | "reduce" | "allow";

const MOTION_PREFERENCES: readonly MotionPreference[] = ["system", "reduce", "allow"];

/** The comfort settings as the user stores them. */
export interface ComfortPreferences {
  readonly motion: MotionPreference;
  readonly maxFlightZoomRatio: number;
  readonly maxFlightDistance: number;
  readonly maxFlightDuration: number;
  readonly durationScale: number;
}

export const DEFAULT_COMFORT_PREFERENCES: ComfortPreferences = {
  motion: "system",
  maxFlightZoomRatio: DEFAULT_COMFORT.maxFlightZoomRatio,
  maxFlightDistance: DEFAULT_COMFORT.maxFlightDistance,
  maxFlightDuration: DEFAULT_COMFORT.maxFlightDuration,
  durationScale: DEFAULT_COMFORT.durationScale,
};

/** Bounds for the stored numbers. */
const BOUNDS = {
  maxFlightZoomRatio: [1, 2 ** 64],
  maxFlightDistance: [0, 1e6],
  maxFlightDuration: [0, 60_000],
  durationScale: [0.25, 4],
} as const;

function readNumber(
  value: Json | undefined,
  [min, max]: readonly [number, number],
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads stored comfort preferences; total: anything that is not a valid value
 * becomes the default, and numbers are kept within their bounds.
 */
export function readComfortPreferences(value: Json): ComfortPreferences {
  const d = DEFAULT_COMFORT_PREFERENCES;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return d;
  const motion = value["motion"];
  return {
    motion: MOTION_PREFERENCES.find((m) => m === motion) ?? d.motion,
    maxFlightZoomRatio: readNumber(
      value["maxFlightZoomRatio"],
      BOUNDS.maxFlightZoomRatio,
      d.maxFlightZoomRatio,
    ),
    maxFlightDistance: readNumber(
      value["maxFlightDistance"],
      BOUNDS.maxFlightDistance,
      d.maxFlightDistance,
    ),
    maxFlightDuration: readNumber(
      value["maxFlightDuration"],
      BOUNDS.maxFlightDuration,
      d.maxFlightDuration,
    ),
    durationScale: readNumber(
      value["durationScale"],
      BOUNDS.durationScale,
      d.durationScale,
    ),
  };
}

/**
 * The comfort settings for a transition. Reduced motion comes from, in order
 * of precedence: the presenter's toggle during a presentation (null when not
 * used), the user's preference, and the system's setting.
 */
export function resolveComfort(
  preferences: ComfortPreferences,
  systemReducedMotion: boolean,
  presenterReducedMotion: boolean | null = null,
): ComfortSettings {
  const fromPreference =
    preferences.motion === "system"
      ? systemReducedMotion
      : preferences.motion === "reduce";
  return {
    reducedMotion: presenterReducedMotion ?? fromPreference,
    maxFlightZoomRatio: preferences.maxFlightZoomRatio,
    maxFlightDistance: preferences.maxFlightDistance,
    maxFlightDuration: preferences.maxFlightDuration,
    durationScale: preferences.durationScale,
  };
}

/**
 * The document setting "motion sickness guard" (docs/adr/0015-presentation.md):
 * a document-wide setting (docs/adr/0001, section 2) whose value false turns
 * the flight limits off for the whole presentation. Missing, or anything
 * else, is on.
 */
export const FLIGHT_LIMITS_SETTING = "galatsa.transitions.flightLimits";

/** Whether the motion sickness guard is on, from the setting's value. */
export function readFlightLimits(value: Json | undefined): boolean {
  return value !== false;
}

/**
 * The comfort settings with the flight limits off (the motion sickness guard
 * turned off): the camera flies however far the stops are apart. Reduced
 * motion stays as it is and still wins; a flight that would be very long
 * flies faster instead (MAX_FLIGHT_DURATION, transitions.ts).
 */
export function withoutFlightLimits(comfort: ComfortSettings): ComfortSettings {
  return {
    ...comfort,
    maxFlightZoomRatio: Infinity,
    maxFlightDistance: Infinity,
    maxFlightDuration: Infinity,
  };
}

/** The media query of the system's "reduce motion" setting. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The part of a browser's MediaQueryList this needs. */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

export interface SystemMotionWatch {
  /** True if the system currently asks for reduced motion. */
  reduced(): boolean;
  /** Stops following the setting. */
  dispose(): void;
}

/**
 * Follows the system's "reduce motion" setting through `matchMedia` (the
 * browser's window.matchMedia; undefined where there is none), calling
 * `onChange` when it changes. Where it cannot be read it counts as off.
 */
export function watchSystemReducedMotion(
  matchMedia: ((query: string) => MediaQueryListLike) | undefined,
  onChange: (reduced: boolean) => void,
): SystemMotionWatch {
  let list: MediaQueryListLike | undefined;
  try {
    list = matchMedia?.(REDUCED_MOTION_QUERY);
  } catch {
    list = undefined;
  }
  if (!list) return { reduced: () => false, dispose: () => {} };
  const media = list;
  const listener = () => onChange(media.matches);
  media.addEventListener?.("change", listener);
  return {
    reduced: () => media.matches,
    dispose: () => media.removeEventListener?.("change", listener),
  };
}

/** Labels for a settings view of the comfort preferences and the presenter's toggle. */
export const COMFORT_LABELS: {
  readonly motion: Label;
  readonly motionSystem: Label;
  readonly motionReduce: Label;
  readonly motionAllow: Label;
  readonly presenterToggle: Label;
  readonly maxFlightZoomRatio: Label;
  readonly maxFlightDistance: Label;
  readonly maxFlightDuration: Label;
  readonly durationScale: Label;
} = {
  motion: messageKey(transitionMessages, "comfort.motion"),
  motionSystem: messageKey(transitionMessages, "comfort.motion.system"),
  motionReduce: messageKey(transitionMessages, "comfort.motion.reduce"),
  motionAllow: messageKey(transitionMessages, "comfort.motion.allow"),
  presenterToggle: messageKey(transitionMessages, "comfort.presenter-toggle"),
  maxFlightZoomRatio: messageKey(transitionMessages, "comfort.max-zoom-ratio"),
  maxFlightDistance: messageKey(transitionMessages, "comfort.max-distance"),
  maxFlightDuration: messageKey(transitionMessages, "comfort.max-duration"),
  durationScale: messageKey(transitionMessages, "comfort.duration-scale"),
};
