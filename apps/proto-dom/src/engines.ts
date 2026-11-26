// SPDX-License-Identifier: GPL-3.0-or-later

// The engine variants that are measured. "dom" is the candidate; the others change
// one choice each, to show what that choice costs or saves.

import type { HarnessEngine } from "@galatsa/bench/harness";
import { createDomEngine, type DomEngineOptions } from "./engine.ts";

export const VARIANTS: readonly DomEngineOptions[] = [
  // Candidate: per-element matrices, text laid out again when the camera stops.
  { name: "dom", mode: "element", cull: "detach" },
  // Text laid out at the exact zoom in every frame.
  { name: "dom-screen", mode: "screen", cull: "detach" },
  // One world container with one transform, no will-change.
  { name: "dom-layer", mode: "layer", cull: "detach", willChange: "none" },
  // One world container, will-change: transform while the camera moves.
  { name: "dom-layer-wc", mode: "layer", cull: "detach", willChange: "motion" },
  // Text under 4 device pixels drawn as stripes.
  { name: "dom-greek", mode: "element", cull: "detach", greekBelowPx: 4 },
  // Text elements (or all elements) on their own compositor layers while moving.
  { name: "dom-wc-text", mode: "element", cull: "detach", layersWhileMoving: "text" },
  { name: "dom-wc-all", mode: "element", cull: "detach", layersWhileMoving: "all" },
  // Culling alternatives for the candidate.
  { name: "dom-cull-display", mode: "element", cull: "display" },
  { name: "dom-cull-none", mode: "element", cull: "none" },
];

export const HARNESS_ENGINES: readonly HarnessEngine[] = VARIANTS.map((options) => ({
  id: options.name,
  create: () => createDomEngine(options),
}));
