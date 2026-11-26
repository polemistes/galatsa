// SPDX-License-Identifier: GPL-3.0-or-later

// The three engine prototypes, each with the settings it was measured with in its
// own package (the candidate variant, default options).

import type { HarnessEngine } from "@galatsa/bench/harness";
import { createCanvasEngine } from "@galatsa/proto-canvas/engine";
import { HARNESS_ENGINES as DOM_VARIANTS } from "@galatsa/proto-dom/engines";
import { createKonvaEngine } from "@galatsa/proto-konva/engine";
import type { EngineId } from "./plan.ts";

const domCandidate = DOM_VARIANTS.find((e) => e.id === "dom");
if (domCandidate === undefined) throw new Error("The DOM prototype has no 'dom' variant");

export const ENGINES: readonly (HarnessEngine & { readonly id: EngineId })[] = [
  { id: "konva", create: () => createKonvaEngine() },
  { id: "canvas2d", create: () => createCanvasEngine() },
  { id: "dom", create: domCandidate.create },
];
