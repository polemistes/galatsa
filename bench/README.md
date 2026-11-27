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

On the harness page, pick an engine and press **Run** or **Run twice and compare**, then **Download JSON**. **Run with captures** keeps an image of the drawing area at the end of each hold, for looking at what the engine drew; it pauses the run for each image, so its result is marked as a capture run and is not valid for decisions. Use the built page (`build` and `preview`) for real measurements; the dev server serves unbundled modules.

During a run:

- Keep the window visible and leave it alone. Browsers slow down animation frames in hidden pages; a result whose page was hidden or whose window was resized is marked as not valid (`verdictInputs.valid` and `problems`).
- The drawing area (the stage) is fixed at the top-left corner of the window and drawn above everything else, with the controls below it; the page is scrolled to the top and cannot scroll while a run lasts. A run refuses to start unless the whole stage is inside the window and nothing covers it (checked with `elementFromPoint` at its centre and corners), because browsers skip painting what is off-screen or covered.
- The stage is 960 x 540 CSS pixels by default, the size the camera run is framed for. It fits in a desktop window on common laptop screens, including 1920 x 1080 at 150 % and 175 % scaling (1280 x 720 and 1097 x 617 CSS pixels for the whole screen), so all machines can use the same size. `?width=` and `?height=` choose another size, but results with different sizes are not comparable. A desktop window must offer at least 960 x 540 CSS pixels of content (Tauri's default 800 x 600 window does not).

Query parameters, for automated runs: `engine=<id>`, `runs=<n>` (start at once), `capture=1` (with `runs`), `width` and `height` (stage size in CSS pixels), `memory=0` (skip `measureUserAgentSpecificMemory`), `reduced=0` (generate only the original images, as the first versions of the bench did) and `decoder=imagedecoder|worker|main` (how the `renderer` engine decodes images; default what the browser supports best).

The page has four engines. `renderer` is the real renderer (`@galatsa/renderer`, `src/engines/renderer.ts`): the scene becomes a document snapshot of three bench element types that draw through the renderer's `DrawContext`, and images come from the reduced versions (see "The scene"), so loading decodes only the smallest version of each image. `pnpm --filter @galatsa/e2e exec playwright test bench-renderer` runs it in Chromium and Firefox against the targets, with memory sampled from `/proc` after a run of the empty engine. The other three are not candidates: `noop` draws nothing and measures the meter itself; `synthetic` keeps the main thread busy for a seeded time per frame (the same in every run: 70 % of frames 2 to 12 ms, 20 % 27 to 31 ms, 9.5 % 48 to 60 ms and 0.5 % 105 to 130 ms, all away from the targets' thresholds), to check the meter with an engine that misses targets; `outline` draws element outlines on a canvas, as a reference for the coordinate convention.

### For a host (desktop shell, test runner)

`window.galatsaBench` offers:

- `run(runs, engineId, { capture })`: resolves to `{ results, comparison }`.
- `events`: every `BenchEvent` so far. Each event is also dispatched on `window` as a `galatsa-bench` CustomEvent with the event as `detail`. Types: `settle-start`, `settle-end`, `calibrate-start`, `calibrate-end`, `load-start`, `load-end`, `run-start`, `hold-start`, `hold-end` (with `frame` and `label`), `run-end`.
- `setMemorySampler({ source, sample, intervalMs })`: the host's memory sampler. The runner calls `sample()` every `intervalMs` (default 250 ms) from the start of `load()` to the end of the run, and at `load-start`, `load-end`, `run-start`, each `hold-start` and `run-end`, without waiting for the answers; after the run it waits at most 5 seconds for outstanding answers (`memory.external.unanswered` counts the rest). `sample()` must answer quickly and must not block the page. Its peak is the only memory figure the verdict uses.
- A host that can take screenshots may set `window.galatsaBenchHostCapture = (rect) => Promise<dataUrl | Blob | null>`; capture runs use it for engines without `snapshot()`.

For `measureUserAgentSpecificMemory()` the page must be cross-origin isolated. The harness's Vite server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. A desktop shell that serves the page itself (for example Tauri on Windows, where WebView2 is Chromium) must send the same two headers, or the measurement is reported as unavailable. These figures are informational only (see "Memory").

Risks for the desktop shell, from memory and not checked here: WKWebView on macOS may cap animation frames near 60 Hz by default and at 30 Hz in Low Power Mode (the meter then flags the run); the Tauri configuration that sends COOP and COEP may interfere with its IPC; and a macOS host may not be allowed to read the memory of WebKit's WebContent process, without which the memory target cannot be judged there.

## Adding an engine

An engine lives in its own package, depends on `@galatsa/bench` (`"workspace:*"`) and implements `BenchEngine`:

- `load(setup)`: add a canvas or elements to `setup.container` (an empty element of exactly the stage size), and prepare the scene. Its time is reported as `verdictInputs.loadMs`; work moved into it (pre-rendering the whole scene, say) shows there.
- `render(camera)`: draw one frame. Called from `requestAnimationFrame`, once per frame. A world point `(wx, wy)` is drawn at `((wx - camera.x) * camera.zoom + width / 2, (wy - camera.y) * camera.zoom + height / 2)` in CSS pixels; multiply by `setup.viewport.devicePixelRatio` for device pixels.
- `dispose()`: remove and free everything.
- `snapshot()` (optional): resolve to a PNG of exactly what is drawn, at device resolution. Used in capture runs. DOM engines, which cannot read back their own output, leave it out; the host's screenshot is used instead.
- `setup.reportTextSharp()`: call it when all visible text is drawn at full screen resolution for the current camera (see "Text sharpness" below). An engine whose text is always sharp may call it at the end of every `render()`.
- `setup.images.getBlob(assetId)`: the encoded JPEG of an image. Decoding it, and using a lower resolution when the image is small on screen, is the engine's job.
- `setup.images.getReduced?.(assetId)`: reduced-size versions of the image (JPEG, smallest first, the original not included), as a document stores them with each image.

Rules: draw on the main thread (rendering in a worker, or into an OffscreenCanvas transferred to a worker, escapes the meter and is not allowed in the benchmark), and draw everything the camera sees in each frame. The meter cannot check what was drawn; the captures are there so that people can.

To get the same page for the engine, call `startHarness` from `@galatsa/bench/harness` with the engine (see `src/harness/main.ts`).

## The scene

`generateScene()` (seed 20261126, scene version 1) gives ten clusters of 9,600 x 5,400 world units in a 5 x 2 grid, 57,600 x 13,200 units in all. Each cluster has 120 shapes (the first is a backdrop the size of the cluster), 60 text boxes and 20 images, in mixed paint order:

- Shapes: rectangles, ellipses, triangles and lines, 40 to 2,400 units, some rotated, some translucent.
- Text boxes: body text (12 to 40 units), headings (48 to 140 units, bold) and fine print (2 to 8 units, readable only when zoomed in), in the generic families `sans-serif`, `serif` and `monospace`, with letters outside ASCII (æ, ø, å, é, ü). The box height is an estimate for culling; the engine wraps the text to the box width.
- Images: 200 image files with pixel counts spread evenly from 2 to 12 megapixels, in six aspect ratios, shown at 400 to 2,400 units wide.

The images hold **1,400 megapixels in total. Decoded at full size as RGBA they would need 5.6 GB**, so an engine has to decode at reduced size.

With each original the bench also makes reduced-size versions, as a document stores them with each image: halves of the original down to a long side of 256 pixels (`reducedSizes` in `src/image-store.ts`), each scaled down from the next larger one with high-quality smoothing and encoded the same way. In Chromium 158 they add about 78 MB of encoded files (`scene.encodedReducedImageBytes` in the result) to the baseline every engine runs with; image generation took 28 seconds in one run with them, against about 17 without (different runs, the machine busy with other work). `reduced=0` leaves them out. Their pixels are generated (`src/images.ts`: gradient, flat shapes, a 1-pixel grid every 128 pixels, a little noise) and encoded to JPEG at quality 0.9 by the browser, once per page load and before any run; nothing is downloaded. In Chromium 158 the encoded files total about 317 MB and generating them took about 17 seconds on the development machine. The generated images are kept as Blobs for the life of the page, so every engine runs with this baseline of about 317 MB of encoded files in the page (where a browser keeps large Blobs is up to the browser).

The scene uses only integer arithmetic and exactly rounded floating-point operations, so it is bit-identical in every JavaScript engine. A unit test pins its hash. The image pixels are identical everywhere too; the encoded JPEG bytes differ between browsers.

## The camera run

`createCameraRun(scene)` gives 2,775 poses, one per frame, which take 46.25 seconds at 60 frames per second:

1. Zoom in from 0.02 to 20 on a text box near the middle of the scene (360 frames), hold. At zoom 0.02 the 960-pixel view covers 48,000 of the scene's 57,600 units, so nearly all of it is in view; at zoom 20 the view's top-left corner is the text box's top-left corner.
2. Zoom back out to 0.02 (360 frames), hold.
3. Fly to the left edge (90 frames), pan across the top row at zoom 0.15 (480 frames), hold.
4. Fly through ten stops (90 frames each, with a hold at each stop). The stops alternate between the two rows and look at a whole cluster, at the largest text box or at the largest image of a cluster. Flights zoom out and in as in van Wijk and Nuij, "Smooth and efficient zooming and panning" (IEEE InfoVis 2003), never below zoom 0.02.

A hold is 45 frames (750 ms at 60 Hz) of a still camera. The run is framed for a 960 x 540 viewport; other sizes see more or less around the same centre. Because the run is a list of frames, every engine renders the same poses; a slow engine takes longer instead of skipping poses.

The poses use `Math.exp`, `Math.log` and hyperbolic functions, which JavaScript engines may round differently in the last bits, so poses can differ between browsers by about 1e-15 relative. A unit test pins their hash at 9 significant digits.

## What is measured

A run first settles: it waits at least 2 seconds; then, where the browser has `requestIdleCallback`, until five idle callbacks in a row offer 40 ms; then until frames come steadily (two windows of 30 frames with 90 % of intervals near their median and medians within 3 %; three windows in browsers without idle callbacks, such as WebKit); at most 15 seconds. Then it measures the display's refresh interval over 120 idle frames: the median of the frame timestamp differences, then the mean of those within 25 % of it (robust to doubled frames and to the alternating timestamps of Firefox), retried up to three times until steady. It loads the engine, renders 60 warm-up frames, runs the camera run, and measures the refresh interval again.

Per frame, in `frames` of the JSON result:

- `workMs`: main-thread time of the frame, from the start of its animation-frame callback to the first task after the browser's rendering step (a message posted after `render()`), or to the start of the next callback if that comes first (WebKit sometimes runs the next callback before delivering the message). It includes `render()` and the browser's style, layout and paint on the main thread, and no display rounds it. It does not see rasterisation or GPU work on other threads.
- `frameMs`: wall-clock interval between the starts of consecutive callbacks: what the display paced. On a vsync-paced display it is a whole number of refreshes; it also shows delays from other threads.
- `timestampMs`: differences of the timestamps the browser passes to the callbacks, for reference only (display-frame start times, not durations).
- `renderMs`: time inside `render()`.
- `excluded`: frames left out of all statistics (paused for a capture).

### The targets

`verdictInputs.targets` judges the run against the proposed targets, with `pass: true`, `false`, or `null` where the run cannot tell:

| Target                                           | Field                | Pass when                                                                 |
| ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------- |
| 95 % of frames within 16.7 ms (Chromium)         | `targets.frames16_7` | `ratio` at most 0.05                                                      |
| 95 % of frames within 33 ms (WebKitGTK, Firefox) | `targets.frames33`   | `ratio` at most 0.05                                                      |
| no frame over 100 ms                             | `targets.stalls`     | `count` 0 (wall clock or work over 100 ms)                                |
| text sharp within 200 ms after the camera stops  | `targets.textSharp`  | `maxMs` at most 200 and `missing` 0                                       |
| memory at most 1.5 GB                            | `targets.memory`     | host sampler peak at most 1.5 x 10^9 bytes; `null` without a host sampler |

A frame counts against a frame-time target when its `workMs` is over the target, or when the display shows it later than the target. The display can only judge where the target is a whole number of refresh intervals (within 10 % of one), because a vsync-paced display only shows whole numbers of refreshes: 16.7 ms at 60, 120 and 240 Hz, 33 ms at 60, 120 and 240 Hz. There the threshold sits half a refresh above that number (25 ms for 16.7 ms at 60 Hz, 20.8 ms at 120 Hz; 41.7 ms for 33 ms at 60 Hz), away from the values intervals take. At 75, 100 or 144 Hz a frame shown after two refreshes may have taken more or less than the target, so the target is judged by work alone (`judgedBy: "work only"`), and delays outside the main thread are not counted; `missedRefreshes` still shows them for that display. Each frame check lists `workOver`, `presentedOver` and the thresholds used.

`verdictInputs` also has `missedRefreshes` and `longRefreshes` (frames over 1.5 and 2.5 refresh intervals on this display), statistics for `frameMs`, `workMs` and `renderMs`, `textSharp`, `loadMs`, `peakMemory`, and `valid` with `problems`. A run is not valid for a decision when the page was hidden, the window resized, the stage not fully visible or covered, frames never became steady, the refresh calibration was unsteady, the display ran at about 30 Hz (a low-power mode) or at a rate that is not a usual display rate, the refresh interval changed during the run by more than 3 %, or it was a capture run.

### Text sharpness

`textSharp` has one event per hold. The clock starts just before `render()` of the stop frame: the last frame of the movement, which already shows the final pose (`stopFrame`). It stops at the start of the first animation frame after the engine's first `reportTextSharp()`, so the result is at least one refresh interval; `reportMs` is the time to the call itself; both are `null` if the engine did not report before the camera moved again. An engine that detects stillness by comparing poses learns it one frame after the stop frame, and that frame is counted, as a viewer would see it.

This relies on the engine's word. An engine that zooms with CSS transforms leaves re-rasterising the text to the browser, which happens later and cannot be observed from the page, so its latency is a lower bound. Look at the captures before trusting a small figure.

### Memory

The memory target is judged only from the host's sampler (`setMemorySampler`), the memory of the whole program as the operating system sees it, sampled through the run. The page cannot see that memory: the browser's own figures cover the JavaScript heap and little else (in one run of a canvas engine with a GPU, 9.7 MB from `measureUserAgentSpecificMemory()` against 1,610 MiB of process memory, 984 MiB with the empty engine), so without a host sampler `targets.memory` is `null`. Every engine carries the same baseline of about 317 MB of encoded image files in the page.

For information only, the result also has `measureUserAgentSpecificMemory()` before load, after load and after the run (Chromium, cross-origin isolated pages only; not in Chromium's separate headless shell; `--enable-blink-features=ForceEagerMeasureMemory` makes it answer at once) and `performance.memory` every 30 frames (Chromium, JavaScript heap only, rounded unless Chromium runs with `--enable-precise-memory-info`). Firefox and WebKitGTK offer neither.

## Repeatability

`compareRuns(a, b)` compares two runs by their verdicts: they agree when every target gets the same verdict (pass, fail or cannot judge) in both. It also lists raw differences of the main numbers, each with an allowance of 5 % or an absolute floor (counts max(3, 0.2 % of the frames), refresh interval and mean frame time 0.5 ms, work and render p95 1 ms, text-sharp latency one refresh interval), for judging how steady the meter is; those do not decide. A real engine's counts vary more between runs than the empty engine's (two runs of a canvas engine prototype in headless Chromium: 17 against 5 frames over 16.7 ms, 0.61 % and 0.18 %, and load times of 1,082 against 916 ms), while its verdict stays the same; a run whose ratio lies near a target's limit can flip, and comparing verdicts shows that.

`tests/e2e/bench-repeatability.spec.ts` runs the empty and the synthetic engine twice each, in Chromium and Firefox, and requires the same verdicts and raw numbers within their allowances. `tests/e2e/bench-meter.spec.ts` checks that the meter counts deliberately slow frames, refuses a stage that does not fit, keeps the stage in place and on top, and makes captures. `src/stats.test.ts` feeds vsync-quantised frames at 60, 75, 100, 120, 144 and 240 Hz through the targets. Headless browsers pace frames with an even clock and do not wait for a display after a late frame, so the browser tests do not show how much a real display adds; that needs runs on real machines.
