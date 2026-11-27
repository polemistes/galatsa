# 0004 Rendering engine

- **Status:** Accepted
- **Date:** 2026-11-27

## Decision

Galatsa draws the canvas with its **own Canvas 2D renderer**, and uses **the browser's own elements for text editing**: while a text box is being edited, an editable element sits exactly over it, and the canvas draws everything else.

- Konva is not used.
- A renderer built entirely from DOM elements is not used.
- WebGL is not used for now.
- The renderer lives in `packages/renderer` behind an interface, so the choice can be revisited without touching the rest of the program.

## How the choice was made

Three throwaway prototypes drew the same benchmark scene (2,000 elements: 1,200 shapes, 600 text boxes, 200 images of 2 to 12 megapixels) through the same camera run, and each had to support in-place text editing:

- **A:** Konva.
- **B:** custom Canvas 2D drawing.
- **C:** DOM elements positioned with CSS transforms.

The prototypes are not in `main`. They are kept on the branch `bench-shell/engine-measurement`, together with a small desktop shell that can run them.

All numbers below are from one laptop (Ryzen 7 PRO 7840U, Radeon 780M), headless browsers, 1280×720, device pixel ratio 1. They were taken with the first version of the meter, and the machine was running other work at the same time, so read them as a ranking, not as exact values.

|                                                          | A: Konva                                                                   | B: Canvas 2D                                                            | C: DOM                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| Chromium with GPU: frames over 33 ms, of 2,775           | 57                                                                         | 11–17                                                                   | 191–205                                  |
| Chromium with GPU: frames over 100 ms                    | 0                                                                          | 0                                                                       | 0                                        |
| Firefox: frames over 100 ms                              | 7–23                                                                       | 0                                                                       | 179–208                                  |
| Firefox: `render()` time, 95th percentile                | 15.9 ms                                                                    | 14.9 ms                                                                 | 9.6 ms (most cost is outside `render()`) |
| Text sharp after the camera stops (Chromium, worst case) | 11–27 ms                                                                   | 3 ms                                                                    | 45–81 ms                                 |
| Browser process memory, Chromium with GPU, peak          | not measured                                                               | 1.5 GB                                                                  | 2.0 GB                                   |
| One-pixel camera moves stay exact up to zoom             | 10⁴                                                                        | not measured; float32 limits expected from about 10³ without extra work | 10⁷                                      |
| Text editing                                             | overlay textarea; line breaks differ from the drawn text in 9 of 600 boxes | hidden textarea plus own caret and selection drawing; all tests pass    | native `contenteditable`; all tests pass |

What decided it:

- **A (Konva)** adds little. Culling, image levels of detail and zoom-aware text all had to be built around it, and its node model works against camera-relative drawing, which deep zoom needs. Making it production-ready would mean writing our own renderer on top of Konva.
- **C (DOM)** gets text and editing from the browser, but the browser re-rasterises scaled text on every frame. That cost is outside our control, it is far too high in Firefox, and memory use is the highest of the three.
- **B (Canvas 2D)** was the smoothest in every browser tested and the only one with no frame over 100 ms anywhere. Its cost is that text layout and editing are ours to build. Using a browser element for the editing itself removes the hardest part of that cost.

The three prototypes agree well enough that measuring them on more machines would tune the result, not change it. Cross-platform verification therefore happens with the real renderer during the first development phase, using the same benchmark scene, which stays in `bench/` as a regression tool.

## What the renderer must do

These follow from what the prototypes showed. They are requirements for the first version of `packages/renderer`.

- **Camera-relative drawing.** Transforms are computed in float64 relative to the camera, so the canvas only receives numbers the size of the screen. Geometry that is far larger than the screen is clipped in our code before it reaches the canvas, because the browser's rasteriser uses 32-bit floats. This is what makes the zoom range in [0001](0001-document-model-and-file-format.md) reachable.
- **Culling** with a spatial index, and skipping elements smaller than half a device pixel.
- **Text at real size.** Text is drawn with `fillText` at its final size in device pixels on every frame, so it is never blurred and needs no "sharpen after stopping" step. Text smaller than about 4 device pixels is drawn as bars.
- **One text layout for drawing and editing.** Line breaks are computed once per text box at a reference size and scaled, so they do not change with zoom, and the editing element uses the same breaks. Text must not jump when editing starts.
- **Bundled fonts.** Generic font names resolve to different fonts in different browsers (the same box wrapped to 8 lines in one and 10 in another). The program ships its fonts and waits for them before laying out text.
- **Image levels of detail.** Reduced-size versions of each image are made when the image is added to a document and stored with it. The renderer picks the level that matches the size on screen and never decodes the original unless that image fills the view. Where the browser has `ImageDecoder`, it is used to decode at reduced size; decoding at full size and scaling down was several times slower and used far more memory.
- **Device pixel ratio** is respected and may change while the program runs.
- **Drawing happens on the main thread** for now. Moving it to a worker is possible later behind the same interface.

## Interface

`packages/renderer` (`@galatsa/renderer`) implements the requirements above. The interface started from a sketch (`mount`, `setScene`, `applyChanges`, `setCamera`, `render`, `hitTest`, `screenBounds`, `beginTextEdit`, `dispose`) and kept its shape; this is what it became.

### What the renderer reads

The renderer never sees Yjs. It reads the resolved document through `SceneSource`, the read interface the `Resolver` of `@galatsa/core` already has, plus the element record that is drawn:

```ts
interface SceneSource {
  children(parent: ElementId | null): readonly ElementId[]; // drawing order, gone ones included
  parentOf(id: ElementId): ElementId | null; // effective parent
  isGone(id: ElementId): boolean;
  isContainer(id: ElementId | null): boolean;
  localPosition(id: ElementId): Point; // in the effective parent's space
  offset(from: ElementId | null, to: ElementId | null): Point; // lowest-common-ancestor arithmetic
  element(id: ElementId): SceneElement | undefined; // type, typeVersion, data, size, rot
}
```

`sceneFromResolver(resolver, element)` builds one over any resolver; `sceneFromSnapshot(snapshot)` builds one over a new `Resolver` for a whole snapshot. `applyChanges(ids, source?)` reads the given ids again, from the same live source or from a new one. The ids must be every element whose **resolution** changed in a transaction: added, changed and removed records, and every element whose effective parent, position, order or gone state changed because of them, descendants included. That is what a live resolver reports (the union of its added, changed and removed sets); the ids the transaction wrote are not enough, because one delete can hide a whole subtree and one removed container moves its children to another parent. Until the document keeps a live resolver, the caller makes a new source from a snapshot and reports every id. As a safety net the renderer also reads again the surviving children of a container whose record was removed. Tested by comparing the incrementally updated tree with one built from scratch after random edits (300 seeds), with every id and with the ids whose resolution changed.

### The renderer

```ts
class CanvasRenderer {
  constructor(options: {
    host: ViewHost; // element types; drawn with host.drawElement
    images?: ImageSource; // stored versions of each image, smallest first
    imageOptions?: {
      decoder?: "imagedecoder" | "worker" | "main";
      budgetBytes?: number;
      maxInFlight?: number;
    };
    assets?: SceneAssets; // natural pixel sizes from the document's asset descriptions
    t?: (label: Label, values?: MessageValues) => string; // text elements draw themselves
    background?: string | null;
    families?: FontFamilies; // generic family names to CSS families
    measurer?: TextMeasurer;
    onInvalidate?: () => void; // something changed outside render(): draw again
  });
  mount(container: HTMLElement): void; // own canvas, follows size and devicePixelRatio
  attach(ctx: Canvas2D, viewport: Viewport): void; // or draw into a context of one's own
  setViewport(viewport: Viewport): void; // CSS size and devicePixelRatio; may change any time
  setScene(source: SceneSource): void;
  applyChanges(ids: Iterable<ElementId>, source?: SceneSource): void;
  imagesChanged(assets: Iterable<string>): void; // bytes arrived, changed or went away: ask again
  setCamera(camera: CameraView): void; // centre and zoom in a container's space
  setOverlay(draw: ((ctx: DrawContext) => void) | null): void; // drawn above the document, in CSS pixels of the screen
  render(): void; // one frame, in the host's animation frame
  hitTest(
    x: number,
    y: number,
    options?: { tolerance?: number; accept?: (id: ElementId) => boolean },
  ): ElementId | null;
  screenBounds(id: ElementId): ScreenRect | null; // axis-aligned box, rotation, the four corners
  elementsInRect(
    rect: Rect,
    options?: { space?: ElementId | null; inside?: boolean },
  ): ElementId[];
  renderRegion(
    region: { space: ElementId | null; rect: Rect },
    image: { width: number; height: number; mediaType: string },
  ): Promise<Uint8Array>;
  beginTextEdit(id: ElementId, options: TextEditOptions): TextEditSession; // in-place editing, 0011
  readonly images: ImageCache | null; // preload(), settle(), stats
  readonly stats: RenderStats; // counters of the last frame
  dispose(): void;
}
```

Screen positions (`hitTest`, `screenBounds`, `elementsInRect`) are CSS pixels of the drawing area. `hitTest` returns an extension element or a frame (where nothing inside the frame is hit), never a group (what a click inside a group selects is the editor's decision), never a gone element, and never an element too small to be drawn (under half a device pixel). `elementsInRect` returns what the user sees at the top level of a space: the members of a gone container (a dissolved group) in its place, never the container. `renderRegion` refuses a region or image of no size and keeps its counters apart from the frames on screen. `renderRegion` is the `RegionRenderer` of [0005](0005-extension-interface.md): it fits the region into the image, draws it on its own canvas and waits for the image versions it needs before encoding.

### How it works

- **Scene tree.** One node per element, grouped by container, with the bounds of what each draws in its container's local space (an extension element: its type's `bounds()`, rotated; a frame: its rectangle, plus its children unless it clips; a group or a gone container: its children). Each container with more than 24 children has a spatial index: a hierarchy of uniform grids, four times larger per level, where an entry sits in the level whose cells are at least its size. A query skips every level whose largest entry is under half a device pixel, and scans a level's entries instead of its cells when that is cheaper (zoomed far out). Updates are incremental: a moved element changes its own entry and the bounds of the containers above it; a moved frame changes only its own entry, because its children are stored relative to it.
- **Precision.** Every container's map to device pixels is computed from `offset(container, camera.space)`, never accumulated down the tree, so each frame starts a fresh precision budget. An element's matrix (rotation about its centre, uniform scale, translation) is computed in float64. Paths are recorded in the element's local box and mapped point by point; the canvas stays at the identity transform for paths and gets only device coordinates. A path whose device bounds stay within ±2^15 pixels goes to the canvas as it is (arcs as arcs). Larger geometry is flattened in float64, finely only near the view (subdivision stops where a piece cannot reach the view), and clipped to the view plus a margin: fills polygon by polygon (Sutherland–Hodgman), strokes segment by segment (Liang–Barsky). A closed outline that is cut is walked from a vertex outside the view, so every corner in view keeps its join; a dashed one restarts each visible run with its dash phase reduced to one pattern length. A stroke wider than 2,048 device pixels is not given to the canvas as a stroke at all: it becomes filled polygons (a rectangle per segment, a polygon per miter, bevel or round join and per cap, dashes cut out first, all wound the same way and filled with the non-zero rule), each clipped to the view, so neither a huge line width nor the margin it would need ever reaches the canvas. The slow path follows Canvas 2D after `closePath` and `rect` (the next segment starts at the subpath's start). Images are drawn only for the visible part of their rectangle, with the matching part of the source; text lines outside the view are skipped and each drawn line gets its own matrix. Tested: one-pixel camera moves move the drawing by one device pixel at zoom 2^30 inside a frame at 2^52, and the canvas never receives a coordinate beyond a few thousand pixels. In Chromium and Firefox (`tests/e2e/bench-canvas.spec.ts`, by pixels on a real canvas): the corner of a clipped closed outline is filled, and the edge of a stroke two units wide moves exactly one pixel per pixel of camera movement at zoom 2^14, 2^20 and 2^24 (before the fix, at 2^24 it moved 0, 2, 4, 4, 4 pixels).
- **Element types** draw through `DrawContext` ([0005](0005-extension-interface.md) section 3.3): `host.drawElement` per visible extension element, with `ctx.scale` (device pixels per local unit) and `ctx.detail` (`"box"` under 4 device pixels, `"reduced"` under 16). Frames (fill, clip, one-pixel stroke from their `data`) and groups are drawn by the renderer itself. A type that throws is drawn as a placeholder by the host.
- **Canvas state** that changes often (fill and stroke colour, alpha, font, line width, transform) is cached and assigned only when it changes.
- **Images.** An `ImageSource` gives each image's stored versions, smallest first, with the original last. The renderer decodes the smallest version at least as wide as the image is on screen (device pixels) and draws the nearest decoded version until it arrives. With WebCodecs `ImageDecoder` (Chromium, Firefox) an original can also be decoded at half, quarter and so on, so it is decoded in full only when it is that large on screen. Without it (WebKit), `createImageBitmap` runs in a dedicated worker made from a string, so decoding never blocks the main thread. If that worker cannot be made, reports an error or does not answer within 5 seconds (a content security policy that forbids `blob:` workers, say), its decodes and all later ones go to `createImageBitmap` on the main thread; one decode that takes over a minute is redone there too. The version is chosen by the larger of the width and height scales, so an image squeezed out of its proportions gets the version its taller side needs. An image the source does not have, or whose decode failed, is asked for again after a wait that doubles from one second to a minute; `imagesChanged(assets)` (the cache's `forget`) asks again at once, for when bytes arrive, change or go away. A decode still running when its asset is forgotten is closed and not counted. Decoded versions beyond a byte budget (384 MB by default; the smallest version of each image is not counted) are closed, least recently drawn first. `images.preload()` decodes the smallest version of each image, as a viewer does when it opens a document.
- **Text** (simple, for now). `layoutText` breaks plain text (rich text runs joined) into lines once, at a reference size of 100 pixels, so the breaks do not change with zoom, and caches the layout by content, style and width (20,000 layouts; when full, the quarter used longest ago is dropped, so a document with more text boxes than that does not lay everything out again every frame). `drawText` draws each visible line with `fillText`; the font size given to the canvas comes from a ladder of four steps per doubling, and the rest of the scale goes into the line's matrix, so glyphs are rasterised at their final size while the canvas sees only a few font strings (see the next section). Text under 4 device pixels is drawn as bars, or as one faint block when lines are closer than 2 device pixels. Full layout (the browser's line breaking, rich text, bundled fonts), one layout for drawing and editing, and in-place editing came later behind the same calls: [0011](0011-text.md), which also moved the reference size to 1,000 pixels; the simple layout described here remains for environments without a document.
- **Device pixel ratio.** `setViewport` takes the ratio with the size; `mount` watches the container's size (`ResizeObserver`) and the ratio (a `resolution` media query) and calls `onInvalidate` after a change.

## The slow drawing path in WebKitGTK

The canvas prototype spent 12 ms per moving frame in `render()` in WebKitGTK, the Konva prototype 3.8 ms on the same scene. The cause is **a new font size for every text, on every frame of a zoom**: the canvas prototype drew text at its exact size in device pixels, so during a zoom it assigned `ctx.font` a new fractional size (`"400 13.271px serif"`) for each text box in each frame. Konva sets each text's font at its fixed size in world units and scales with the canvas matrix, so its set of font strings never changes.

What was measured: the two prototypes and variants of the canvas prototype, each changing one thing, in the system's WebKitGTK 2.54.3 (`webkit2gtk-4.1`, the library Tauri uses on Linux, run through its GObject bindings) on the development machine, under Xvfb, with the bench's camera run. Xvfb has no graphics card, so the absolute numbers do not stand for a desktop; the comparison between variants does. Mean `render()` time and mean main-thread work per moving frame:

| Variant                                                 | `render()` | Work    |
| ------------------------------------------------------- | ---------- | ------- |
| Konva prototype                                         | 4.6 ms     | 18.0 ms |
| Canvas prototype, as measured on the desktop            | 15.0 ms    | 24.3 ms |
| … with the font at its world size, scaled by the matrix | 2.2 ms     | 12.0 ms |
| … with the font size from a ladder (2 steps per octave) | 2.2 ms     | 12.6 ms |
| … without `textRendering = "geometricPrecision"`        | 15.8 ms    | 25.3 ms |
| … with an alpha channel (`alpha: true`)                 | 14.9 ms    | 24.2 ms |
| … without images                                        | 17.5 ms    | 23.6 ms |
| … without shapes                                        | 15.8 ms    | 25.4 ms |
| … without any `fillText`                                | 1.7 ms     | 4.3 ms  |

The ratio between the two prototypes (4.6 against 15.0 ms) matches the desktop measurement (3.8 against 12.1 ms). Fixing the set of font sizes alone brings the canvas prototype below Konva; the other suspects (text rendering mode, alpha channel, shapes, images, `setTransform` per element, `save`/`restore`) change nothing. Without images the frames over 100 ms disappear (1 against 62), which confirms that those come from decoding.

What is assumed, not measured: that WebKitGTK builds a new platform font (font matching and a new scaled face) for each new size, and that this is the cost; and that the same holds with a graphics card. The renderer avoids the pattern either way: it gives the canvas sizes from a ladder of four steps per octave (between 4 and 64 pixels that is at most 17 distinct sizes), assigns the font only when it changes, and puts the remaining scale (at most 9 %) into the matrix.

The work outside `render()` (main-thread work minus `render()`) is the browser painting the canvas, which under Xvfb is done in software. Most of it is text: glyphs are rasterised again whenever their size on screen changes, which during a zoom is every frame (see "Risks and open points").

### The renderer in the benchmark

The bench has the renderer as the engine `renderer`. Its images come from reduced versions the bench makes with each original (halves down to a long side of 256 pixels), standing in for the versions a document will store; loading decodes only the smallest version of each image.

Chromium 158 and Firefox 159, headless, through `tests/e2e/bench-renderer.spec.ts` (`pnpm --filter @galatsa/e2e exec playwright test bench-renderer`), on the development laptop (Ryzen 7 PRO 7840U, Radeon 780M), 960×540, device pixel ratio 1, two timing runs each, the bench's dev server, other work running on the machine at the same time:

|                                             | Chromium 158          | Firefox 159              |
| ------------------------------------------- | --------------------- | ------------------------ |
| Frames over 16.7 ms, of 2,775               | 29 and 1 (1.0 %, 0 %) | 52 and 29 (1.9 %, 1.0 %) |
| Frames over 33 ms                           | 0 and 0               | 0 and 0                  |
| Frames over 100 ms                          | 0 and 0               | 0 and 0                  |
| `render()`, median / 95th percentile        | 1.0 / 8.3–9.9 ms      | 5.2–5.5 / 10.8–13.6 ms   |
| Text sharp after the camera stops, worst    | 17 ms                 | 17–21 ms                 |
| Image decoder                               | `ImageDecoder`        | `ImageDecoder`           |
| Memory peak, PSS of the browser's processes | 1.21–1.24 GB          | 1.41–1.44 GB             |

Every target holds in both browsers, the 16.7 ms target included. The memory figures are informational: the empty engine's run in the same page peaked at 1.32 GB (Chromium) and 1.80 GB (Firefox), so they are dominated by the headless browser and the 395 MB of encoded image files the page keeps, and they say little about the desktop app. Across the run the renderer decoded 240 versions (254 MB of pixels at the peak, within the 384 MB budget) and two originals in full, when the camera stopped on an image that fills the view.

WebKitGTK 2.54.3 under Xvfb (no graphics card, so not representative in absolute terms; the same conditions as the prototype variants above), two runs with the worker decoder and one with `createImageBitmap` on the main thread: mean `render()` 2.6–2.9 ms, mean main-thread work 10 ms per moving frame; frames over 33 ms 27–29 (1.0 %), over 100 ms 0 with the worker decoder and 1 with `createImageBitmap` on the main thread; frames over 16.7 ms 270–290 (10 %); text sharp within 18 ms. In the same conditions the canvas prototype had 635 frames over 33 ms and 62 over 100 ms, the Konva prototype 230 and 95. The measurement that decides for Linux is the user's, with the desktop measurement app on real hardware.

## Risks and open points

- **WebKitGTK is slower than Chromium.** See "Measurement in WebKitGTK" and "The slow drawing path in WebKitGTK" below. Storing reduced-size levels with the document removes the need to decode originals, and a stable set of font sizes removes the expensive drawing path. With both, the renderer meets every target in WebKitGTK on the development laptop; it has not been measured on other Linux machines yet.
- **Known limitations, left to later work:**
  - Text at deep zoom on long lines: each line is drawn from its start, so far into a long line the canvas gets a large translation, and above a font size of 1,024 device pixels the rest of the scale goes into the matrix; horizontal clipping of lines is part of the full text layout. So are text that reaches outside its box and the bounds that follow from it.
  - The smallest version of each image is never freed, and an image with only one stored version (the original) is decoded in full; both belong with storing the versions with the document.
  - Previews of gestures: settled with the editor ([0007](0007-editor-foundation.md)). The editor lays a gesture's preview over the document in the scene source it hands the renderer, and tells the renderer which ids to read again, so the renderer needed nothing for it. Tool overlays (a rubber band, the outline of a shape being drawn) and the selection outline needed a place to draw: `setOverlay(draw)`, added then, is called after the document in every frame on screen, with the renderer's drawing context in screen space (CSS pixels of the drawing area; `ctx.scale` is device pixels per CSS pixel); `renderRegion` never draws it, and a function that throws is left out of that frame (`overlay.test.ts`). Screen space keeps the overlay independent of the space the camera is anchored in: the editor projects what it draws from the document through the camera itself, with the same offsets between spaces as the renderer.
  - The font ladder makes a line's width change by up to 0.5 % at a ladder step (measured: Chromium 0.17 %, Firefox 0.5 %). Accepted.
- **Text cost outside `render()` in WebKitGTK.** With the font ladder, WebKitGTK still rasterises glyphs anew for each frame of a zoom, because the size on screen changes; under Xvfb (no GPU) that cost appears after `render()`, in the browser's painting. Drawing glyphs at the ladder size while the camera moves (and at the exact size when it stops) would let it reuse them, at the price of text that is up to 9 % off its size during motion. Not tried; decide after the measurement with a graphics card.
- **Rich text.** Mixed styles within a text box, right-to-left text and full Unicode line breaking are the expensive part of owning text layout. To be evaluated first: letting the browser lay the text out in a hidden element at the reference size, reading the line boxes from it, and drawing those lines on the canvas. That would give the browser's line breaking and bidirectional text without a layout library. Done in [0011](0011-text.md) for line breaking and rich text; right-to-left runs are laid out by the browser but not yet drawn right.
- **Accessibility.** A canvas is invisible to screen readers. The plan is a hidden DOM mirror of the visible text, kept in sync with the canvas. Not built in the first version.
- **Input methods.** Composition was tested in Chromium through the DevTools protocol only, not with a real input-method window and not in WebKit.

## Measurement in WebKitGTK

After the decision, the three prototypes were run in the desktop shell on a real display (Arch Linux, WebKitGTK 2.54.3, Radeon 780M, 60 Hz, 960×540 stage, second version of the meter, two timing runs per engine). WebKitGTK is the web engine the Linux desktop app uses.

|                                              | A: Konva        | B: Canvas 2D       | C: DOM                                   |
| -------------------------------------------- | --------------- | ------------------ | ---------------------------------------- |
| Frames over 16.7 ms, of 2,775                | 260–267 (9.5 %) | 1,031–1,072 (38 %) | 621–654 (23 %)                           |
| Frames over 33 ms                            | 202 (7.3 %)     | 275–279 (10 %)     | 502–539 (19 %)                           |
| Frames over 100 ms                           | 78–79           | 50–51              | 341–387                                  |
| `render()` time while the camera moves, mean | 3.8 ms          | 12.1 ms            | 1.3 ms (most cost is outside `render()`) |
| Whole run, ideal 46 s                        | 61 s            | 66 s               | 107–117 s                                |
| Process memory, peak while loading           | 5.9 GB          | 6.4 GB             | 1.2 GB                                   |
| Process memory during the run, last third    | 0.9 GB          | 1.3 GB             | 1.3 GB                                   |

What this shows:

- **The choice holds.** The DOM prototype is far behind in this engine too, with seven times as many frames over 100 ms as the canvas prototype.
- **The 6 GB is a peak while loading, not steady use.** Both canvas prototypes decode all 200 originals when they load, to make thumbnails. Memory climbs to about the size of the fully decoded scene (5.6 GB) and falls back when loading ends. During the run they use 1–2.5 GB. The DOM prototype re-encodes small versions and lets the originals go, and never shows the peak.
- **The frames over 100 ms come from decoding, not drawing.** In every one of them `render()` took under 50 ms. They cluster where new images come into view, in both canvas prototypes.
- **Drawing is several times slower than in Chromium.** The canvas prototype spends 12 ms per moving frame in `render()` here, against about 2.5 ms in Chromium. The Konva prototype spends 3.8 ms on the same scene, so part of this is something our prototype does that WebKitGTK handles badly, not a limit of Canvas 2D. It was found with the real renderer: a new font size for every text on every frame (see "The slow drawing path in WebKitGTK" above).

No prototype meets the targets in WebKitGTK as it stands. The two causes found (decoding originals, and an expensive drawing path) are both addressed by the requirements above.

**The real renderer on real hardware.** The user ran the desktop measurement app with the renderer on 2026-11-27, on the same machine (Arch Linux, WebKitGTK 2.54.3, Ryzen 7 PRO 7840U, Radeon 780M with the amdgpu driver, mains power, 60 Hz, device pixel ratio 1, 960×540 stage), one capture run and two timing runs. Other processes were running on the machine at the same time, so the numbers may be a little worse than on an idle machine.

|                                                             | Timing run 1 | Timing run 2 |
| ----------------------------------------------------------- | ------------ | ------------ |
| Frames over 16.7 ms, of 2,775                               | 95 (3.4 %)   | 4 (0.1 %)    |
| Frames over 33 ms                                           | 17 (0.6 %)   | 0            |
| Frames over 100 ms                                          | 0            | 0            |
| `render()` while the camera moves, mean                     | 2.0 ms       | 1.6 ms       |
| `render()`, median / 95th percentile                        | 1 / 6 ms     | 1 / 5 ms     |
| Main-thread work while the camera moves, mean               | 5.5 ms       | 4.7 ms       |
| Text sharp after the camera stops, worst                    | 17 ms        | 17 ms        |
| Process memory, peak (PSS of the app and its web processes) | 0.90 GB      | 0.95 GB      |

Every target holds in both timing runs, the 16.7 ms target included, and the two runs agree on every verdict. Against the canvas prototype on the same machine (12.1 ms in `render()`, 275–279 frames over 33 ms, 50–51 over 100 ms, 6.4 GB while loading) the drawing path is six to seven times cheaper and the stalls and the loading peak are gone. **The Linux desktop app keeps Tauri** (WebKitGTK); Electron is not needed.

## Rejected alternatives

- **Konva**, for the reasons above.
- **DOM as the main renderer**, for the reasons above. It remains the fallback for editing and may be used for single elements where the browser does something we cannot, such as embedded video.
- **WebGL or WebGPU.** Faster in principle, but text rendering becomes an even larger job, and WebGL in the Linux system web engine has known problems (see [0002](0002-kontroll-av-forutsetninger.md)). The interface leaves room for it.
- **Measuring all three prototypes on Linux, macOS and Windows before choosing.** The prototypes agreed, so this would have delayed the work without changing the choice.
