// SPDX-License-Identifier: GPL-3.0-or-later

// The bench's own harness page (bench/index.html), with the no-op engine, the
// synthetic-load engine, the outline reference engine and the real renderer.
// Query parameter decoder=imagedecoder|worker|main chooses how the renderer
// decodes images (default: what the browser supports best).

import { createNoopEngine } from "../engines/noop.ts";
import { createOutlineEngine } from "../engines/outline.ts";
import { createRendererEngine, type RendererEngine } from "../engines/renderer.ts";
import { createSyntheticEngine } from "../engines/synthetic.ts";
import { startHarness } from "./harness.ts";

declare global {
  interface Window {
    /** The renderer engine of the last run, for its counters. */
    galatsaRenderer?: RendererEngine;
  }
}

startHarness({
  root: document.getElementById("app") ?? document.body,
  engines: [
    { id: "noop", create: createNoopEngine },
    { id: "synthetic", create: () => createSyntheticEngine() },
    { id: "outline", create: createOutlineEngine },
    {
      id: "renderer",
      create: () => {
        const decoder = new URLSearchParams(location.search).get("decoder");
        const engine = createRendererEngine(
          decoder === "imagedecoder" || decoder === "worker" || decoder === "main"
            ? { decoder }
            : {},
        );
        window.galatsaRenderer = engine;
        return engine;
      },
    },
  ],
});
