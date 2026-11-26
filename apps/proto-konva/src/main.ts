// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark harness page with the Konva engine. Besides the harness's own query
// parameters, for experiments that show where frame time goes:
//   maxImage=<pixels>         caps the image level of detail (decoding and uploading)
//   movingGlyphMin=<pixels>   smallest font size drawn with glyphs while moving
//                             (a large value draws all text as bars while moving)

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
        const params = new URLSearchParams(location.search);
        const maxImage = Number(params.get("maxImage"));
        const movingGlyphMin = Number(params.get("movingGlyphMin"));
        const engine = createKonvaEngine({
          ...(maxImage > 0 ? { maxImageLongSide: maxImage } : {}),
          ...(movingGlyphMin > 0 ? { movingGlyphMinPx: movingGlyphMin } : {}),
        });
        window.protoKonvaEngine = engine;
        return engine;
      },
    },
  ],
});
