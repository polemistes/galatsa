// SPDX-License-Identifier: GPL-3.0-or-later

// The comfort settings: stored preferences, the system's "reduce motion"
// setting and the presenter's toggle, combined into what a transition gets.

import { DEFAULT_COMFORT } from "@galatsa/extension-api";
import { describe, expect, it } from "vitest";
import {
  COMFORT_LABELS,
  DEFAULT_COMFORT_PREFERENCES,
  readComfortPreferences,
  REDUCED_MOTION_QUERY,
  resolveComfort,
  watchSystemReducedMotion,
  type MediaQueryListLike,
} from "./comfort.ts";
import { transitionMessages } from "./messages/index.ts";

describe("comfort preferences", () => {
  it("default to following the system, with the calm limits", () => {
    expect(DEFAULT_COMFORT_PREFERENCES).toEqual({
      motion: "system",
      maxFlightZoomRatio: DEFAULT_COMFORT.maxFlightZoomRatio,
      maxFlightDistance: DEFAULT_COMFORT.maxFlightDistance,
      maxFlightDuration: DEFAULT_COMFORT.maxFlightDuration,
      durationScale: DEFAULT_COMFORT.durationScale,
    });
  });

  it("are read from anything, keeping what is valid", () => {
    expect(readComfortPreferences(null)).toEqual(DEFAULT_COMFORT_PREFERENCES);
    expect(readComfortPreferences([1, 2])).toEqual(DEFAULT_COMFORT_PREFERENCES);
    expect(
      readComfortPreferences({
        motion: "reduce",
        maxFlightZoomRatio: 16,
        maxFlightDistance: 2,
        maxFlightDuration: 2500,
        durationScale: 1.5,
      }),
    ).toEqual({
      motion: "reduce",
      maxFlightZoomRatio: 16,
      maxFlightDistance: 2,
      maxFlightDuration: 2500,
      durationScale: 1.5,
    });
    // Unknown and wrong values fall back to the defaults; numbers are kept
    // within sensible bounds.
    expect(
      readComfortPreferences({
        motion: "sometimes",
        maxFlightZoomRatio: 0.5,
        maxFlightDistance: -3,
        maxFlightDuration: "long",
        durationScale: 100,
      }),
    ).toEqual({
      motion: "system",
      maxFlightZoomRatio: 1,
      maxFlightDistance: 0,
      maxFlightDuration: DEFAULT_COMFORT.maxFlightDuration,
      durationScale: 4,
    });
    expect(readComfortPreferences({ durationScale: 0.01 }).durationScale).toBe(0.25);
    expect(readComfortPreferences({ motion: "allow" }).motion).toBe("allow");
  });
});

describe("resolving comfort", () => {
  it("follows the system unless the user or the presenter decides", () => {
    const prefs = DEFAULT_COMFORT_PREFERENCES;
    expect(resolveComfort(prefs, false)).toEqual(DEFAULT_COMFORT);
    expect(resolveComfort(prefs, true).reducedMotion).toBe(true);
    // The user's own setting wins over the system's.
    expect(resolveComfort({ ...prefs, motion: "reduce" }, false).reducedMotion).toBe(true);
    expect(resolveComfort({ ...prefs, motion: "allow" }, true).reducedMotion).toBe(false);
    // The presenter's toggle during a presentation wins over both.
    expect(resolveComfort(prefs, false, true).reducedMotion).toBe(true);
    expect(resolveComfort({ ...prefs, motion: "reduce" }, true, false).reducedMotion).toBe(
      false,
    );
    expect(resolveComfort(prefs, true, null).reducedMotion).toBe(true);
    // The limits come from the preferences.
    expect(resolveComfort({ ...prefs, maxFlightDistance: 2 }, false).maxFlightDistance).toBe(2);
  });
});

describe("the system's reduce motion setting", () => {
  function fakeMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    const list = {
      matches: initial,
      addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: "change", listener: () => void) =>
        listeners.delete(listener),
    };
    const queries: string[] = [];
    return {
      queries,
      listeners,
      set(value: boolean) {
        list.matches = value;
        for (const listener of listeners) listener();
      },
      matchMedia: (query: string): MediaQueryListLike => {
        queries.push(query);
        return list;
      },
    };
  }

  it("is read and followed as it changes", () => {
    const media = fakeMedia(true);
    const seen: boolean[] = [];
    const watch = watchSystemReducedMotion(media.matchMedia, (reduced) => seen.push(reduced));
    expect(media.queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
    expect(watch.reduced()).toBe(true);
    media.set(false);
    expect(watch.reduced()).toBe(false);
    media.set(true);
    expect(seen).toEqual([false, true]);
    watch.dispose();
    expect(media.listeners.size).toBe(0);
    media.set(false);
    expect(seen).toEqual([false, true]);
  });

  it("counts as off where there is no way to read it", () => {
    const watch = watchSystemReducedMotion(undefined, () => {
      throw new Error("never called");
    });
    expect(watch.reduced()).toBe(false);
    watch.dispose();
    const broken = watchSystemReducedMotion(() => {
      throw new Error("no media queries here");
    }, () => {});
    expect(broken.reduced()).toBe(false);
    broken.dispose();
  });
});

describe("comfort labels", () => {
  it("are all in the messages", () => {
    for (const label of Object.values(COMFORT_LABELS)) {
      const [namespace, key] = label.split(":");
      expect(namespace).toBe(transitionMessages.namespace);
      expect(Object.hasOwn(transitionMessages.messages.nb, key!), label).toBe(true);
      expect(Object.hasOwn(transitionMessages.messages.en, key!), label).toBe(true);
    }
  });
});
