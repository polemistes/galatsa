// SPDX-License-Identifier: GPL-3.0-or-later

// An engine that draws nothing but keeps the main thread busy for a seeded amount
// of time in every frame (the same amount for the same frame in every run). Used to
// check that the meter repeats for an engine that misses frames, not only for an
// empty one.
//
// The busy times are a mix chosen to lie clearly inside each class of the meter at
// 60 Hz, away from the thresholds (16.7, 25, 33, 41.7 and 100 ms): about 70 % of frames 2 to
// 12 ms, 20 % 27 to 31 ms (missed), 9.5 % 48 to 60 ms (long) and 0.5 % 105 to 130
// ms (stalls). An even spread such as 5 to 25 ms puts many frames right at a
// threshold, where a fraction of a millisecond of overhead decides whether a frame
// counts, and the counts then vary between runs (seen: 22 against 14 missed frames).

import type { BenchEngine } from "../engine.ts";
import { createRng, deriveSeed } from "../prng.ts";

export const SYNTHETIC_SEED = 4242;

/** Busy time for render call number `frame`, in ms. */
export function syntheticBusyMs(frame: number, seed = SYNTHETIC_SEED): number {
  const rng = createRng(deriveSeed(seed, frame));
  const kind = rng.next();
  const within = (min: number, max: number) => min + rng.next() * (max - min);
  if (kind < 0.7) return within(2, 12);
  if (kind < 0.9) return within(27, 31);
  if (kind < 0.995) return within(48, 60);
  return within(105, 130);
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
