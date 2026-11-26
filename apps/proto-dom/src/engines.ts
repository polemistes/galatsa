// SPDX-License-Identifier: GPL-3.0-or-later

// The engine variants that are measured. "dom" is the candidate; each other variant
// changes one or two choices, to show what they cost or save. The names say what
// differs from the candidate.

import type { HarnessEngine } from "@galatsa/bench/harness";
import { createDomEngine, type DomEngineOptions } from "./engine.ts";

const candidate = {
  mode: "element",
  cull: "detach",
  greekBelowPx: 4,
} as const satisfies Omit<DomEngineOptions, "name">;

export const VARIANTS: readonly DomEngineOptions[] = [
  // Candidate: per-element matrices; text laid out again when the camera stops;
  // text under 4 device pixels drawn as stripes; off-screen elements detached.
  { name: "dom", ...candidate },
  // All text drawn as glyphs, however small.
  { name: "dom-nogreek", ...candidate, greekBelowPx: 0 },
  // Text on its own compositor layers (will-change) while the camera moves.
  { name: "dom-wc-text", ...candidate, layersWhileMoving: "text" },
  {
    name: "dom-nogreek-wc-text",
    ...candidate,
    greekBelowPx: 0,
    layersWhileMoving: "text",
  },
  { name: "dom-nogreek-wc-all", ...candidate, greekBelowPx: 0, layersWhileMoving: "all" },
  // Images in canvases holding decoded levels instead of <img>.
  { name: "dom-canvas", ...candidate, imageElement: "canvas" },
  // Text laid out at the exact zoom in every frame, no greeking.
  { name: "dom-screen", mode: "screen", cull: "detach" },
  // One world container with one transform (no greeking), without and with
  // will-change while the camera moves.
  { name: "dom-layer", mode: "layer", cull: "detach", willChange: "none" },
  { name: "dom-layer-wc", mode: "layer", cull: "detach", willChange: "motion" },
  // Culling alternatives (measured without greeking).
  { name: "dom-nogreek-cull-display", ...candidate, greekBelowPx: 0, cull: "display" },
  { name: "dom-nogreek-cull-none", ...candidate, greekBelowPx: 0, cull: "none" },
];

export const HARNESS_ENGINES: readonly HarnessEngine[] = VARIANTS.map((options) => ({
  id: options.name,
  create: () => createDomEngine(options),
}));
