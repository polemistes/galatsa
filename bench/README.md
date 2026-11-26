# @galatsa/bench

A fixed benchmark for rendering engines: a generated scene of 2,000 elements, a fixed camera run over it, and a meter for frame time, memory and text sharpness. Engines implement a small interface (`BenchEngine` in `src/engine.ts`) and run in a browser.

## Running it

```sh
pnpm --filter @galatsa/bench start   # print a summary of the scene and the camera run (Node)
pnpm --filter @galatsa/bench dev     # harness page at http://localhost:5173/
pnpm --filter @galatsa/bench build   # library to dist/, harness page to build/harness/
pnpm --filter @galatsa/bench preview # serve the built harness page
pnpm e2e                             # includes the meter checks in Chromium and Firefox (about 15 minutes)
```

On the harness page, pick an engine and press **Run** or **Run twice and compare**, then **Download JSON**. **Run with captures** keeps an image of the drawing area at the end of each hold, for looking at what the engine drew; it pauses the run for each image, so use it for review, not for timing. Use the built page (`build` and `preview`) for real measurements; the dev server serves unbundled modules.

During a run:

- Keep the window visible and leave it alone. Browsers slow down animation frames in hidden pages; a result whose page was hidden or whose window was resized is marked as not valid (`verdictInputs.valid` and `problems`).
- The drawing area (the stage) is fixed at the top-left corner of the window, 1280 x 720 CSS pixels by default, with the controls below it. A run refuses to start unless the whole stage is inside the window, because browsers skip painting what is off-screen. Tauri's default window (800 x 600) is too small: make the window larger, or choose a smaller stage with `?width=` and `?height=` (results with different sizes are not comparable).

Query parameters, for automated runs: `engine=<id>`, `runs=<n>` (start at once), `capture=1` (with `runs`), `width` and `height` (stage size in CSS pixels) and `memory=0` (skip `measureUserAgentSpecificMemory`).

The page has three engines, none of them a candidate: `noop` draws nothing and measures the meter itself; `synthetic` keeps the main thread busy for a seeded time per frame (the same in every run: mostly short frames, some missed, some long and a few stalls, all well away from the thresholds), to check the meter with an engine that misses frames; `outline` draws element outlines on a canvas, as a reference for the coordinate convention.

### For a host (desktop shell, test runner)

`window.galatsaBench` offers:

- `run(runs, engineId, { capture })`: resolves to `{ results, comparison }`.
- `events`: every `BenchEvent` so far. Each event is also dispatched on `window` as a `galatsa-bench` CustomEvent with the event as `detail`. Types: `settle-start`, `settle-end`, `calibrate-start`, `calibrate-end`, `load-start`, `load-end`, `run-start`, `hold-start`, `hold-end` (with `frame` and `label`), `run-end`.
- `setMemorySampler({ source, sample })`: an external memory sampler, called (without waiting) at `load-start`, `load-end`, `run-start`, each `hold-start` and `run-end`. Its samples go to `memory.external` in the result and, when present, are the preferred memory figure (`verdictInputs.peakMemory`). This is how a desktop shell can report the memory of the whole browser, which the page itself cannot see. A host can also listen to the events and sample on its own.
- A host that can take screenshots may set `window.galatsaBenchHostCapture = (rect) => Promise<dataUrl | Blob | null>`; capture runs use it for engines without `snapshot()`.

For `measureUserAgentSpecificMemory()` the page must be cross-origin isolated. The harness's Vite server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. A desktop shell that serves the page itself (for example Tauri on Windows, where WebView2 is Chromium) must send the same two headers, or the measurement is reported as unavailable.

## Adding an engine

An engine lives in its own package, depends on `@galatsa/bench` (`"workspace:*"`) and implements `BenchEngine`:

- `load(setup)`: add a canvas or elements to `setup.container` (an empty element of exactly the stage size), and prepare the scene. Its time is reported as `verdictInputs.loadMs`; work moved into it (pre-rendering the whole scene, say) shows there.
- `render(camera)`: draw one frame. Called from `requestAnimationFrame`, once per frame. A world point `(wx, wy)` is drawn at `((wx - camera.x) * camera.zoom + width / 2, (wy - camera.y) * camera.zoom + height / 2)` in CSS pixels; multiply by `setup.viewport.devicePixelRatio` for device pixels.
- `dispose()`: remove and free everything.
- `snapshot()` (optional): resolve to a PNG of exactly what is drawn, at device resolution. Used in capture runs. DOM engines, which cannot read back their own output, leave it out; the host's screenshot is used instead.
- `setup.reportTextSharp()`: call it when all visible text is drawn at full screen resolution for the current camera (see "Text sharpness" below). An engine whose text is always sharp may call it at the end of every `render()`.
- `setup.images.getBlob(assetId)`: the encoded JPEG of an image. Decoding it, and using a lower resolution when the image is small on screen, is the engine's job.

Rules: draw on the main thread (rendering in a worker, or into an OffscreenCanvas transferred to a worker, escapes the meter and is not allowed in the benchmark), and draw everything the camera sees in each frame. The meter cannot check what was drawn; the captures are there so that people can.

To get the same page for the engine, call `startHarness` from `@galatsa/bench/harness` with the engine (see `src/harness/main.ts`).

## The scene

`generateScene()` (seed 20261126, scene version 1) gives ten clusters of 9,600 x 5,400 world units in a 5 x 2 grid, 57,600 x 13,200 units in all. Each cluster has 120 shapes (the first is a backdrop the size of the cluster), 60 text boxes and 20 images, in mixed paint order:

- Shapes: rectangles, ellipses, triangles and lines, 40 to 2,400 units, some rotated, some translucent.
- Text boxes: body text (12 to 40 units), headings (48 to 140 units, bold) and fine print (2 to 8 units, readable only when zoomed in), in the generic families `sans-serif`, `serif` and `monospace`, with letters outside ASCII (æ, ø, å, é, ü). The box height is an estimate for culling; the engine wraps the text to the box width.
- Images: 200 image files with pixel counts spread evenly from 2 to 12 megapixels, in six aspect ratios, shown at 400 to 2,400 units wide.

The images hold **1,400 megapixels in total. Decoded at full size as RGBA they would need 5.6 GB**, so an engine has to decode at reduced size. Their pixels are generated (`src/images.ts`: gradient, flat shapes, a 1-pixel grid every 128 pixels, a little noise) and encoded to JPEG at quality 0.9 by the browser, once per page load and before any run; nothing is downloaded. In Chromium 158 the encoded files total about 317 MB and generating them took about 17 seconds on the development machine. The generated images are kept as Blobs for the life of the page, so every engine runs with this baseline of about 317 MB of encoded files in the page (where a browser keeps large Blobs is up to the browser).

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

A run first waits until the page is idle (at least 2 seconds, then until five idle callbacks in a row offer 40 ms, at most 10 seconds; Safari has no idle callbacks and only waits), so that garbage from generating the images or from a previous run does not land in it. Then it measures the display's refresh interval over 120 animation frames with nothing drawing (the trimmed mean of the frame timestamp differences), loads the engine, renders 60 warm-up frames and runs the camera run.

Per frame, in `frames` of the JSON result:

- `frameMs`: wall-clock time from the start of one animation-frame callback to the start of the next (`performance.now()`). This is the frame time. It includes `render()`, any other work the engine causes, and the browser's style, layout and paint on the main thread.
- `timestampMs`: the difference between the timestamps the browser passes to the callbacks, kept for reference only. These are display-frame start times, not durations: in headless Chromium a frame that blocks 30 ms read 16.7 ms and one that blocks 110 ms read 100 ms, and in Firefox and WebKitGTK they jitter.
- `renderMs`: time spent inside `render()`.
- `excluded`: frames left out of all statistics (paused for a capture).

`verdictInputs` holds the numbers to judge an engine by:

| Field                                | Meaning                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `refreshIntervalMs`, `refreshRateHz` | the display's measured refresh interval and rate                                              |
| `missedFrames`                       | frames over 1.5 refresh intervals (25 ms at 60 Hz): at least one refresh missed               |
| `longFrames`                         | frames over 2.5 refresh intervals (41.7 ms at 60 Hz): slower than half the refresh rate       |
| `missedFrames60Hz`, `longFrames60Hz` | the same against a 60 Hz display (25 and 41.7 ms), for comparing machines with other displays |
| `stalls`                             | frames over 100 ms, whatever the display                                                      |
| `frameMs`, `renderMs`                | count, mean, min, p50, p95, p99, max                                                          |
| `textSharp`                          | p50 and max latency to sharp text, and holds without a report                                 |
| `loadMs`                             | time in `load()`                                                                              |
| `peakMemory`                         | the most complete memory figure available, with its source                                    |
| `valid`, `problems`                  | whether something made the run unreliable                                                     |

Each count has `thresholdMs`, `count` and `ratio` (of the counted frames). At 60 Hz, a target such as "95 % of frames within 16.7 ms" reads as `missedFrames.ratio` at most 0.05; "95 % within 33 ms" as `longFrames.ratio` at most 0.05; "no frame over 100 ms" as `stalls.count` 0.

The thresholds sit halfway between whole refresh intervals, so that the jitter of normal frames does not count (wall-clock frame times of an empty engine at 60 Hz spread from about 16 to 18.5 ms in Chromium and more in WebKitGTK), while a frame that takes one refresh more does. On a 120 Hz display `missedFrames` is stricter than a 60 fps target; use `missedFrames60Hz` for that. A frame that overruns the refresh interval only slightly (17 to 25 ms at 60 Hz) counts as missed where the browser then waits for the next refresh (it reads about 33 ms), but not where the browser starts the next frame at once, as headless browsers do (it reads about 17 ms); `renderMs.p95` compared with the refresh interval shows such engines too.

`stats` has the same statistics for `frameMs`, `timestampMs` and `renderMs`, and `frameMs` per kind of segment (zoom, pan, flight, hold). `environment` records the browser, the stage position, the refresh measurement, the settle time and the timer resolution.

### Text sharpness

`textSharp` has one event per hold. `latencyMs` is the time from just before `render()` of the first still frame to the start of the first animation frame after the engine's first `reportTextSharp()`, so it is at least one refresh interval; `reportMs` is the time to the call itself; both are `null` if the engine did not report before the camera moved again.

This relies on the engine's word. An engine that zooms with CSS transforms leaves re-rasterising the text to the browser, which happens later and cannot be observed from the page, so its latency is a lower bound. The empty engine reports in every frame and so gets one refresh interval. Look at the captures before trusting a small figure.

### Memory

Memory is reported where the browser offers it and marked unavailable where it does not:

- `measureUserAgentSpecificMemory()` before load, after load and after the run (not at the peak, because it may wait for a garbage collection). Chromium only, and only on a cross-origin isolated page; not available in Chromium's separate headless shell. `--enable-blink-features=ForceEagerMeasureMemory` makes Chromium answer at once.
- `performance.memory` every 30 frames (Chromium only, JavaScript heap only). Chromium rounds the values unless started with `--enable-precise-memory-info`.
- An external sampler, if the host sets one (see above).

The first two cover neither decoded images nor GPU memory, so they understate what an engine uses, and Firefox and WebKitGTK offer neither. The 1.5 GB target can therefore only be checked with an external sampler (process memory, measured by a desktop shell) at the `hold-start` events of the run. Every engine carries the same baseline of about 317 MB of encoded image files in the page.

## Repeatability

`compareRuns(a, b)` compares the verdict inputs of two runs. A metric agrees when the difference is at most 5 % of the larger value or an absolute floor, whichever is larger: counts max(3, 0.2 % of the frames), refresh interval 0.5 ms, mean frame time 0.5 ms, render time 0.25 ms, text-sharp latency one refresh interval. Deciding: frames, refresh interval, missed frames, long frames, stalls, mean frame time, `render()` p50 and p95, text-sharp p50 and missing. Shown but not deciding: frame time p95 and max, `render()` max, text-sharp max and load time (one garbage-collection pause moves a maximum).

`tests/e2e/bench-repeatability.spec.ts` runs the empty and the synthetic engine twice each, in Chromium and Firefox, and requires agreement. `tests/e2e/bench-meter.spec.ts` checks that the meter counts deliberately slow frames, refuses a stage that does not fit, keeps the stage in place, and makes captures. Headless browsers pace frames with an even clock and do not wait for a display after a late frame, so these runs do not show how much a real display adds; that needs runs on real machines.
