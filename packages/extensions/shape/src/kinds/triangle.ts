// SPDX-License-Identifier: GPL-3.0-or-later

// Triangle: from a top point on the box's upper edge to the two lower corners.
// The top point is in the middle by default (an isosceles triangle); at either
// end of the edge the triangle is right-angled.

import { defineShapeKind, shapeLabel, type ShapeParam } from "../kind.ts";
import { polygon } from "../outline.ts";

/** Where the top point is on the upper edge, as a fraction of the width. */
const APEX_X: ShapeParam = {
  type: "number",
  key: "apexX",
  label: shapeLabel("param.apexX"),
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
};

export const triangle = defineShapeKind({
  kind: "triangle",
  label: shapeLabel("kind.triangle"),
  shortcut: "y",
  closed: true,
  corners: true,
  // Sharp tips, as triangles are expected to have.
  join: "miter",
  params: [APEX_X],
  outline({ body }, { w, h, cornerRadius, params }) {
    const apex = (params["apexX"] as number) * w;
    polygon(
      body,
      [
        { x: apex, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
      cornerRadius,
    );
  },
});
