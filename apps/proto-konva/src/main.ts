// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark harness page with the Konva engine.

import { startHarness } from "@galatsa/bench/harness";
import { createKonvaEngine, type KonvaEngine } from "./engine.ts";

declare global {
  interface Window {
    /** The engine of the latest run, so tests can read its statistics. */
    protoKonvaEngine?: KonvaEngine;
  }
}

startHarness({
  root: document.getElementById("app") ?? document.body,
  engines: [
    {
      id: "konva",
      create: () => {
        const engine = createKonvaEngine();
        window.protoKonvaEngine = engine;
        return engine;
      },
    },
  ],
});
