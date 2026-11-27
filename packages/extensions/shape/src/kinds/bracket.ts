// SPDX-License-Identifier: GPL-3.0-or-later

// Bracket: an open outline along the box's left edge, opening to the right, as
// "{", "[" or "(" in its box; turned, it brackets things from any side. The
// curly bracket's point, and the round bracket's deepest point, is on the left
// edge at a height that is a parameter. The curls are quarter ellipses as wide
// as half the box and at most half as high as their half of the bracket, so a
// tall narrow box gives round curls and long straight parts between them.

import { defineShapeKind, shapeLabel, type ShapeParam } from "../kind.ts";

const STYLE: ShapeParam = {
  type: "choice",
  key: "bracket",
  label: shapeLabel("param.bracket"),
  options: [
    { value: "curly", label: shapeLabel("param.bracket.curly") },
    { value: "square", label: shapeLabel("param.bracket.square") },
    { value: "round", label: shapeLabel("param.bracket.round") },
  ],
  default: "curly",
};

/** Height of the point (curly) or the deepest point (round), as a fraction of the height. */
const POINT_Y: ShapeParam = {
  type: "number",
  key: "pointY",
  label: shapeLabel("param.pointY"),
  min: 0.1,
  max: 0.9,
  step: 0.05,
  default: 0.5,
};

const QUARTER = Math.PI / 2;

export const bracket = defineShapeKind({
  kind: "bracket",
  label: shapeLabel("kind.bracket"),
  shortcut: "k",
  closed: false,
  params: [STYLE, POINT_Y],
  outline({ body }, { w, h, params }) {
    const y = (params["pointY"] as number) * h;
    switch (params["bracket"]) {
      case "square":
        body.moveTo(w, 0);
        body.lineTo(0, 0);
        body.lineTo(0, h);
        body.lineTo(w, h);
        return;
      case "round":
        body.moveTo(w, 0);
        body.ellipse(w, y, w, y, 0, -QUARTER, -Math.PI, true);
        body.ellipse(w, y, w, h - y, 0, Math.PI, QUARTER, true);
        return;
      default: {
        // Curly: two curls in each half, the upper half from the top end to
        // the point, the lower half from the point to the bottom end.
        const rx = w / 2;
        const top = Math.min(rx, y / 2);
        const bottom = Math.min(rx, (h - y) / 2);
        body.moveTo(w, 0);
        body.ellipse(w, top, rx, top, 0, -QUARTER, -Math.PI, true);
        body.lineTo(rx, y - top);
        body.ellipse(0, y - top, rx, top, 0, 0, QUARTER);
        body.ellipse(0, y + bottom, rx, bottom, 0, -QUARTER, 0);
        body.lineTo(rx, h - bottom);
        body.ellipse(w, h - bottom, rx, bottom, 0, Math.PI, QUARTER, true);
      }
    }
  },
});
