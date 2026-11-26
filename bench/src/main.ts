// SPDX-License-Identifier: GPL-3.0-or-later

// Prints a summary of the benchmark scene and camera run, without a browser:
//   pnpm --filter @galatsa/bench start
// The measurement itself runs in a browser (see bench/README.md).

import { CORE_VERSION } from "@galatsa/core";
import { createCameraRun, runLength } from "./camera.ts";
import { generateScene, summarizeScene } from "./scene.ts";

const scene = generateScene();
const summary = summarizeScene(scene);
const run = createCameraRun(scene);
const length = runLength(run);
const megapixels = (pixels: number) => (pixels / 1e6).toFixed(2);

console.log(`Galatsa bench, @galatsa/core ${CORE_VERSION}`);
console.log(
  `Scene v${summary.version}, seed ${summary.seed}, hash ${summary.hash}: ` +
    `${summary.elements} elements (${summary.shapes} shapes, ${summary.texts} text boxes, ${summary.images} images)`,
);
console.log(
  `Images: ${megapixels(summary.imagePixels.total)} megapixels in total ` +
    `(${megapixels(summary.imagePixels.min)} to ${megapixels(summary.imagePixels.max)} each), ` +
    `${(summary.decodedImageBytes / 1e9).toFixed(2)} GB if all were decoded at full size as RGBA`,
);
console.log(
  `Camera run: ${length.frames} frames, ${length.seconds.toFixed(1)} s at 60 frames per second, ` +
    `${run.segments.length} segments, ${run.stops.length} route stops`,
);
