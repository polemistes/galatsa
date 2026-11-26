// SPDX-License-Identifier: GPL-3.0-or-later

// The bench harness page with the custom Canvas 2D engine. The engine's own
// counters are exposed on window.protoCanvasStats after each run, for the tests.

import { startHarness } from "@galatsa/bench/harness";
import { type CanvasEngine, createCanvasEngine, type EngineStats } from "./engine.ts";

declare global {
  interface Window {
    protoCanvasStats?: EngineStats;
  }
}

startHarness({
  root: document.getElementById("app") ?? document.body,
  engines: [
    {
      id: "canvas2d",
      create: () => {
        const engine: CanvasEngine = createCanvasEngine();
        window.protoCanvasStats = engine.stats;
        return engine;
      },
    },
  ],
});
