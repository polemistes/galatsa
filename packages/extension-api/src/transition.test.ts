// SPDX-License-Identifier: GPL-3.0-or-later

// Transitions and the comfort guard.

import type { CameraView, Json } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { ViewHost } from "./host.ts";
import { EXTENSION_API_VERSION } from "./ids.ts";
import {
  DEFAULT_COMFORT,
  defineTransition,
  guardComfort,
  readTransitionValue,
  type MotionFrame,
} from "./transition.ts";

/**
 * A plain flight that ignores the comfort settings on purpose, to show that
 * the guard holds anyway. (A real transition honours them.)
 */
const careless = defineTransition<{ duration: number }>({
  name: "careless",
  label: "common:a",
  read: (options: Json) => ({
    duration:
      options !== null && typeof options === "object" && !Array.isArray(options)
        ? Number(options["duration"] ?? 800)
        : 800,
  }),
  plan({ from, to, options }) {
    return {
      duration: options.duration,
      frame(time) {
        const s = Math.min(1, time / options.duration);
        return {
          kind: "view",
          view: {
            space: from.space,
            cx: from.cx + (to.cx - from.cx) * s,
            cy: from.cy + (to.cy - from.cy) * s,
            zoom: from.zoom * (to.zoom / from.zoom) ** s,
          },
        };
      },
    };
  },
});

const FROM: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };
const TO: CameraView = { space: null, cx: 1000, cy: 500, zoom: 4 };

function frames(motion: {
  duration: number;
  frame(t: number): MotionFrame;
}): MotionFrame[] {
  const out: MotionFrame[] = [];
  for (let t = 0; t <= motion.duration; t += motion.duration / 20)
    out.push(motion.frame(t));
  return out;
}

describe("transitions", () => {
  it("are found by the id a stop stores", () => {
    const host = new ViewHost();
    host.load([
      {
        id: "fx",
        version: "1.0.0",
        api: EXTENSION_API_VERSION,
        transitions: [careless],
      },
    ]);
    const value = readTransitionValue({
      type: "fx/careless",
      options: { duration: 400 },
    });
    expect(value).toEqual({ type: "fx/careless", options: { duration: 400 } });
    const transition = host.transition(value!.type)!;
    const motion = transition.plan({
      from: FROM,
      to: TO,
      options: transition.read(value!.options),
      comfort: DEFAULT_COMFORT,
      viewport: { width: 1280, height: 720 },
    });
    expect(motion.duration).toBe(400);
    expect(motion.frame(400)).toEqual({ kind: "view", view: TO });
    // A missing extension's transition plays as the default: the host has none.
    expect(host.transition("gone/fly")).toBeUndefined();
    expect(readTransitionValue(null)).toBeNull();
    expect(readTransitionValue({ type: "no-slash" })).toBeNull();
  });

  it("never show a view other than the start and the goal with reduced motion", () => {
    const comfort = { ...DEFAULT_COMFORT, reducedMotion: true };
    const motion = careless.plan({
      from: FROM,
      to: TO,
      options: { duration: 1000 },
      comfort,
      viewport: { width: 1280, height: 720 },
    });
    const guarded = guardComfort(motion, FROM, TO, comfort);
    for (const frame of frames(guarded)) {
      const views = frame.kind === "view" ? [frame.view] : [frame.from, frame.to];
      for (const view of views) expect([FROM, TO]).toContainEqual(view);
    }
    expect(guarded.frame(500)).toEqual({ kind: "blend", from: FROM, to: TO, mix: 0.5 });
    expect(guarded.frame(1000)).toEqual({ kind: "view", view: TO });
  });

  it("leave motion alone without reduced motion", () => {
    const motion = careless.plan({
      from: FROM,
      to: TO,
      options: { duration: 1000 },
      comfort: DEFAULT_COMFORT,
      viewport: { width: 1280, height: 720 },
    });
    expect(guardComfort(motion, FROM, TO, DEFAULT_COMFORT)).toBe(motion);
  });
});
