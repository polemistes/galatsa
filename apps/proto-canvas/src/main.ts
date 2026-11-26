// SPDX-License-Identifier: GPL-3.0-or-later

// The bench harness page with the custom Canvas 2D engine, and the bench's no-op
// engine as a baseline. The engine's own counters are exposed on
// window.protoCanvasStats after each run, for the tests. Query parameter
// decoder=imagedecoder|createimagebitmap picks how images are decoded.

import { createNoopEngine } from "@galatsa/bench";
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
        const decoder = new URLSearchParams(location.search).get("decoder");
        const engine: CanvasEngine = createCanvasEngine(
          decoder === "imagedecoder" || decoder === "createimagebitmap"
            ? { decoder }
            : {},
        );
        window.protoCanvasStats = engine.stats;
        return engine;
      },
    },
    { id: "noop", create: createNoopEngine },
  ],
});
