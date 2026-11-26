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

## Interface, as a starting point

The detailed interface is written with the first renderer work. This is the shape it starts from:

```ts
interface Renderer {
  /** Attaches the renderer to an element it may fill with its own canvas and overlay. */
  mount(container: HTMLElement): void;
  /** Hands over the resolved document; later calls describe what changed. */
  setScene(scene: ResolvedScene): void;
  applyChanges(changes: SceneChange[]): void;
  /** Sets the camera for the next frame. The camera is anchored in a frame's space. */
  setCamera(camera: Camera): void;
  /** Draws one frame. Called by the host inside an animation frame. */
  render(): void;
  /** Topmost element at a screen position, for selection and hover. */
  hitTest(screenX: number, screenY: number): ElementId | null;
  /** Screen rectangle of an element, for handles, guides and the editing overlay. */
  screenBounds(id: ElementId): ScreenRect | null;
  /** Starts in-place editing of a text element with a browser element laid over it. */
  beginTextEdit(id: ElementId): TextEditSession;
  dispose(): void;
}
```

Element types from extensions draw themselves through a small drawing context that the renderer provides, not by reaching the canvas directly, so that culling, levels of detail and precision handling stay in one place.

## Risks and open points

- **WebKitGTK is slower than Chromium, and decoding originals is what breaks it.** See "Measurement in WebKitGTK" below. Storing reduced-size levels with the document, as required above, removes the need to decode originals. If speed in WebKitGTK still falls short with the real renderer, the Linux desktop app uses Electron instead of Tauri.
- **Rich text.** Mixed styles within a text box, right-to-left text and full Unicode line breaking are the expensive part of owning text layout. To be evaluated first: letting the browser lay the text out in a hidden element at the reference size, reading the line boxes from it, and drawing those lines on the canvas. That would give the browser's line breaking and bidirectional text without a layout library. Not verified.
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
- **Drawing is several times slower than in Chromium.** The canvas prototype spends 12 ms per moving frame in `render()` here, against about 2.5 ms in Chromium. The Konva prototype spends 3.8 ms on the same scene, so part of this is something our prototype does that WebKitGTK handles badly, not a limit of Canvas 2D. Finding it is the first job of the real renderer.

No prototype meets the targets in WebKitGTK as it stands. The two causes found (decoding originals, and an expensive drawing path) are both addressed by the requirements above. Whether that is enough for 60 frames per second in WebKitGTK is open and is measured again with the real renderer.

## Rejected alternatives

- **Konva**, for the reasons above.
- **DOM as the main renderer**, for the reasons above. It remains the fallback for editing and may be used for single elements where the browser does something we cannot, such as embedded video.
- **WebGL or WebGPU.** Faster in principle, but text rendering becomes an even larger job, and WebGL in the Linux system web engine has known problems (see [0002](0002-kontroll-av-forutsetninger.md)). The interface leaves room for it.
- **Measuring all three prototypes on Linux, macOS and Windows before choosing.** The prototypes agreed, so this would have delayed the work without changing the choice.
