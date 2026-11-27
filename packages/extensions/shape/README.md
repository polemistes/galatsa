# @galatsa/extension-shape

The built-in shape extension (`galatsa.shape`). Every shape is an element of one type, `galatsa.shape/shape`, whose data names its **kind** (rectangle, ellipse, line, ...). A kind is a small object that draws an outline in the element's box; everything else comes from the framework in this package. The reasons are in [docs/adr/0008-shapes.md](../../../docs/adr/0008-shapes.md).

| File                | What it is                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `src/kind.ts`       | `ShapeKind`, `ShapeParam`, `defineShapeKind`, `shapeLabel`: what a kind is.                       |
| `src/kinds/*.ts`    | One file per kind, and `kinds/index.ts`, the list (`SHAPE_KINDS`).                                |
| `src/outline.ts`    | Helpers for outlines: `polygon` (rounded corners), `MITER_REACH`.                                 |
| `src/model.ts`      | The data: keys, value ranges, defaults, the reader.                                               |
| `src/draw.ts`       | Drawing, hit testing and bounds from a kind's outline.                                            |
| `src/geometry.ts`   | Flattening outlines to polylines (Canvas 2D rules), distances, the fill rule, turned paths.       |
| `src/tool.ts`       | The drawing tool of each kind, with its preview.                                                  |
| `src/index.ts`      | The editing part: insert and change commands, fields, tools (`shapeExtension`).                   |
| `src/view.ts`       | The viewing part, for the player (`shapeViewExtension`; entry `@galatsa/extension-shape/view`).   |
| `src/gallery.ts`    | The cases every kind is drawn in for its screenshot test.                                         |
| `src/kinds.test.ts` | Checks every listed kind must pass, and a kind written in the test to show the framework is done. |

## Adding a kind

Adding a kind changes no framework file. It takes one new file, one line in the list, its text, and its pictures. Take `kinds/rect.ts` (closed, with corners), `kinds/ellipse.ts` (closed) or `kinds/line.ts` (open, drawn from point to point) as the model, whichever is closest.

1. **Write `src/kinds/<kind>.ts`**, exporting `defineShapeKind({ ... })`:
   - `kind`: the name stored in documents. Lowercase letters, digits and hyphens. It can never be renamed.
   - `label: shapeLabel("kind.<kind>")`, and optionally `shortcut` (one key that picks the tool; it must not be taken: `r`, `o`, `l`, `t` and `v` are) and `quick: false` to keep the tool out of quick mode.
   - `closed`: true if the outline is an area that the fill colour fills. Open outlines (lines, brackets) are only stroked; their fill field is hidden.
   - `corners: true` if the corner rounding applies; the outline then gets `cornerRadius`, already limited to half the shorter side of the box.
   - `drawing: "line"` if the tool should draw it from point to point (a line, an arrow): the box is then as long as the drag and 0 high, turned the drag's way, and the kind draws along the middle of its box, from (0, h/2) to (w, h/2), start to end. Otherwise the tool draws a box from corner to corner.
   - `join` and `cap` for the outline (both default `"round"`). With `join: "miter"`, set `strokeReach` to how far the corners reach out in outline widths: `Math.SQRT1_2` for right angles, `MITER_REACH` when corners can be sharper.
   - `params`: properties only this kind has (see below).
   - `outline(out, shape)`: draws the outline. `shape` has the box size `w` and `h`, `cornerRadius`, `strokeWidth` (0 without an outline) and `params`. Draw the body into `out.body` (filled and stroked), and anything filled with the outline colour (an arrowhead, a dot) into `out.marks`. Use only `out`, `shape` and plain arithmetic: the same input must always give the same outline, because the framework also uses it for hit testing, bounds and the preview. The outline may reach outside the box (a speech bubble's tail); bounds follow. For polygons, `polygon(out.body, points, shape.cornerRadius)` rounds the corners.
2. **List it** in `src/kinds/index.ts`, where it should appear in menus and the toolbar.
3. **Add its text** to `src/messages/en.ts` and `src/messages/nb.ts`: `"kind.<kind>"`, and for each parameter `"param.<key>"` and, for choices, `"param.<key>.<value>"`. `pnpm check:i18n` fails if the two files differ.
4. **Run the tests**: `pnpm vitest run packages/extensions/shape`. `kinds.test.ts` checks every listed kind: its name and text in both languages, its tool and shortcut, that every gallery case reads cleanly and draws, that every point of the outline is inside the bounds and is hit, that nothing far away is hit, that the outline is the same every time, and that the tool previews and inserts it as one undo step.
5. **Make its pictures**: the shape gallery draws the new kind by itself. Run

   ```sh
   pnpm --filter @galatsa/e2e exec playwright test shapes-visual.spec.ts \
     --project=chromium --project=editor-firefox --update-snapshots=missing
   ```

   Look at the new `tests/e2e/shapes-visual.spec.ts-snapshots/<kind>-*.png` (or at `apps/web/shapes.html` in the development server: `pnpm --filter @galatsa/web dev`), and check them in. Pictures of the existing kinds must not change. If another working copy may be running a dev server on port 5198, set `E2E_WEB_PORT` (and `E2E_BENCH_PORT`) to free ports first.

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
- The framework reads and checks the value (a value out of range is read as the default and reported), offers it as a field in advanced mode (`quick: true` for quick mode too) for the kinds that list it, and writes it with the common change command. The gallery adds a case with a value other than the default.
- A key that the common style uses (`kind`, `fill`, `stroke`, `strokeWidth`, `cornerRadius`, `opacity`) cannot be a parameter, and one key cannot mean two parameters.

### Notes for the planned kinds

- **Triangle**: closed, `corners: true`, `polygon` through (w/2, 0), (w, h), (0, h); a parameter for where the top point is (a fraction of the width, default 0.5) gives right-angled triangles. Round joins, or `join: "miter"` with `strokeReach: MITER_REACH`.
- **Arrow**: like the line (`drawing: "line"`, open), with heads as `marks` at the ends: parameters for each end (`startHead`, `endHead`: a choice such as `none`, `arrow`) and the head size in outline widths. End the shaft where a head begins, and use `cap: "butt"` so the shaft does not show through the tip.
- **Bracket**: open, drawn in its box; a choice parameter for the style (square, round, curly) if more than one is wanted.
- **Speech bubble**: closed, `corners: true`; the body is a rounded box with a tail whose tip is a parameter pair (`tailX`, `tailY`, fractions of the box, beyond 1 to point outside it). Build it as one outline (lines and arcs) so the fill and outline have no seam.
