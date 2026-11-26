// SPDX-License-Identifier: GPL-3.0-or-later

// An engine that draws nothing. It measures the benchmark itself: with it, frame
// times show the browser's frame pacing and the runner's own overhead.

import type { BenchEngine } from "../engine.ts";

export function createNoopEngine(): BenchEngine {
  let reportTextSharp = (): void => {};
  return {
    name: "noop",
    load(setup) {
      reportTextSharp = setup.reportTextSharp;
      return Promise.resolve();
    },
    render() {
      // Nothing is drawn, so text is always "sharp".
      reportTextSharp();
    },
    dispose() {
      reportTextSharp = () => {};
    },
  };
}
