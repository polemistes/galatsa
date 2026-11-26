// SPDX-License-Identifier: GPL-3.0-or-later

// The smallest interface a rendering engine implements to run the benchmark. It is a
// stand-in for the real renderer interface, which will replace it once an engine has
// been chosen.

import type { CameraPose } from "./camera.ts";
import type { Scene } from "./scene.ts";

/** Size of the area the engine draws into. */
export interface BenchViewport {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per CSS pixel, as window.devicePixelRatio reported at load time. */
  readonly devicePixelRatio: number;
}

/** The encoded image files of the scene, already generated before the engine loads. */
export interface ImageSource {
  /**
   * The encoded file (JPEG) of an asset in Scene.assets. Its natural size is the
   * asset's width and height. Decoding, and choosing a lower resolution when the
   * image is small on screen, is the engine's job.
   */
  getBlob(assetId: string): Blob;
}

export interface EngineSetup {
  /**
   * An empty element of exactly viewport.width x viewport.height CSS pixels, with
   * `position: relative` and `overflow: hidden`. The engine adds its own canvas or
   * elements to it, and removes them in dispose().
   */
  readonly container: HTMLElement;
  readonly viewport: BenchViewport;
  readonly scene: Scene;
  readonly images: ImageSource;
  /**
   * Call this when every visible text box is drawn at full screen resolution for the
   * current camera, after the drawing work that makes it so has been done (for an
   * engine that redraws text later, at a lower cost, while the camera moves, that is
   * when the sharp redraw has finished). The benchmark measures the time from the
   * first frame in which the camera stands still to the first call after it. Calls at
   * other times are ignored, so an engine whose text is always sharp may call it
   * at the end of every render().
   */
  readonly reportTextSharp: () => void;
}

export interface BenchEngine {
  /** Short name, used in results. */
  readonly name: string;
  /**
   * Prepares the engine and the scene (create elements, decode images, and so on).
   * Timed, but not part of the frame times. The camera starts at the first pose of
   * the run; render() is called right after.
   */
  load(setup: EngineSetup): Promise<void>;
  /**
   * Draws one frame for the camera. Called once per animation frame, from
   * requestAnimationFrame. The engine may do work outside render() too (timers,
   * idle callbacks, the browser's own layout and paint); frame times include it,
   * because they are measured between animation frames.
   */
  render(camera: CameraPose): void;
  /** Removes everything the engine added and frees what it holds. */
  dispose(): void;
}
