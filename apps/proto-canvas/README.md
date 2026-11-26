# @galatsa/proto-canvas

A throwaway prototype of a rendering engine that draws the whole canvas with its own code on one Canvas 2D element: its own scene traversal, culling, text layout and drawing, and in-place text editing. It implements the bench engine interface (`BenchEngine` in `bench/src/engine.ts`) so it can be measured with the bench scene and camera run. It is not production code.

## Running it

```sh
pnpm --filter @galatsa/proto-canvas dev      # http://localhost:5173/ (bench harness), /demo.html (interactive)
pnpm --filter @galatsa/proto-canvas build    # pages to build/
pnpm --filter @galatsa/proto-canvas preview  # serve the built pages
```

On `demo.html`: wheel to zoom, drag to pan, double-click a text to edit it, Escape or a click outside to stop. Add `?images=1` to generate the bench images (slow); without it images are grey boxes.

The Playwright tests build the pages and serve them with `vite preview`. They need the browsers once: `pnpm --filter @galatsa/proto-canvas exec playwright install chromium firefox`.

```sh
pnpm --filter @galatsa/proto-canvas e2e --project=chromium edit         # editing test
pnpm --filter @galatsa/proto-canvas e2e --project=chromium screenshots  # results/text-*.png
pnpm --filter @galatsa/proto-canvas e2e --project=chromium bench        # results/bench-chromium.json
```

`bench.spec.ts` and `screenshots.spec.ts` overwrite the files in `results/`.

## How it works

- `src/engine.ts`: the engine. One canvas of the viewport size times `devicePixelRatio`. Per element one transform, computed in double precision relative to the camera so that the numbers given to the canvas stay small.
- `src/spatial.ts`: a uniform grid over the rotated bounding boxes, for culling.
- `src/text-layout.ts`: line breaking in world units, measured once at a reference size, so lines break the same way at every zoom level. Text is drawn line by line with `fillText` at its size in device pixels; text below 4 device pixels is drawn as bars.
- `src/image-cache.ts`: images decoded at reduced size, off the main thread, with WebCodecs `ImageDecoder` (`desiredWidth`, so JPEG is decoded at reduced size) or, where that is missing, `createImageBitmap` resize options: a thumbnail of each at load, finer levels on demand, least recently used levels freed beyond a budget.
- `src/editor.ts`: editing through a hidden textarea that holds the text and selection; the canvas draws text, selection, composition underline and caret.

## Results

In `results/`, from headless browsers on one Linux laptop (AMD Ryzen 7 PRO 7840U with Radeon 780M), viewport 1280 x 720 at device pixel ratio 1:

- `bench-<project>-<decoder>.json`: the harness output, plus `engineStats` (the engine's own counters, including decoded image bytes), `renderer` (the WebGL renderer string) and `processMemory` (PSS of all browser processes from `/proc`, sampled every 500 ms; the baseline is a no-op engine run on the same page with the images generated). Projects: `chromium` (headless Chromium rasterises canvas in software), `chromium-gpu` (with `--enable-gpu --ignore-gpu-blocklist`) and `firefox`. Decoders: `imagedecoder` (the default) and `createimagebitmap` (the first version).
- `decode-<project>.json`: thumbnail decoding with `createImageBitmap` resize options against `ImageDecoder` with `desiredWidth` (`tests/decode.spec.ts`).
- `text-<name>-<id>-zoom<z>-dpr<d>-<project>.png`: the same texts at zoom 0.1, 1, 8 and 40.
- `edit-*-<project>.png`: the steps of the editing test.
