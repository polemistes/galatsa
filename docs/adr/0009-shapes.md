# 0009 Shapes

- Status: proposed
- Date: 2026-11-27
- Code: `packages/extensions/shape` (`@galatsa/extension-shape`, and `@galatsa/extension-shape/view` for the viewing part), `apps/web/shapes.html` (the shape gallery), `tests/e2e/shapes-visual.spec.ts`, `scripts/lib/shape-pictures.test.ts`, `tests/e2e/shape-tool.spec.ts`, `tests/e2e/webkitgtk/shape_check.py`; `FieldDefinition.applies` in `packages/extension-api`; `setData` and `setExt` in `packages/core/src/ydoc/ops.ts`; `canTarget`, `canTargetAll` and `isOpenContainer` exported by `packages/extensions/basics`

## Context

Galatsa needs shapes: rectangle, ellipse, triangle, line, arrow, brackets and speech bubble, with fill, outline, outline width, rounded corners and opacity, and a drawing tool with a preview. The extension interface ([0005](0005-extension-interface.md)) was checked with a sketch of a shape extension (`examples.shape`) in which a shape is described as data: a template draws the outline and decides hits. This is the real extension built from that sketch, with the framework and the first three kinds. The remaining kinds are to be added one file each, by following the recipe in `packages/extensions/shape/README.md`, without changing the framework or its tests.

## Decision

| Topic           | Decision                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Element type    | One type, `galatsa.shape/shape`, layout version 1; the data's `kind` says which shape.                                                      |
| A kind          | A plain object that draws its outline in the element's box. Hit testing, bounds, drawing, the tool, fields and commands come from that.     |
| Third kind      | The line, not the arrow: the first open outline. The arrow is a line with heads, which the framework already supports (marks, parameters).  |
| Line geometry   | A box as long as the line and 0 high; the line runs along its middle; the element's rotation is its direction.                              |
| Colours         | `"#rrggbb"` or `"#rrggbbaa"`, or `null` for none; written in lower case.                                                                    |
| Kind properties | Parameters declared by the kinds, stored as keys of their own next to the common ones, offered as fields only for the kinds that list them. |
| Growth          | Values a later version may write (a new option, a wider range) are kept and read without a report; new kinds of paint go in new keys.       |
| Unknown kinds   | A kind from a newer version is kept and drawn as a placeholder; its style can still be changed and its keys survive.                        |
| Tool            | One per kind; a drag shows the shape in its real style in the overlay and ends in one insert command, one undo step.                        |
| Fields          | New optional `applies(model)` on fields (interface 1.3), so one type can offer corner rounding only to kinds with corners.                  |
| Screenshots     | A gallery page draws every kind in the same generated cases; a Playwright test compares each kind's canvas pixels with a stored picture.    |

### One element type with a kind

All shapes are one element type. Its data names the kind:

- **Changing the kind keeps the element.** The type of an element cannot change, so with one type per kind, turning a rectangle into an ellipse (the advanced "Shape" field) would have to delete it and make a new one, with a new id, breaking stops and references that point to it.
- **One style, one set of commands.** Fill, outline and opacity mean the same for every kind; one reader, one change command and one set of fields cover them.
- **Kinds from newer versions.** A document made with a later version may contain a kind this version does not know. The reader keeps any well-formed kind name, without a report (so editing still works, 0005 section 3.2). The shape is drawn as a placeholder ("newer", naming the kind) and hit by its box; in a box that is (nearly) 0 high, such as a later version's arrow, the placeholder is a solid line along the box, at least 2 device pixels wide or as wide as the shape's outline, with the label above it, since a dashed box would be a hairline. Its style can be changed; `updateElementData` writes only the changed key, so the kind and its own keys survive. Resizing is harmless because every kind is drawn from its box and parameters that are fractions of the box (below). Its kind cannot be changed: this version cannot tell what parameters it has.
- **The layout version stays 1** when a kind is added, since older readers handle new kinds as above. It rises only if the meaning of an existing key changes (0005 section 3.8).

The other way, one element type per kind, gets the placeholder for unknown kinds from the host for free and lets each kind have its own fields and capabilities. Losing the change of kind, and repeating the style in every type, weighed more.

### Data

This is part of the file format. Every key is optional when read, and a missing key means the default below, forever; new shapes are written with every key, so they do not depend on the defaults.

| Key            | Value                                                                                                                                                             | Default     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `kind`         | A kind name: `^[a-z][a-z0-9-]{0,31}$`. `rect`, `ellipse` and `line` so far.                                                                                       | `"rect"`    |
| `fill`         | `"#rrggbb"`, `"#rrggbbaa"` (hexadecimal; read in either case, written in lower case), or `null` for none.                                                         | `"#93c5fd"` |
| `stroke`       | The outline colour, the same form.                                                                                                                                | `"#1e3a8a"` |
| `strokeWidth`  | Outline width in world units, 0 to `MAX_LENGTH` = 2⁴⁶ (the precision budget of [0001](0001-document-model-and-file-format.md) section 7), centred on the outline. | `2`         |
| `cornerRadius` | Corner radius in world units, 0 to `MAX_LENGTH`; drawn at most half the shorter side.                                                                             | `0`         |
| `opacity`      | 0 (invisible) to 1 (opaque), for fill and outline together.                                                                                                       | `1`         |
| parameters     | Keys declared by the shape's kind (none yet), each with its own range and default.                                                                                | per key     |

A shape's data holds the parameters of its own kind. When its kind changes, the new kind's parameters are written with their defaults (or their values, for a parameter both kinds list) and the old kind's are removed, in the same undo step.

Colours are restricted to hexadecimal so that other readers of the file (exporters to SVG and PDF, other programs) need no CSS parser; the alpha digits allow transparent colours in either. Widths and radii are in world units, not relative to the box, as in most drawing programs: scaling a group changes the boxes, not the outline width.

The box is the element's envelope (`pos`, `size`, `rot`). A line's box is as long as the line and 0 high (the envelope allows a size of 0), and the element's rotation, in [0, 2π), is the line's direction from its start to its end. A line whose box is later made higher keeps running along the middle.

**Changing the kind changes the box only between lines and boxes.** A shape that becomes a kind drawn as a line gets a box 0 high; a box 0 high (a line) that becomes a kind drawn as a box gets a square as wide as the line. Both keep the box's centre, width and rotation, so a line turned into a rectangle is a square around the line's middle, turned the line's way. Between two kinds drawn as boxes, or two drawn as lines, the box stays.

### Growing the format

Shapes made by a later version must stay editable in an older one, and `updateElementData` refuses any edit while the data reads with a report (0005 section 3.2). So the reader is lenient towards values a later version may legitimately write, and strict only about values of the wrong form:

- A **choice** value of the right form (a kind name's form) that this version does not know is kept without a report and drawn as the parameter's default. So a later version may add an option (a new arrowhead) without making older versions refuse to edit the arrow.
- A **finite number** outside this version's range is kept without a report and drawn as the nearest value in range. So a later version may widen a range.
- A value of the **wrong form** (a string where a number belongs, a colour that is not hexadecimal, a choice that is not a name) is reported and drawn as the default, as before.
- Commands write only values this version allows (its ranges, its options, `MAX_LENGTH`).
- **New kinds of paint**, such as gradients or patterns, go in **new keys**. `fill` and `stroke` stay solid colours, and remain the fallback an older version draws.
- **Changing what a key means** is not growth: it needs a new key, or a new layout version with an upgrade (0005 section 3.8).

`kindTable` makes the rule possible: number ranges must be finite, within `MAX_LENGTH`, and choice values of the form of a kind name.

### A kind

A kind (`ShapeKind` in `kind.ts`) has a name, a label, an optional tool shortcut, whether it is `closed` (an area the fill fills) and has `corners` (that the corner rounding rounds), how the tool draws it (`drawing: "box"` from corner to corner, or `"line"` from point to point), its outline's `join` and `cap`, its parameters, and `outline(out, shape)`. The outline is drawn into `out.body`, which is filled (closed kinds) and stroked, and `out.marks`, which is filled with the outline colour (arrowheads, dots), from the box size, the limited corner radius, the outline width and the parameters. It must be a pure function of these.

From the outline alone the framework derives:

- **Drawing**: fill, outline and marks inside `withOpacity`. At the detail level `"box"` a filled shape drops its outline; an open one keeps it.
- **Hit testing**: the outline is recorded (`RecordingPath`) and flattened to polylines by the Canvas 2D rules (arcs joined to the current point, `rect` and `roundRect` as closed runs, `closePath` starting a new run). A point hits a closed, filled shape inside its fill (nonzero rule, as Canvas fills), and any shape within the tolerance plus half the outline width of its outline, or on a mark. A shape without fill is hit only on its outline, so what is behind it can be clicked through the middle, as in presentation programs.
- **Bounds**: the extent of the flattened outline grown by how far the stroke reaches, with the marks and the box. The reach is worked out from the flattened outline (`strokeReach` in `geometry.ts`): half the outline width along the line and at round joins and caps, √2/2 widths at square caps, and at each miter join half the miter length, 1/(2 sin(θ/2)) widths for the angle θ between the segments, unless Canvas bevels it (miter limit 10, which the renderer does not change). So a kind with sharp miter corners cannot be cut off by culling, whatever it forgets to say. A kind may draw outside its box (a speech bubble's tail) without saying so.
- **The tool's preview**, through a drawing context that turns paths (`placedContext`), because the overlay's context only translates.

Flattening keeps the chord error within a quarter of the hit tolerance or 1/4096 of the shape's size, whichever is larger, with at most 1,024 chords per curve, and adds the error to the distance and the bounds.

Parameters (`ShapeParam`: a number with a range, a choice of labelled values, or a toggle) are declared by the kinds and stored under keys of their own. Positions MUST be fractions of the box, so that resizing never changes data; sizes that should not grow with the box are in world units or outline widths. A key shared by several kinds is one parameter object listed by each; a parameter may not take a common key. `kindTable` checks these rules when the extension is built and throws, so a mistake fails every test.

`outline.ts` has `polygon`, a closed polygon with rounded corners (limited where edges are short), for the triangle and other polygons.

### The drawing tool

Each kind has a tool, `galatsa.shape/<kind>`, in the `shapes` group, offered in quick mode unless the kind says otherwise; rectangle `R`, ellipse `O`, line `L`.

- **Box kinds**: a drag from corner to corner; Shift makes a square, Alt draws from the centre.
- **Line kinds**: a drag from the start to the end; the box is centred between them, as long as the drag and 0 high, turned the drag's way; Shift keeps the angle to steps of 15 degrees.
- **A click** (less than 3 screen pixels of movement) makes a shape 100 screen pixels across at the camera's zoom, centred on the click; a horizontal line for line kinds.
- **The outline width** of a new shape is 2 screen pixels at the zoom it is drawn at (`strokeWidthAt`), as the click's size is, so a shape drawn far out is not invisible and one drawn deep in is not all outline.
- **The preview** is the shape in the style it will get, drawn in the overlay while the button is down. The document is not touched until the button is released; then one `insert` command makes the shape, one undo step, the new shape is selected, and the editor returns to its default tool. Escape or a cancelled pointer drops the drag without writing anything.

A gesture (0005 section 4.7) is not used: there is no element to preview yet.

### Commands and fields

- `galatsa.shape/insert` (`{ kind, x, y, w, h, rot?, parent?, style? }`): checks a known kind, a finite box of size ≥ 0, a valid style, and a parent that is the root or a container the user sees that is not locked; writes every key, selects the shape and returns its id. Undo step "new shape".
- `galatsa.shape/set-style` (a `FieldChange`): changes one key (a style key, `kind`, or a parameter) of one or more shapes, as one undo step. It acts only on shapes the basic commands would act on ([0005](0005-extension-interface.md) section 12.1: seen by the user, not locked and not in a locked container; it uses the basics' `canTarget`), whose type is loaded and not older than them. It is refused for values this version does not write, for a change of kind from an unknown kind, and when any shape's data with the change would not read cleanly; `enabled` makes the same checks as `execute`, so a menu or a field is greyed out rather than failing. Every field runs it, so a slider dragged with a gesture's preview ends as one step.

Fields: fill (closed kinds only), outline colour and outline width in quick mode; corner rounding (kinds with corners), opacity and the kind in advanced mode, as 0005 section 3.9 already describes for the sketch; then one field per parameter, for the kinds that list it. The properties panel is built later; the fields are defined and tested.

`FieldDefinition` gained an optional method, `applies(source)`: the editor shows a field for a selection only when it applies to every selected element. An additive change, so the interface version is now 1.3 (0005 updated).

### Changes outside the package

- **`@galatsa/extension-api`**: `FieldDefinition.applies`, interface 1.3.
- **`@galatsa/core`**: `setData` and `setExt` could not write `null` (a valid data value), because `checked` takes a null result for a failed read; they now wrap the value. Found by setting the fill to none; tested.
- **`@galatsa/extension-basics`** exports `canTarget`, `canTargetAll` and `isOpenContainer`, the rules of which elements a command may act on and which containers take new elements, so other extensions' commands follow the same rules. The shape extension's editing part depends on it.
- **The development page** (`apps/web`) loads the shape extension instead of the sketch's shapes (the other sketches stay). The sample scene's shapes are of the new type, the benchmark's lines as turned lines, and a kind the extension does not have yet (the triangle) as a rectangle until it is added. Its stored copy has a new key, so a copy of the old type is not opened again.
- **`tests/e2e/playwright.config.ts`**: the dev server ports can be set with `E2E_WEB_PORT` and `E2E_BENCH_PORT`. Outside CI an existing server on the port is reused, which was another working copy's.
- **`scripts/lib/viewer-bundle.test.ts`** also bundles the shapes' viewing part: no editing code, about 22 kB of the bundle's 69 kB, of the 80 kB budget (unminified).

The sketch `examples.shape` stays in `packages/extensions/examples`: the editor's and the basics' tests use it as a simple element type, and it shows the interface as 0005 section 11 describes. It is no longer loaded by the development page.

### Screenshot tests

`shapeGallery(kind)` (`gallery.ts`) makes the same cases for every kind from its description: the default style, a thick outline without fill, half opacity, turned, narrow, fill without outline (closed kinds), rounded corners (kinds with corners), and one case per parameter with a value other than the default. Each case gets a cell at least 120 pixels square and large enough for everything it draws (from its bounds), so an outline or a part drawn outside the box (a tail) is never clipped or drawn into the next case. The gallery page (`apps/web/shapes.html`, served by the development server) draws each kind's cases side by side with the real renderer into a canvas of its own, at a device pixel ratio of 1 whatever the screen. `tests/e2e/shapes-visual.spec.ts` takes each canvas's pixels (`toDataURL`, so the compositor, scroll bars and the screen play no part) and compares them with `<kind>-<project>-<platform>.png`. A new kind is picked up from the page; a run with `--update-snapshots=missing` writes its pictures and passes, and they are looked at and checked in. `scripts/lib/shape-pictures.test.ts` (part of `pnpm check`) fails while a listed kind has no pictures or a picture belongs to no kind.

The comparison allows a colour difference of 1 % (`threshold: 0.01`) in at most 8 pixels. Rendering is deterministic in one browser build: three runs in a row gave the same pictures in Chromium and in Firefox. Each of these changes fails the test in both browsers: round caps of the line made butt, the rectangle's miter joins made round, the default fill changed from `#93c5fd` to `#9cc5fd`, an opacity of 0.5 drawn as 0.6, and the outline drawn half a unit wider.

Pictures are stored for Chromium (`chromium`) and Firefox (`editor-firefox`) on Linux. They are not run in CI: the pictures are made per browser build and platform, and CI's would have to be made there.

## Known limitations

- **Opacity is applied to the fill and the outline separately** (the renderer's `withOpacity` multiplies the alpha of each drawing call), so where the outline overlaps the fill, a half-transparent shape shows a darker band (visible in the gallery's "half opacity" case). Drawing the shape as one layer needs a layer in the renderer.
- **`applies` is not evaluated yet.** No editor code shows or hides fields by it; the properties panel, when it is built, must show a field for a selection only where it applies to every selected element.
- **Outline widths and corner radii do not follow a scaled group.** Scaling changes the boxes only (0005 section 12.1); a type has no way yet to scale its data with them. Adding one is an additive change to the interface, not to the file format.
- **Hit testing of curves at very deep zoom** is exact to 1/4096 of the shape's size: on a shape 100,000 screen pixels across, its curved edges are hit to about 25 pixels.
- **A line is a box 0 high.** Handles for resizing and rotating it, and an endpoint editor, belong to the selection tool; resizing its box past zero does not swap its ends.
- **The label of a thin placeholder** is drawn above its box, outside the bounds the renderer culls and redraws by.
- **Tool shortcuts** are not checked for conflicts by the command registry (it checks commands); the shape tests check that the shape tools' keys differ from each other and from the text and selection tools'.
- **No screenshot pictures for WebKit** (Playwright's WebKit does not run on the development machine), and none made or compared in CI.
- **The viewer bundle** has about 11 kB left of its 80 kB budget with the shapes; four more kinds of a few hundred bytes each fit, a larger addition to the viewing part may not.
- The tool's preview leaves out images and text (a kind does not draw them).

## Rejected alternatives

- **One element type per kind**: above.
- **Lines stored by their end points in data**, or in a box from corner to corner with flags for the direction. Moving, resizing, turning and scaling are commands on the envelope that know nothing of a type's data; a line whose ends are in the envelope (its box and rotation) works with all of them, and its direction comes with it.
- **Each kind writing its own hit test, or saying how far its stroke reaches.** Both are worked out from the outline: exact for straight edges, within the error above for curves, and a new kind cannot get them wrong.
- **CSS colour strings** in data, as the sketch had: any reader of the file would need a CSS colour parser.
- **A strict reader for every value**: a later version that added an option would make its shapes uneditable in every older version.
- **Every kind's parameters in every model**: adding a parameter to one kind would change what every other kind reads, and the data of a shape would carry keys of kinds it is not.
- **Screenshots of the page** (`toHaveScreenshot`) instead of the canvas's pixels: they include the compositor's scaling and antialiasing, which differ more between runs.
- **A screenshot test per kind written by hand**: the cases are generated from the kind, so a kind cannot be added without one.

## Tests

- `packages/extensions/shape/src/geometry.test.ts`: arc sweeps by the Canvas 2D rules; rectangles, `closePath`, arcs joined to the current point, rounded rectangles and their radius limit, curves within the tolerance; the nonzero fill rule and distances to open runs; turned paths give the same outline as turning the points; polygons with rounded corners match rounded rectangles, stay inside a triangle either way round, and are plain lines without a radius.
- `packages/extensions/shape/src/shape.test.ts`, with the real document model, its expectations taken from `SHAPE_KINDS`: loading with the tools, commands and fields per mode and no conflicts; text in both languages; the viewing part alone in a viewer; reading every key, defaults, values of the wrong form reported, numbers out of range read without a report and drawn in range, unknown kinds and keys; insert writes every key, selects, is one named undo step, normalizes the rotation and takes a style; refused arguments write nothing; changing several shapes is one step; refused changes write nothing; locked shapes, shapes in a locked frame and deleted shapes are not changed; insert only into the root or an open container; a change is not offered when the data would not read cleanly, and is when it repairs the damaged key; a shape with values beyond this version's ranges stays editable; colours written in lower case; widths beyond `MAX_LENGTH` refused; a line becomes a square around its middle and a box a line, as one undo step; no change of kind from an unknown kind; fields apply to the right kinds and change one shape each as one step; a continuous field change previews and writes once; a shape of a newer kind is a placeholder, hit by its box, and keeps its kind and keys; a thin one is a solid line with its label; drawing with joins and opacity, no fill for lines, corner radius limits, the detail level "box"; hit testing inside, on the outline, the real outline of ellipses and rounded rectangles, lines; bounds with the outline's reach; the tool previews without writing and inserts with one command, Shift and Alt, a click's size and the outline width at the zoom, lines from point to point and Shift's angle steps, Escape and a cancelled pointer, other buttons.
- `packages/extensions/shape/src/kinds.test.ts`: for every listed kind, and for kinds written in the test (one with a number and a choice parameter and marks, one with sharp miter corners, one with a part outside its box): its name and text, its tool and key, every gallery case read cleanly and drawn, every point of its outline and every point its stroke covers (miter tips included) within the bounds, its outline hit, nothing far away hit, the same outline every time, and the tool's preview and single undo step. For the written kinds: they load, a parameter is a field for its kind alone, is written and checked through the common commands, a model holds only its own kind's parameters, values of a newer version are read without a report and stay editable, a change of kind writes the new kind's parameters and drops the old kind's, marks are drawn and hit, the gallery has a case for each parameter and cells large enough for a part outside the box. The kind table refuses bad names, repeated kinds, a parameter under a common key, one key for two parameters, a default out of range, ranges that are not finite or too wide, and choice values that could not be kept.
- `packages/core/src/ydoc/encode.test.ts`: `setData` writes null.
- `scripts/lib/shape-pictures.test.ts`: every listed kind has its pictures, and every picture a kind.
- `tests/e2e/shapes-visual.spec.ts`: every kind's gallery canvas as stored, in Chromium and Firefox.
- `tests/e2e/shape-tool.spec.ts` (Chromium, Firefox, and WebKit where Playwright's WebKit runs: in CI): the rectangle tool picked by its key, the preview's fill on the canvas while dragging with the document unchanged, one shape and one undo step on release, its size, Ctrl+Z taking it back whole and Ctrl+Shift+Z bringing it again; the line tool's preview, length and direction; Escape cancelling the ellipse tool's drag.
- `tests/e2e/webkitgtk/shape_check.py`: the same in the system's WebKitGTK with real input under Xvfb.
- `tests/e2e/editor.spec.ts` and `tests/e2e/webkitgtk/editor_check.py` use the shape extension's rectangle tool and type.
