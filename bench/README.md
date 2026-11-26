# @galatsa/bench

A fixed benchmark for rendering engines: a generated scene of 2,000 elements, a fixed camera run over it, and a meter for frame time, memory and text sharpness. Engines implement a small interface (`BenchEngine` in `src/engine.ts`) and run in a browser.

## Running it

```sh
pnpm --filter @galatsa/bench start   # print a summary of the scene and the camera run (Node)
pnpm --filter @galatsa/bench dev     # harness page at http://localhost:5173/
pnpm --filter @galatsa/bench build   # library to dist/, harness page to build/harness/
pnpm --filter @galatsa/bench preview # serve the built harness page
pnpm e2e                             # includes the repeatability check in Chromium (about 2 minutes)
```

On the harness page, pick an engine and press **Run** or **Run twice and compare**, then **Download JSON**. Keep the window visible and leave it alone during a run: browsers slow down animation frames in hidden tabs, and a result whose page was hidden is marked as invalid. Use the built page (`build` and `preview`) for real measurements; the dev server serves unbundled modules.

Query parameters, for automated runs: `engine=<id>`, `runs=1` or `runs=2` (start at once), `width` and `height` (viewport in CSS pixels, default 1280 x 720) and `memory=0` (skip `measureUserAgentSpecificMemory`). Scripts can call `window.galatsaBench.run(runs, engineId)`, which resolves to the results and, for two runs or more, a comparison.

The page has two engines: `noop` draws nothing and measures the meter itself; `outline` draws element outlines on a canvas, as a reference for the coordinate convention. Neither is a candidate engine.

## Adding an engine

An engine lives in its own package, depends on `@galatsa/bench` (`"workspace:*"`) and implements `BenchEngine`:

- `load(setup)`: add a canvas or elements to `setup.container` (an empty element of exactly the viewport size), and prepare the scene. Timed separately from the frames.
- `render(camera)`: draw one frame. Called from `requestAnimationFrame`, once per frame. A world point `(wx, wy)` is drawn at `((wx - camera.x) * camera.zoom + width / 2, (wy - camera.y) * camera.zoom + height / 2)` in CSS pixels.
- `dispose()`: remove and free everything.
- `setup.reportTextSharp()`: call it when all visible text is drawn at full screen resolution for the current camera. The meter measures the time from the first still frame after a movement to the first call. An engine whose text is always sharp may call it at the end of every `render()`.
- `setup.images.getBlob(assetId)`: the encoded JPEG of an image. Decoding it, and using a lower resolution when the image is small on screen, is the engine's job.

To get the same page for the engine, call `startHarness` from `@galatsa/bench/harness` with the engine (see `src/harness/main.ts`).

## The scene

`generateScene()` (seed 20261126, scene version 1) gives ten clusters of 9,600 x 5,400 world units in a 5 x 2 grid, 57,600 x 13,200 units in all. Each cluster has 120 shapes (the first is a backdrop the size of the cluster), 60 text boxes and 20 images, in mixed paint order:

- Shapes: rectangles, ellipses, triangles and lines, 40 to 2,400 units, some rotated, some translucent.
- Text boxes: body text (12 to 40 units), headings (48 to 140 units, bold) and fine print (2 to 8 units, readable only when zoomed in), in the generic families `sans-serif`, `serif` and `monospace`, with letters outside ASCII (æ, ø, å, é, ü). The box height is an estimate for culling; the engine wraps the text to the box width.
- Images: 200 image files with pixel counts spread evenly from 2 to 12 megapixels, in six aspect ratios, shown at 400 to 2,400 units wide.

The images hold **1,400 megapixels in total. Decoded at full size as RGBA they would need 5.6 GB**, so an engine has to decode at reduced size. Their pixels are generated (`src/images.ts`: gradient, flat shapes, a 1-pixel grid every 128 pixels, a little noise) and encoded to JPEG at quality 0.9 by the browser, once per page load and before any run; nothing is downloaded. In Chromium 158 the encoded files total about 317 MB and generating them took about 17 seconds on the development machine. The generated images are kept as Blobs for the life of the page.

The scene uses only integer arithmetic and exactly rounded floating-point operations, so it is bit-identical in every JavaScript engine. A unit test pins its hash. The image pixels are identical everywhere too; the encoded JPEG bytes differ between browsers.

## The camera run

`createCameraRun(scene)` gives 2,775 poses, one per frame, which take 46.25 seconds at 60 frames per second:

1. Zoom in from 0.02 to 20 on a text box near the middle of the scene (360 frames), hold. At zoom 0.02 the whole scene is in view; at zoom 20 the view's top-left corner is the text box's top-left corner.
2. Zoom back out to 0.02 (360 frames), hold.
3. Fly to the left edge (90 frames), pan across the top row at zoom 0.15 (480 frames), hold.
4. Fly through ten stops (90 frames each, with a hold at each stop). The stops alternate between the two rows and look at a whole cluster, at the largest text box or at the largest image of a cluster. Flights zoom out and in as in van Wijk and Nuij, "Smooth and efficient zooming and panning" (IEEE InfoVis 2003).

A hold is 45 frames (750 ms at 60 Hz) of a still camera. The run is framed for a 1,280 x 720 viewport; other sizes see more or less around the same centre. Because the run is a list of frames, every engine renders the same poses; a slow engine takes longer instead of skipping poses.

The poses use `Math.exp`, `Math.log` and hyperbolic functions, which JavaScript engines may round differently in the last bits, so poses can differ between browsers by about 1e-15 relative. A unit test pins their hash at 9 significant digits.

## What is measured

Per frame, in `frames` of the JSON result:

- `intervalMs`: the difference between the timestamps the browser passes to consecutive animation-frame callbacks. Browsers set these to the start of the display frame, so they have no scheduling jitter and show dropped display frames well. But they round a long frame down to whole display frames: in Chromium at 60 Hz, a frame that blocks for 40 ms reads as 33.3 ms, and one that blocks for 110 ms reads as 100.0 ms.
- `callbackIntervalMs`: the difference of `performance.now()` at the start of consecutive callbacks. It shows long stalls at their real length (110.3 ms for the 110 ms block), but jitters around the display interval, so many normal frames at 60 Hz read slightly above 16.7 ms.
- `scriptMs`: time spent inside `render()`.

Use `intervalMs` for targets about display frames (under 16.7 ms or 33 ms) and `callbackIntervalMs` for targets about stalls (no frame over 100 ms). Both include the browser's own style, layout, paint and compositing work on the main thread, because they are measured between frames.

`stats` has, for each series, the count, mean, minimum, 50th, 95th and 99th percentile (nearest-rank method), maximum, and the number of frames strictly over 16.7, 33 and 100 ms; and the frame intervals per kind of segment (zoom, pan, flight, hold). `environment.warmupIntervalMs` is the median interval of the 60 warm-up frames, which is about the display's refresh interval: on a display that is not 60 Hz, read the thresholds with that in mind.

`textSharp` has one event per hold: the time from just before `render()` of the first still frame to the engine's first `reportTextSharp()` after it, or `null` if the engine did not report before the camera moved again.

Memory, where the browser offers it, and marked as unavailable where it does not:

- `measureUserAgentSpecificMemory()` before load, after load and after the run. Chromium only, and only on a cross-origin isolated page; the harness's Vite server sends the needed COOP and COEP headers. It is not available in Chromium's separate headless shell. Chromium may wait for a garbage collection before answering (up to 30 s per call here); `--enable-blink-features=ForceEagerMeasureMemory` makes it answer at once.
- `performance.memory` every 30 frames (Chromium only, JavaScript heap only). Chromium rounds the values unless started with `--enable-precise-memory-info`.

Neither covers decoded images or GPU memory held by the browser, so both understate what an engine uses. Firefox and WebKit offer neither.

## Repeatability

`compareRuns(a, b)` compares two results. It decides on the frame count, the total run time and the mean, median, 95th and 99th percentile of `intervalMs`, each within 5 % (symmetric relative difference). The maximum, the threshold counts, the callback intervals and the script times are shown but do not decide: one garbage-collection pause moves a maximum, and the script times of an empty engine are a few microseconds.

`tests/e2e/bench-repeatability.spec.ts` runs the no-op engine twice in Chromium and requires agreement, and checks that the meter catches deliberately slow frames. Headless Chromium paces animation frames with an even 60 Hz clock, so these runs show that the meter itself adds no variation; they do not show how much a real display adds.
