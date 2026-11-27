// SPDX-License-Identifier: GPL-3.0-or-later

// Public entry of @galatsa/bench: the benchmark scene, the camera run, the engine
// interface and the runner. The harness page is a separate entry,
// "@galatsa/bench/harness".

export * from "./camera.ts";
export * from "./engine.ts";
export { createNoopEngine } from "./engines/noop.ts";
export { createOutlineEngine } from "./engines/outline.ts";
export {
  createRendererEngine,
  type RendererEngine,
  type RendererEngineOptions,
} from "./engines/renderer.ts";
export * from "./engines/synthetic.ts";
export * from "./image-store.ts";
export * from "./images.ts";
export * from "./memory.ts";
export * from "./prng.ts";
export * from "./result.ts";
export * from "./runner.ts";
export * from "./scene.ts";
export * from "./stats.ts";
export { STRINGS } from "./strings.ts";
