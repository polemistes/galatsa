# @galatsa/proto-konva

A throwaway prototype of a rendering engine built on [Konva](https://konvajs.org) (MIT), to measure it against the benchmark in `bench/`. Only its measurements are meant to outlive it.

## What it does

- One Konva node per scene element in one layer; the camera is the layer's position and scale. Hit graphs, automatic redraws and Konva's "perfect drawing" buffers are turned off; the engine draws the layer itself once per changed frame.
- Culling: nodes outside the view, or smaller than half a device pixel on screen, are hidden each frame (a linear scan of 2,000 bounding boxes).
- Text: Konva wraps and draws the text with `fillText`, so glyphs are rasterized at the final screen scale. While the camera moves, text smaller than 4 device pixels is drawn as one bar per line (or one faint block when lines are under 1.5 device pixels apart). On the first frame with a still camera everything down to 1 device pixel is drawn with glyphs, and only then is the text reported sharp.
- Images (`src/image-lod.ts`): levels with the longest side at 128, 256, 512 ... pixels up to the natural size, decoded with `createImageBitmap` and its resize options. Level 0 of every image is decoded at load; the level that fits the image's size on screen is decoded on demand (three at a time), and the nearest decoded level is drawn until it arrives. Levels above 0 are closed, least recently used first, beyond 512 MB.
- Editing (`src/text-editor.ts`): a `<textarea>` laid over the text box, so the browser provides caret, selection, clipboard and IME. Two sizing modes: `screen` (font size and width multiplied by the zoom, the default) and `scaled` (world size, scaled with a CSS transform).
- Device pixel ratio: `Konva.pixelRatio` is set from the viewport.

## Running it

```sh
pnpm --filter @galatsa/proto-konva dev          # http://localhost:5173/ harness, /edit.html playground
pnpm --filter @galatsa/proto-konva exec playwright install chromium firefox
pnpm --filter @galatsa/proto-konva e2e          # all tests; writes to results/
pnpm --filter @galatsa/proto-konva e2e --project=chromium-gpu bench
```

The playground (`edit.html`): drag to pan, wheel to zoom, double-click a text box to edit, Escape or a click outside to finish. Query parameters are listed in `src/playground.ts`.

Playwright projects: `chromium` (headless, canvas rasterized in software), `chromium-gpu` (headless with flags that give a hardware-accelerated canvas; check `chrome://gpu` on another machine) and `firefox`. The bench test takes `BENCH_DPR=2` and `BENCH_QUERY=maxImage=256&movingGlyphMin=100000` (experiments; see `src/main.ts`).

## Results

In `results/`: `bench-<project>[-dpr2][-<experiment>].json` and `.txt` (harness output plus the engine's counters), `text-<browser>-dpr<n>-zoom-<z>.png` (the text the camera run zooms in on, at 0.1, 1, 8 and 40), `overlay-<mode>-zoom-<z>.png` (the edit overlay at the same cameras), `overlay-wrap-<browser>.json` (line breaks of the overlay against Konva's), `edit-*.png` (the editing test), `precision-<project>.json` and `precision-chromium-zoom-<z>.png` (text at zoom 100 to 10^9).
