// SPDX-License-Identifier: GPL-3.0-or-later

// The speed into a stop, as the routes panel offers it, and the
// presentation's motion sickness guard: the route's default,
// a calm, normal or fast flight, or a cross-fade. Stored in the stop's
// `transition` (docs/adr/0001, section 6.1) as the built-in fly transition
// with a speed, or the built-in fade; the player and the transitions play it
// (docs/adr/0015-presentation.md).

import type { Json } from "@galatsa/core";
import { contributionId, readTransitionValue } from "@galatsa/extension-api";
import { roots } from "@galatsa/core/ydoc";
import {
  DEFAULT_TRANSITION,
  fade,
  FLIGHT_LIMITS_SETTING,
  readFlightLimits,
  readFlightSpeed,
  TRANSITIONS_EXTENSION_ID,
} from "@galatsa/extension-transitions";
import type * as Y from "yjs";

/** The choices, in the order the panel lists them. */
export const STOP_SPEEDS = ["default", "calm", "normal", "fast", "fade"] as const;

export type StopSpeed = (typeof STOP_SPEEDS)[number];

const FLY = DEFAULT_TRANSITION;
const FADE = contributionId(TRANSITIONS_EXTENSION_ID, fade.name);

/** The stop's `transition` for a choice; null is the route's default. */
export function transitionForSpeed(speed: StopSpeed): Json {
  switch (speed) {
    case "default":
      return null;
    case "normal":
      return { type: FLY, options: null };
    case "calm":
    case "fast":
      return { type: FLY, options: { speed } };
    case "fade":
      return { type: FADE, options: null };
  }
}

/** The choice a stop's `transition` is; "other" for one the panel does not offer (a cut, another extension's). */
export function speedOfTransition(value: Json): StopSpeed | "other" {
  if (value === null) return "default";
  const read = readTransitionValue(value);
  if (read === null) return "default";
  if (read.type === FLY) return readFlightSpeed(read.options);
  if (read.type === FADE) return "fade";
  return "other";
}

/** True for a choice the panel offers. */
export function isStopSpeed(value: unknown): value is StopSpeed {
  return (STOP_SPEEDS as readonly unknown[]).includes(value);
}

/** Whether the document's motion sickness guard is on (docs/adr/0015-presentation.md). */
export function motionGuardOn(doc: Y.Doc): boolean {
  const settings = roots(doc).settings;
  return readFlightLimits(
    settings.has(FLIGHT_LIMITS_SETTING)
      ? (settings.get(FLIGHT_LIMITS_SETTING) as Json)
      : undefined,
  );
}
