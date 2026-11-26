# proto-dom: rendering engine prototype C (DOM elements with CSS transforms)

A throwaway prototype, written to be measured against the benchmark in [`bench/`](../../bench/README.md) and then discarded. Only the numbers and the findings below are meant to last. Every scene element becomes one element of the page, and the browser does layout, painting and text; the engine only decides what is in the page and where it goes.

## Running it

```sh
pnpm --filter @galatsa/proto-dom dev       # harness page with all variants, and /lab.html
pnpm --filter @galatsa/proto-dom build     # build/ (index.html and lab.html)
cd apps/proto-dom
pnpm exec playwright install chromium firefox
pnpm e2e --project=chromium text edit precision   # screenshots, editing, precision (1 minute)
BENCH_VARIANTS=dom pnpm e2e --project=chromium-gpu bench   # camera run (about 1 minute per variant)
PROFILE_VARIANT=dom pnpm e2e --project=chromium profile    # where the time goes (trace)
sh run-final.sh                                  # the runs reported below (about 25 minutes)
```

The Playwright tests build the pages and serve them with `vite preview`. Projects: `chromium` (the full Chromium in new headless mode, software rendering), `chromium-gpu` (the same with `--enable-gpu --ignore-gpu-blocklist --use-angle=gl`; `chrome://gpu` confirmed hardware rasterisation and compositing on the AMD Radeon 780M of the development machine) and `firefox` (Playwright's Firefox, headless). Playwright's WebKit did not start on the development machine (Arch Linux): it needs Ubuntu's `libicu74` and `libxml2`, so there are no WebKit numbers. The system's own WebKitGTK will be measured in the desktop shell.

Results are in `results/<project>/`: one JSON per benchmark run (`<variant>.json`, with the full bench result plus the browser's process memory and the engine's counters), `text/` (screenshots and sharpness scores), `edit/` (editing screenshots and summary), `precision-<variant>.json` and `precision/` (screenshots), and `profile-*.json`.

## How it works

Files: `src/engine.ts` (the engine), `src/image-levels.ts` (image level of detail), `src/engines.ts` (the measured variants), `src/lab.ts` (a test page with small scenes, a scriptable camera and editing), `e2e/` (the Playwright tests).

**Elements.** A rectangle, ellipse or line is a `<div>` (border, border radius, background); the stroke is centred on the outline as in canvas and SVG, by growing the box by half the stroke width. A triangle is a small inline `<svg>` with one `<polygon>`: CSS cannot stroke a non-rectangular outline (a `clip-path` cuts the border off), and SVG does it in one element. Text is a `<div>` with `white-space: pre-wrap`, wrapped by the browser to the box width. An image is an `<img>`. Paint order is the scene order, as `z-index`, so elements can be attached in any order.

**Placement (the candidate, "element" mode).** For every visible element the engine computes, in float64 and relative to the camera, where its centre lands on screen and writes one `matrix()` into `style.transform`. The browser never sees world coordinates, only screen-sized numbers, so precision does not depend on how far the camera is from the world origin. Shapes and images are laid out once in world units and scaled by the matrix (scaling them is exact). Text is laid out at a _layout zoom_: font size and box width in screen pixels. While the camera moves, the matrix scales text from its layout zoom, and text scaled by more than a factor of two is laid out again within a 6 ms budget per frame. When the camera stops, all visible text is laid out at the exact zoom (same budget, largest first). Above 1,000 px font size, text is laid out at 1,000 px and scaled by the matrix, because Chromium clamps `font-size` at 10,000 px and Firefox draws no glyph larger than about 2,000 px (both measured: larger text silently comes out at the clamped size, which moved a glyph edge by 160 px at zoom 1,000 before this was fixed).

**Greeking.** Text whose font is smaller than 4 device pixels on screen is drawn as stripes in its colour (a `repeating-linear-gradient` over the estimated box height) with its text content removed. It is unreadable at that size anyway; drawing it as glyphs was the largest single cost in the zoomed-out views (see the results). The stripes do not match the real line count, because the box height in the scene is an estimate.

**Culling.** Elements whose bounding circle is outside the view are removed from the document (`detach`). Measured alternatives: `display: none` (about the same) and keeping all 2,000 attached and leaving culling to the browser (much slower, see below). `content-visibility` was not tried: it skips the _contents_ of an off-screen element, but these elements have almost no contents, and their off-screen-ness depends on a transform the engine already computes.

**Images.** Level k of an image is the image at 1/2^k of its width. The engine asks for the coarsest level with at least one image pixel per device pixel (`devicePixelRatio` included). Levels are made in the background, three at a time, with `createImageBitmap(blob, { resizeWidth, resizeHeight })`, re-encoded as a small JPEG, and shown in the `<img>` through an object URL once `img.decode()` has finished, so the old level stays until the new one is ready. Level 0 is the original file. The cache keeps at most 120 megapixels of levels (least recently used go first; the coarsest level of every image stays). `load()` waits for the levels the first pose needs (all 200 images, small). The `<img>` route was chosen over a `<canvas>` per image to keep images in their parent's paint layer; a canvas variant (`dom-canvas`, decoded `ImageBitmap`s drawn into canvases) was measured and was no faster.

**Sharp text, and how it is reported.** The engine cannot see rasterisation. It reports sharp text in the first `render()` after the frame in which the camera stood still and the last text was laid out at the exact zoom (in `dom-layer-wc`: the frame that removed `will-change`). By then the browser has run style, layout and paint for that frame and committed it; rasterisation may still be in progress on other threads. The screenshots taken one and two frames after stopping (below) check the proxy: in every case they were already as sharp as the final image. Note that Playwright's screenshot itself waits for a new frame, so "one frame after" is at least one frame.

**Editing.** The text element itself becomes editable (`contenteditable="plaintext-only"`, falling back to `"true"`), so caret, selection, keyboard navigation, clipboard, undo and input methods are the browser's own. Double-click starts editing; the text is laid out at the exact zoom before it gets focus. The edited element is never culled while editing. `input` events copy the text back to the engine's model.

## Results

| Browser      | Variant                  | Display intervals > 33 ms | Wall-clock p95 (ms) | Wall-clock max (ms) | Wall-clock > 33 ms | Frames > 100 ms (wall clock) | render() mean / p95 / max (ms) | Text sharp p50 / max (ms) | Load   | Browser PSS peak (MiB, and growth from load) | JS heap peak (MiB) |
| ------------ | ------------------------ | ------------------------- | ------------------- | ------------------- | ------------------ | ---------------------------- | ------------------------------ | ------------------------- | ------ | -------------------------------------------- | ------------------ |
| chromium-gpu | **dom**                  | 191                       | 36.4                | 84.2                | 181                | 0                            | 0.93 / 4.5 / 23.3              | 16.8 / 48.1               | 3.9 s  | 1987 (+806)                                  | 26                 |
| chromium-gpu | **dom** (run 2)          | 205                       | 37.8                | 91.0                | 200                | 0                            | 0.98 / 4.5 / 15.8              | 20.0 / 45.2               | 4.0 s  | 2036 (+819)                                  | 24                 |
| chromium-gpu | dom-wc-text              | 242                       | 40.7                | 107.4               | 222                | 1                            | 0.98 / 4.5 / 17.2              | 16.8 / 60.2               | 4.1 s  | 2185 (+150)                                  | 38                 |
| chromium-gpu | dom-canvas               | 295                       | 41.3                | 89.8                | 239                | 0                            | 1.11 / 4.9 / 17.9              | 16.7 / 63.3               | 3.4 s  | 1959 (+706)                                  | 28                 |
| chromium-gpu | dom-nogreek              | 774                       | 173.9               | 305.1               | 608                | 241                          | 0.99 / 4.6 / 20.2              | 18.3 / 86.9               | 4.2 s  | 2095 (+161)                                  | 38                 |
| chromium-gpu | dom-nogreek-wc-text      | 221                       | 37.7                | 221.1               | 197                | 4                            | 0.92 / 4.2 / 30.3              | 16.8 / 57.4               | 3.9 s  | 2161 (+212)                                  | 30                 |
| chromium-gpu | dom-nogreek-wc-all       | 354                       | 152.2               | 1096.0              | 330                | 147                          | 0.93 / 4.6 / 18.5              | 17.3 / 454.1              | 4.0 s  | 2373 (+275)                                  | 37                 |
| chromium-gpu | dom-screen               | 711                       | 160.6               | 241.6               | 514                | 234                          | 0.98 / 5.0 / 16.9              | 15.7 / 71.9               | 4.1 s  | 2286 (+163)                                  | 37                 |
| chromium-gpu | dom-layer                | 678                       | 143.7               | 271.7               | 525                | 224                          | 0.26 / 0.5 / 18.1              | 16.8 / 21.0               | 4.1 s  | 2263 (+58)                                   | 27                 |
| chromium     | **dom**                  | 193                       | 34.4                | 88.7                | 153                | 0                            | 1.08 / 5.0 / 26.7              | 18.8 / 80.8               | 3.9 s  | 1463 (+781)                                  | 27                 |
| chromium     | **dom** (run 2)          | 147                       | 33.2                | 84.8                | 140                | 0                            | 0.99 / 4.6 / 25.2              | 18.0 / 45.4               | 4.0 s  | 1494 (+823)                                  | 22                 |
| chromium     | dom-wc-text              | 234                       | 34.6                | 84.7                | 164                | 0                            | 0.97 / 4.7 / 16.3              | 16.9 / 39.8               | 3.8 s  | 1754 (+275)                                  | 36                 |
| chromium     | dom-nogreek              | 535                       | 73.8                | 214.9               | 382                | 43                           | 1.19 / 5.1 / 43.4              | 20.5 / 127.5              | 3.4 s  | 1584 (+748)                                  | 30                 |
| chromium     | dom-screen               | 723                       | 114.8               | 247.5               | 448                | 177                          | 1.09 / 5.0 / 18.9              | 16.6 / 22.4               | 3.7 s  | 1643 (+871)                                  | 26                 |
| chromium     | dom-layer                | 495                       | 86.5                | 166.8               | 401                | 112                          | 0.27 / 0.6 / 17.2              | 16.6 / 53.0               | 3.5 s  | 1416 (+692)                                  | 9                  |
| chromium     | dom-layer-wc             | 567                       | 48.9                | 14184.4             | 365                | 44                           | 0.27 / 0.7 / 16.8              | 16.7 / 40.8               | 4.4 s  | 2043 (+651)                                  | 12                 |
| chromium     | dom-nogreek-cull-display | 567                       | 76.3                | 169.2               | 444                | 79                           | 1.17 / 5.3 / 19.5              | 17.0 / 160.4              | 4.4 s  | 1870 (+44)                                   | 41                 |
| chromium     | dom-nogreek-cull-none    | 2038                      | 128.2               | 219.0               | 1970               | 512                          | 0.94 / 4.7 / 18.3              | 59.7 / 172.5              | 4.6 s  | 1767 (+182)                                  | 35                 |
| firefox      | **dom**                  | 1165                      | 111.8               | 197.2               | 985                | 208                          | 2.00 / 9.6 / 48.9              | 21.4 / 294.4              | 10.8 s | 2062 (+720)                                  | –                  |
| firefox      | **dom** (run 2)          | 1181                      | 106.4               | 194.9               | 995                | 179                          | 1.95 / 9.2 / 27.4              | 21.4 / 247.9              | 9.8 s  | 2205 (+1068)                                 | –                  |
| firefox      | dom-nogreek              | 1351                      | 174.9               | 322.6               | 1165               | 340                          | 1.80 / 9.3 / 26.6              | 33.7 / 58.8               | 9.9 s  | 2402 (+373)                                  | –                  |
| firefox      | dom-layer                | 1230                      | 102.3               | 249.7               | 1010               | 155                          | 0.30 / 0.7 / 10.0              | 10.9 / 52.5               | 10.2 s | 2634 (+301)                                  | –                  |

Read the columns this way:

- _Display intervals > 33 ms_: frames whose animation-frame timestamps were more than 33 ms apart (vsync-rounded, as the bench README explains).
- _Wall-clock_: `callbackIntervalMs`, the time between the starts of consecutive animation-frame callbacks. For a DOM engine almost all the cost is outside `render()` (style, layout, paint, raster, compositing), so these are the numbers to read. `render()` itself is cheap in every variant.
- _Text sharp_: the bench's latency from the first still frame to `reportTextSharp()`, per hold (21 holds), as reported by the engine (see the proxy above).
- _Browser PSS peak_: the sum of the proportional set size of all the browser's processes (Linux `/proc`, sampled every 250 ms from load to the end of the run). Includes decoded images, layers and GPU buffers mapped into those processes, and the benchmark's own 317 MB of generated JPEG files, which the page holds as Blobs. The number in brackets is the growth from the start of `load()`. Several variants ran one after another in the same page, and only the first one in a page starts from a clean state; the candidate runs did, the others mostly started from what earlier runs had left behind, so their growth is not comparable. The JavaScript heap (last column, Chromium only) is much smaller.

One camera run each (2,775 frames, 1,280 x 720 CSS pixels, `devicePixelRatio` 1, 60 Hz headless frame clock), on the development machine (AMD Ryzen with Radeon 780M, 16 threads, 30 GB, Arch Linux, Chromium 158 and Playwright's Firefox, 26 November 2026). Headless Chromium and Firefox are not the user's desktop: `chromium-gpu` is the closest, and the final comparison will be made in the desktop shell with the new meter.

Runs marked **dom** are the candidate, run twice to show the spread. The candidate runs, `dom-nogreek`, `dom-wc-text`, `dom-screen` and `dom-layer` in `chromium-gpu` were made after the last engine change (text laid out at no more than 1,000 px); the others before it. That change only affects text larger than 1,000 px on screen (headings near zoom 20) and does not touch the "layer" variants. Each JSON's `renamedFrom` field marks a run made under an earlier variant name.

What the numbers say:

- **The candidate in Chromium:** wall-clock p95 33 to 38 ms, no frame over 100 ms, longest frame 84 to 91 ms, in both software and GPU Chromium. The 50th percentile is a steady 16.7 ms everywhere; the slow frames are in the zoomed-out parts (start of the zoom-in, end of the zoom-out, the flight to the pan, and each flight's zoomed-out middle), where 1,000 to 2,000 elements are visible, and in the first frames of the hold after the zoom-out, where all visible text is laid out again (p95 50 ms in that hold). The proposed target (95 % under 16.7 ms in Chromium) is **not** met; the target of no frame over 100 ms is.
- **Greeking matters most, and more with a GPU.** Without it (`dom-nogreek`), GPU Chromium was _slower_ than software Chromium: p95 174 ms and 241 frames over 100 ms, against 74 ms and 43 in software. Text drawn at a scale that changes every frame defeats the glyph caches: every frame rasterises every visible glyph at a new size, and with GPU rasterisation each new glyph also goes into a texture atlas. A trace (`profile-dom-nogreek.json`) shows the main thread busy for about 15 s of a 69 s run (style 3.1 s, layout 3.1 s, paint 1.5 s, layerize 2.2 s, `render()` 3.1 s) and the raster threads for 144 s in software Chromium; with the GPU, 75 s of raster tasks plus 22 s on the GPU thread. The cost is in rasterisation, not in style or layout.
- **Text on its own compositor layer while moving** (`will-change: transform` on each text element, `dom-wc-text`) helps as much as greeking when there is no greeking (`dom-nogreek-wc-text`: p95 38 ms in GPU Chromium), but on top of greeking it adds nothing, uses more memory and blurs moving text slightly (see the screenshots). Giving _every_ element a layer while moving (`dom-nogreek-wc-all`) is bad: up to 1.1 s frames when the layers are created and dropped.
- **One world container with one transform** (`dom-layer`, the usual web whiteboard approach) has the cheapest `render()` (0.26 ms) but is not faster in total (p95 87 ms software, 144 ms GPU, no greeking), has the precision problems below, and with `will-change` while moving (`dom-layer-wc`) it stalled for **14 seconds**, twice, during the zoom-out in software Chromium: the layer kept the raster scale of zoom 20 while the view grew to cover the whole scene.
- **Laying out all text at the exact zoom every frame** (`dom-screen`) is the slowest Chromium variant without layers (p95 115 ms software, 161 ms GPU), as expected.
- **Culling** by removing elements from the document is essential: with all 2,000 elements attached (`dom-nogreek-cull-none`) 1,970 of 2,775 frames took over 33 ms, against 382 when detached. `display: none` instead of removal is about the same as removal.
- **Firefox** is much slower with every variant: the candidate has p95 106 to 112 ms and about 180 to 210 frames over 100 ms; `render()` itself is twice as slow (2 ms mean). A run made before the 1,000 px cap gave p95 95 ms and 112 frames over 100 ms, so the cap may cost something in Firefox (text above 1,000 px drawn scaled), or this is run-to-run spread; not resolved. Playwright's Firefox ran headless, probably with software rendering (not checked).
- **Load** (`load()`: create the engine, decode the 200 smallest image levels for the first pose) takes 3.4 to 4.2 s in Chromium and about 10 s in Firefox, almost all of it decoding: `createImageBitmap` with a resize still decodes each 2 to 12 megapixel JPEG at full size first (inferred from the time: about 1,400 megapixels in 3.5 s on three parallel decodes). A real program would store small levels in the file.
- **Memory:** the browser's processes grew by about 700 to 800 MiB from the start of `load()` to the peak of the run in all three browsers (peaks of 1,463 MiB in software Chromium, 1,987 MiB with the GPU and 2,062 MiB in Firefox, all including the 317 MB of generated JPEGs and the browser itself). The proposed limit is 1.5 GB. The image level cache is limited to 120 megapixels (480 MB decoded), and the browser keeps its own decoded copies of the `<img>` levels it paints, which this engine cannot control. The JavaScript heap stays under 40 MiB.
- **Text sharp:** the engine reported sharp text 16 to 20 ms (median) after the camera stopped, at most 48 to 81 ms in Chromium (one to five frames, when much text had to be laid out again within the 6 ms budget), and up to 294 ms in Firefox. Every hold was reported.

## Text: four zooms, motion and after stopping

`results/<project>/text/` has the same text card (a serif heading, sans-serif body text with æ ø å é ü, and 3-unit monospace fine print) at zoom 0.1, 1, 8 and 40 (`<variant>-zoom-<z>.png`, and the fine print at 40 in `<variant>-fine-zoom-40.png`), for five variants. For motion it zooms from 1 to 8 and from 8 to 40 over 30 frames, keeps the camera moving at the target by a millionth of a pixel, and takes screenshots during motion (`-during`), one and two frames after stopping, after the engine reported sharp text, and 30 frames later. `<variant>-summary.json` has a sharpness score per screenshot (mean brightness difference between neighbouring pixels; same content, so higher is sharper).

What the screenshots show (Chromium software and GPU, and Firefox; the sharpness scores are in the summaries):

- **The candidate (`dom`) is sharp during motion as well as after it**, in all three browsers: its elements have no compositor layer, so the browser rasterises the scaled text again in every frame (that is what costs time above). The "during" score equals the "after" score to three decimals (1 to 8: 2.276 against 2.276 in Chromium).
- **`dom-layer-wc` (one container with `will-change` while moving) is visibly blurred during motion in Chromium** (`dom-layer-wc-move-1-to-8-during.png`, score 1.87 against 2.28): the layer keeps the raster of zoom 1 and the compositor scales it by 8. It is sharp in the first screenshot after stopping. Zooming from 8 to 40 blurs much less (0.929 against 0.930), probably because Chromium re-rasterised the layer at some point during the 30 frames of the animation. Firefox showed no blur with `will-change`.
- **`dom-wc-text`** (a layer per text while moving) blurs slightly during motion in Chromium (2.266 against 2.276) and is sharp after stopping.
- **After stopping**, every variant was sharp in the first screenshot, so none showed blur that lasts. Each engine's report of sharp text came 30 to 63 ms after the lab asked for it (this includes the frame that applies the new camera).
- **Greeking** is visible at zoom 0.1 and 1 in the candidate: the 3-unit fine print (and, at 0.1, the 16-unit body text, 1.6 px high) are stripes instead of glyphs (compare `dom-zoom-1.png` with `dom-screen-zoom-1.png`). The stripes span the estimated box height, so they show more lines than the text has.
- **At zoom 40** the body text is 640 px and the fine print 120 px, laid out at those sizes, and sharp.
- The scores do not differ between `dom-screen` and `dom-layer` when still, but `dom-layer` lays text out in world units, and browser layout positions are multiples of 1/64 CSS pixel, here 1/64 world unit, which is 0.6 screen pixels at zoom 40; it moves glyphs by a fraction of a pixel (score 0.930230 against 0.930231).

## Editing

`e2e/edit.spec.ts` passes in Chromium (software and GPU) and Firefox, at zoom 2 on the body text:

- typing at the start (`Control+Home`, then text);
- caret movement (`Control+End`, four times `ArrowLeft`, then a character lands before "789.");
- selection with the keyboard (`Shift+ArrowRight` three times selects "Hei", typing replaces it) and with the mouse (double-click selects a word);
- paste of rich text (`<b>fet</b> <i>tekst</i>`) arrives as plain "fet tekst" with no elements inside the text;
- IME composition (Chromium, through the DevTools protocol `Input.imeSetComposition` and `Input.insertText`): composing "に", "にほ" shows the composition highlighted in place, committing "日本" replaces it; the events are `compositionstart`, `compositionupdate` ×3, `compositionend:日本`. Firefox has no such protocol in Playwright, so IME is not tested there;
- the edited text renders, and is laid out again at zoom 8 with the edits kept (`edit/3-after-edit.png`, `edit/4-after-edit-zoom-8.png`, `edit/2-ime-composing.png`).

Limits found or expected, not solved here:

- Editing very small or very large text in place is not useful: at zoom 0.1 body text is 1.6 px high. A real editor needs to zoom to the text or show an overlay at a readable size.
- Rotated text is editable (the browser handles caret and selection under the transform), but was not tested.
- While the camera moves during editing, the edited text is scaled by its matrix and only laid out again when the scale drifts by two or the camera stops, so the caret is scaled with it in between.
- `plaintext-only` is supported in Chromium and in Firefox from version 136; older Firefox falls back to `contenteditable="true"`, which accepts rich paste and would need a paste handler.
- Undo is the browser's own and covers only typing inside one editing session; it knows nothing of the document model. Production would route edits through the document model (Yjs) and its undo, which means handling `beforeinput` and taking over most of what the browser does here.
- Text wrapping is the browser's: line breaks can change between zoom levels when glyph advances do not scale exactly, so a paragraph can re-wrap when the camera stops. Not seen in the screenshots, but nothing prevents it.

## Precision at extreme zoom

`results/<project>/precision-<variant>.json`: the camera homes in on the left edge of the stem of an "H" (12 world units, at x = 28,800) and on the left edge of a rectangle, at zoom 10 to 10^8, then moves right by one screen pixel (1 / zoom world units) three times. The numbers are how far the edge moved on screen for each move; 1 is right.

| Browser      | Variant   | Edge  | 10^1  | 10^2  | 10^3  | 10^4  | 10^5  | 10^6  | 10^7  | 10^8   |
| ------------ | --------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ------ |
| chromium     | dom       | glyph | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 0 16 0 |
| chromium     | dom       | rect  | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1  |
| chromium     | dom-layer | glyph | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 0 16 0 |
| chromium     | dom-layer | rect  | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | lost  | lost  | lost   |
| chromium-gpu | dom       | glyph | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 0 0 8  |
| chromium-gpu | dom       | rect  | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1  |
| chromium-gpu | dom-layer | glyph | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 0 0 8  |
| chromium-gpu | dom-layer | rect  | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | lost  | lost  | lost   |
| firefox      | dom       | glyph | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 0 0 0  |
| firefox      | dom       | rect  | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1  |
| firefox      | dom-layer | glyph | 1 1 1 | 1 1 1 | 2 0 2 | 0 0 0 | 0 0 0 | lost  | lost  | lost   |
| firefox      | dom-layer | rect  | 1 1 1 | 1 1 1 | 0 2 2 | 0 0 0 | 0 0 0 | lost  | lost  | lost   |

"lost": the edge was not found on screen (nothing drawn there, or a different picture).

- The candidate's camera-relative matrices keep the rectangle exact to 10^8 in all three browsers (the browser gets numbers of a few hundred pixels plus a scale).
- Glyphs are exact to 10^7 in all three. At 10^8 the glyph edge jumps by 8 to 16 px in Chromium and does not move in Firefox: the glyph outline is drawn under a transform whose scale is about 10^6 (laid out at 1,000 px, scaled up), and the rasteriser works in float32. Fixing that would mean placing the element's origin next to the visible part of the glyph, which the DOM does not allow for text inside a paragraph.
- The classic "one world container with one transform" (`dom-layer`) loses the rectangle from 10^6 in Chromium (nothing drawn) and both edges from 10^3 in Firefox (edges move by 0 or 2 px). This is the strongest reason not to use one big transformed container.
- Not tested: precision far from the world origin with world coordinates instead of the scene's 28,800, and zoom between frames of a nested document (the spec's anchored camera). Both are handled by the same camera-relative arithmetic in the engine, but are unmeasured.

## What was hard, what is not done, and what would be expensive

**What was hard**

- Finding where the time goes. `render()` takes about 1 ms; everything else happens in the browser after it, mostly in rasterisation on other threads, and only the wall-clock frame intervals and a trace show it. The display intervals in headless Chromium hid much of it.
- The GPU making things worse. Without greeking, GPU rasterisation was 2.4 times slower than software at p95. The cause (text drawn at a new scale in every frame) is inherent to zooming text that the browser rasterises, and the two remedies (do not draw small text, or freeze text into layers while moving) each have a visible cost.
- Silent limits in the browsers: Chromium clamps `font-size` at 10,000 px and Firefox draws glyphs no larger than about 2,000 px, without any error; Chromium's `will-change` layer kept a zoom-20 raster scale while zooming out and stalled for 14 s; a single world container loses precision from zoom 10^3 (Firefox) or 10^6 (Chromium).
- Telling whether text is really sharp. The engine cannot observe rasterisation, so `reportTextSharp()` is a proxy one frame after the final layout, checked only by screenshots on a test page.

**Not done**

- WebKit: Playwright's build does not start on Arch Linux; WebKitGTK, which matters most for the desktop shell on Linux, is unmeasured.
- `devicePixelRatio` other than 1 was not measured. The engine uses it for image levels and greeking; text and shapes are left to the browser, which handles it by itself.
- No tiling of very large images: at zoom 20, a full 12 megapixel image is decoded and shown although only part of it is visible.
- Editing: no undo through a document model, no rich text, editing of rotated text not tested, no overlay for editing text that is very small or very large on screen.
- No measurement of precision far from the world origin or of anchoring the camera in frames.
- Repeat runs only for the candidate (two in each browser); the other variants ran once, so differences of a few milliseconds between them mean nothing.

**What would be expensive to make production-ready**

- _Frame time._ The candidate misses the 16.7 ms target in Chromium (p95 33 to 38 ms) and badly misses 33 ms in Firefox (p95 about 110 ms). The cost is rasterising everything visible in every frame, because every element's transform changes. Getting it down means freezing content into compositor layers while moving (blurred motion, layer memory, and the Chromium stall above to work around), drawing less (more level of detail for text, shapes and images in zoomed-out views), or showing zoomed-out views from a cached picture. All of this is engine work the browser does not do for us, and it behaves differently in Chromium, Firefox and WebKit.
- _Text sharpness._ Sharp text during motion comes free in this design (it is what costs the frame time); sharp text after stopping took one to five frames. Making motion cheap without losing sharpness is the expensive part.
- _Text layout._ The browser lays out text, so the result follows the browser and the installed fonts, and can differ between Chromium, Firefox and WebKit and between machines. Presentations would look different on different systems unless fonts are bundled and wrapping is checked, and text could re-wrap when the camera stops.
- _Editing._ The DOM's real advantage: caret, selection, clipboard, IME, and (not tested) accessibility and spell checking come with the browser, and the tests show they work in place, scaled, in two browser engines. Connecting them to a shared document model (Yjs) with its own undo, and keeping `contenteditable` from producing markup, is known but substantial work.
- _Precision._ Camera-relative matrices in float64 give exact positions to zoom 10^8 for boxes and 10^7 for glyphs in Chromium and Firefox. Beyond 10^7 for text, the browser's float32 rasterisation decides, and the DOM offers no way around it.
- _Memory._ The browser keeps decoded copies of the `<img>` levels it paints and frees them when it likes. The browser processes grew by 700 to 800 MiB during the candidate's run, on top of 0.7 to 1.3 GiB before it, so the proposed 1.5 GB limit is not met in GPU Chromium or Firefox. Controlling this means owning image memory (canvases or WebGL textures), which takes away part of the DOM's simplicity.
- _Image level of detail._ Each new level costs a full decode of the original (about 1,000 to 1,200 decodes per run); a production engine would store levels or tiles in the file and decode only those.
- _Cross-browser differences._ Every limit above was different in Chromium and Firefox (font size clamps, `will-change` behaviour, precision of a single container, overall speed by a factor of three). WebKitGTK will add a third set. A DOM engine inherits all of them, and the engine can fix few of them.

## Problems noticed in the benchmark

- `intervalMs` (display intervals) is vsync-rounded and in headless Chromium hides long frames (known; the wall-clock numbers are reported here instead).
- The text-sharp clock stops when `reportTextSharp()` is called, not when the frame is shown (known, being changed).
- The harness's memory numbers do not include decoded images, layers or GPU memory, which for a DOM engine are most of the memory. The PSS numbers here come from `/proc` in the test and include the benchmark's own 317 MB of generated JPEG Blobs.
- The text box height in the scene is an estimate; an engine that culls by the box can cull text that wraps to more lines than estimated. This engine culls by the bounding circle, which leaves a margin.
- The images take about 17 s to generate on every page load, so the tests reuse one page for several variants.
