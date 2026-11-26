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

- **Memory in WebKitGTK.** In a trial run of the desktop shell under a virtual display, both canvas prototypes used about 6 GB in the Linux system web engine, against 1.2–1.5 GB in Chromium. The scene's images need 5.6 GB when decoded at full size, so the likely cause is that this engine decodes and keeps full-size images where Chromium decodes at reduced size. This is a hypothesis, not yet verified. Storing reduced-size levels with the document, as required above, removes the need to decode originals at all. If memory or speed in WebKitGTK still falls short with the real renderer, the Linux desktop app uses Electron instead of Tauri.
- **Rich text.** Mixed styles within a text box, right-to-left text and full Unicode line breaking are the expensive part of owning text layout. To be evaluated first: letting the browser lay the text out in a hidden element at the reference size, reading the line boxes from it, and drawing those lines on the canvas. That would give the browser's line breaking and bidirectional text without a layout library. Not verified.
- **Accessibility.** A canvas is invisible to screen readers. The plan is a hidden DOM mirror of the visible text, kept in sync with the canvas. Not built in the first version.
- **Input methods.** Composition was tested in Chromium through the DevTools protocol only, not with a real input-method window and not in WebKit.

## Rejected alternatives

- **Konva**, for the reasons above.
- **DOM as the main renderer**, for the reasons above. It remains the fallback for editing and may be used for single elements where the browser does something we cannot, such as embedded video.
- **WebGL or WebGPU.** Faster in principle, but text rendering becomes an even larger job, and WebGL in the Linux system web engine has known problems (see [0002](0002-kontroll-av-forutsetninger.md)). The interface leaves room for it.
- **Measuring all three prototypes on Linux, macOS and Windows before choosing.** The prototypes agreed, so this would have delayed the work without changing the choice.
