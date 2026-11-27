# @galatsa/extension-shape

The built-in shape extension (`galatsa.shape`). Every shape is an element of one type, `galatsa.shape/shape`, whose data names its **kind** (rectangle, ellipse, line, ...). A kind is a small object that draws an outline in the element's box; everything else comes from the framework in this package. The reasons are in [docs/adr/0010-shapes.md](../../../docs/adr/0010-shapes.md).

| File                | What it is                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `src/kind.ts`       | `ShapeKind`, `ShapeParam`, `defineShapeKind`, `shapeLabel`: what a kind is.                       |
| `src/kinds/*.ts`    | One file per kind, and `kinds/index.ts`, the list (`SHAPE_KINDS`).                                |
| `src/outline.ts`    | Helpers for outlines: `polygon` (rounded corners).                                                |
| `src/model.ts`      | The data: keys, value ranges, defaults, the reader, the growth rule.                              |
| `src/draw.ts`       | Drawing, hit testing and bounds from a kind's outline.                                            |
| `src/geometry.ts`   | Flattening outlines to polylines (Canvas 2D rules), distances, the fill rule, the stroke's reach. |
| `src/tool.ts`       | The drawing tool of each kind, with its preview.                                                  |
| `src/index.ts`      | The editing part: insert and change commands, fields, tools (`shapeExtension`).                   |
| `src/view.ts`       | The viewing part, for the player (`shapeViewExtension`; entry `@galatsa/extension-shape/view`).   |
| `src/gallery.ts`    | The cases every kind is drawn in for its screenshot test.                                         |
| `src/kinds.test.ts` | Checks every listed kind must pass, and kinds written in the test to show the framework is done.  |

## Adding a kind

Adding a kind changes no framework file and no test. It takes one new file, one line in the list, its text, and its pictures, in this order. Take `kinds/rect.ts` (closed, with corners), `kinds/ellipse.ts` (closed) or `kinds/line.ts` (open, drawn from point to point) as the model, whichever is closest.

1. **Add its text** to `src/messages/en.ts` and `src/messages/nb.ts`: `"kind.<kind>"`, and for each parameter `"param.<key>"` and, for choices, `"param.<key>.<value>"`. This comes first, because `shapeLabel("kind.<kind>")` in the next step is checked against these keys by the type checker. `pnpm check:i18n` fails if the two files differ.
2. **Write `src/kinds/<kind>.ts`**, exporting `defineShapeKind({ ... })`:
   - `kind`: the name stored in documents. Lowercase letters, digits and hyphens. It can never be renamed.
   - `label: shapeLabel("kind.<kind>")`, and optionally `shortcut` (one key that picks the tool; it must not be taken: `r`, `o`, `l`, `t` and `v` are) and `quick: false` to keep the tool out of quick mode.
   - `closed`: true if the outline is an area that the fill colour fills. Open outlines (lines, brackets) are only stroked; their fill field is hidden.
   - `corners: true` if the corner rounding applies; the outline then gets `cornerRadius`, already limited to half the shorter side of the box.
   - `drawing: "line"` if the tool should draw it from point to point (a line, an arrow): the box is then as long as the drag and 0 high, turned the drag's way, and the kind draws along the middle of its box, from (0, h/2) to (w, h/2), start to end. Otherwise the tool draws a box from corner to corner.
   - `defaults`: style a new shape of this kind gets instead of the common defaults, such as `{ cornerRadius: 16 }` for a speech bubble that starts rounded. Only the common keys (`fill`, `stroke`, `strokeWidth`, `cornerRadius`, `opacity`). Lengths are screen pixels at the zoom the shape is drawn at (world units at zoom 1); the tool scales them. They are written into new shapes only: data without a key still means the common default.
   - `join` and `cap` for the outline (both default `"round"`). How far sharp miter joins or square caps reach outside the outline is worked out by the framework from the outline itself.
   - `params`: properties only this kind has (see below).
   - `outline(out, shape)`: draws the outline. `shape` has the box size `w` and `h`, `cornerRadius`, `strokeWidth` (0 without an outline) and `params` (this kind's, read and checked). Draw the body into `out.body` (filled and stroked), and anything filled with the outline colour (an arrowhead, a dot) into `out.marks`. Use only `out`, `shape` and plain arithmetic: the same input must always give the same outline, because the framework also uses it for hit testing, bounds and the preview. The outline may reach outside the box (a speech bubble's tail); bounds follow, and so does the gallery's cell. For polygons, `polygon(out.body, points, shape.cornerRadius)` rounds the corners.
3. **List it** in `src/kinds/index.ts`, where it should appear in menus and the toolbar.
4. **Run the tests**: `pnpm vitest run packages/extensions/shape`. The tests take the kinds, tools and fields from `SHAPE_KINDS`, so none needs changing. `kinds.test.ts` checks every listed kind: its name and text in both languages, its tool and shortcut, that every gallery case reads cleanly and draws, that every point of the outline and everything the stroke covers (miter tips included) is inside the bounds, that the outline is hit and nothing far away is, that the outline is the same every time, and that the tool previews and inserts it as one undo step.
5. **Make its pictures**: the shape gallery draws the new kind by itself. Run

   ```sh
   pnpm --filter @galatsa/e2e exec playwright test shapes-visual.spec.ts \
     --project=chromium --project=editor-firefox --update-snapshots=missing
   ```

   It writes the missing pictures and passes. Look at the new `tests/e2e/shapes-visual.spec.ts-snapshots/<kind>-*.png` (or at `apps/web/shapes.html` in the development server: `pnpm --filter @galatsa/web dev`), and check them in. Until they are there, `pnpm check` fails (`scripts/lib/shape-pictures.test.ts`). Pictures of the existing kinds must not change. If another working copy may be running a dev server on port 5198, set `E2E_WEB_PORT` (and `E2E_BENCH_PORT`) to free ports first.

6. **Run `pnpm check`.**

The sample scene on the development page uses a kind of the benchmark scene (`triangle`) as soon as it is listed.

### Parameters

A parameter is a property only some kinds have. Declare it as a `ShapeParam` constant in the kind's file (or in a file of its own when several kinds share it, and list the same object in each):

```ts
const TAIL_X: ShapeParam = {
  type: "number", // or "choice" with options, or "toggle"
  key: "tailX", // the data key, next to the common ones; never renamed
  label: shapeLabel("param.tailX"),
  min: -0.5,
  max: 1.5,
  step: 0.05,
  default: 0.25,
};
```

- Positions are **fractions of the box** (0 to 1, beyond for outside it), never world units, so that resizing a shape never has to change its data. Sizes that should not grow with the box (an arrowhead) are in world units, or in outline widths.
- The default is what data without the key means, forever. Choose it so that the kind looks right without the key.
- Number ranges are finite (within `MAX_LENGTH`); choice values have the form of a kind name (lowercase letters, digits, hyphens), so that a later version's new options can be kept (below).
- The framework reads and checks the value, offers it as a field in advanced mode (`quick: true` for quick mode too) for the kinds that list it, and writes it with the common change command. When the kind of a shape changes, the new kind's parameters are written with their defaults and the old kind's are removed. The gallery adds a case with a value other than the default.
- Data keys share one namespace, forever: the common keys (`kind`, `fill`, `stroke`, `strokeWidth`, `cornerRadius`, `opacity`) and every parameter of every kind, now and later. A parameter must never reuse a common key, nor a key another parameter had with another meaning, also one that was removed. Keys are plain identifiers starting with a lowercase letter (`tailX`).
- When a shape's kind changes, a parameter both kinds list keeps its value; the old kind's other parameters are removed, and the new kind's are written with their defaults.
- A toggle can never grow: a third state would be a value of the wrong form for older versions. If more states are likely, use a choice from the start.

### Growing the format

Shapes made by a later version must stay editable in this one. So the reader keeps values a later version may write, without a report: a well-formed choice it does not know is drawn as the parameter's default, and a finite number outside the range is drawn as the nearest value in range; both stay in the data untouched when other keys are changed. Only a value of the wrong form (a string where a number belongs) is reported. That means:

- **Adding an option** to a choice, or **widening a number's range**, needs no new layout version and breaks nothing in older versions.
- **Changing what a key means** (a different unit, a different default) is not growth: it needs a new key, or a new layout version with an upgrade (docs/adr/0005, section 3.8).
- **New kinds of paint**, such as gradients or patterns, go in **new keys**. `fill` and `stroke` stay solid colours (`"#rrggbb"`, `"#rrggbbaa"` or `null`), and remain the fallback an older version draws. The new key must record the `fill` it was written with, and is drawn only while `fill` still has that value, so that an older version's change of the fill wins and `null` always means no fill.

### Notes for the planned kinds

- **Triangle**: closed, `corners: true`, `polygon` through (w/2, 0), (w, h), (0, h); a parameter for where the top point is (a fraction of the width, default 0.5) gives right-angled triangles. Round joins, or `join: "miter"` for sharp tips.
- **Arrow**: like the line (`drawing: "line"`, open), with heads as `marks` at the ends: parameters for each end (`startHead`, `endHead`: a choice such as `none`, `arrow`) and the head size in outline widths. End the shaft where a head begins, and use `cap: "butt"` so the shaft does not show through the tip. A later head style is a new option, which older versions draw as the default.
- **Bracket**: open, drawn in its box; a choice parameter for the style (square, round, curly) if more than one is wanted.
- **Speech bubble**: closed, `corners: true`, rounded from the start (`defaults`); the body is a rounded box with a tail whose tip is a parameter pair (`tailX`, `tailY`, fractions of the box, beyond 1 to point outside it). Build it as one outline (lines and arcs) so the fill and outline have no seam.
