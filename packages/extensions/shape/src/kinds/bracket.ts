// SPDX-License-Identifier: GPL-3.0-or-later

// Bracket: an open outline along the box's left edge, opening to the right, as
// "{", "(" or "[" in its box; turned, it brackets things from any side. The
// curly bracket's point, and the round bracket's deepest point, is on the left
// edge at a height that is a parameter.
//
// The curly bracket is drawn as the character is: two straight arms down the
// middle of the box, small curls at the ends and at the point, and a sharp
// point. Its curls are quarter ellipses half the box wide and a small part of
// the height high (never higher than they are wide, so a tall narrow box gives
// round curls), less where the arms would get no length.

import { defineShapeKind, shapeLabel, type ShapeParam } from "../kind.ts";

const STYLE: ShapeParam = {
  type: "choice",
  key: "bracket",
  label: shapeLabel("param.bracket"),
  // The gallery shows the first option other than the default, so the round
  // bracket, whose curves need looking at more than the square one's lines.
  options: [
    { value: "curly", label: shapeLabel("param.bracket.curly") },
    { value: "round", label: shapeLabel("param.bracket.round") },
    { value: "square", label: shapeLabel("param.bracket.square") },
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

/** Height of the curly bracket's curls, as a fraction of the height. */
const CURL: ShapeParam = {
  type: "number",
  key: "curl",
  label: shapeLabel("param.curl"),
  min: 0.02,
  max: 0.2,
  step: 0.01,
  default: 0.08,
};

const QUARTER = Math.PI / 2;
/**
 * How far round the round bracket goes from its deepest point to each end:
 * less than a quarter, so that its ends lean in as the character's do.
 */
const ROUND_SWEEP = Math.PI / 3;

export const bracket = defineShapeKind({
  kind: "bracket",
  label: shapeLabel("kind.bracket"),
  shortcut: "k",
  closed: false,
  params: [STYLE, POINT_Y, CURL],
  outline({ body }, { w, h, params }) {
    const y = (params["pointY"] as number) * h;
    switch (params["bracket"]) {
      case "square":
        body.moveTo(w, 0);
        body.lineTo(0, 0);
        body.lineTo(0, h);
        body.lineTo(w, h);
        return;
      case "round": {
        // Two pieces of ellipses of one width, meeting upright at the deepest
        // point, each as high as its part of the bracket.
        const sin = Math.sin(ROUND_SWEEP);
        const rx = w / (1 - Math.cos(ROUND_SWEEP));
        body.moveTo(w, 0);
        body.ellipse(rx, y, rx, y / sin, 0, ROUND_SWEEP - Math.PI, -Math.PI, true);
        body.ellipse(rx, y, rx, (h - y) / sin, 0, Math.PI, Math.PI - ROUND_SWEEP, true);
        return;
      }
      default: {
        // Curly: down from the top end to the point and on to the bottom end.
        const rx = w / 2;
        const ry = Math.min(rx, (params["curl"] as number) * h, y / 2, (h - y) / 2);
        body.moveTo(w, 0);
        body.ellipse(w, ry, rx, ry, 0, -QUARTER, -Math.PI, true);
        body.lineTo(rx, y - ry);
        body.ellipse(0, y - ry, rx, ry, 0, 0, QUARTER);
        body.ellipse(0, y + ry, rx, ry, 0, -QUARTER, 0);
        body.lineTo(rx, h - ry);
        body.ellipse(w, h - ry, rx, ry, 0, Math.PI, QUARTER, true);
      }
    }
  },
});
