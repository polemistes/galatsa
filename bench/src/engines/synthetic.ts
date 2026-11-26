// SPDX-License-Identifier: GPL-3.0-or-later

// An engine that draws nothing but keeps the main thread busy for a pseudo-random
// 5 to 25 ms in every frame (the same amount for the same frame in every run). Used
// to check that the meter repeats for an engine that misses frames, not only for
// an empty one.

import type { BenchEngine } from "../engine.ts";
import { createRng, deriveSeed } from "../prng.ts";

export const SYNTHETIC_SEED = 4242;
export const SYNTHETIC_MIN_MS = 5;
export const SYNTHETIC_MAX_MS = 25;

/** Busy time for render call number `frame`, in ms. */
export function syntheticBusyMs(frame: number, seed = SYNTHETIC_SEED): number {
  const r = createRng(deriveSeed(seed, frame)).next();
  return SYNTHETIC_MIN_MS + r * (SYNTHETIC_MAX_MS - SYNTHETIC_MIN_MS);
}

export function createSyntheticEngine(seed = SYNTHETIC_SEED): BenchEngine {
  let frame = 0;
  let reportTextSharp = (): void => {};
  return {
    name: "synthetic",
    load(setup) {
      frame = 0;
      reportTextSharp = setup.reportTextSharp;
      return Promise.resolve();
    },
    render() {
      const end = performance.now() + syntheticBusyMs(frame++, seed);
      while (performance.now() < end) {
        // Busy wait: stands in for drawing work.
      }
      reportTextSharp();
    },
    dispose() {
      reportTextSharp = () => {};
    },
  };
}
