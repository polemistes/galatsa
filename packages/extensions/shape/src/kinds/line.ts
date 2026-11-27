// SPDX-License-Identifier: GPL-3.0-or-later

// Line: a straight line along the middle of the box, from its left edge to its
// right edge. The drawing tool makes the box as long as the drag and 0 high,
// and turns it in the drag's direction, so the element's rotation is the
// line's direction and the box's width its length.

import { defineShapeKind, shapeLabel } from "../kind.ts";

export const line = defineShapeKind({
  kind: "line",
  label: shapeLabel("kind.line"),
  shortcut: "l",
  closed: false,
  drawing: "line",
  outline({ body }, { w, h }) {
    body.moveTo(0, h / 2);
    body.lineTo(w, h / 2);
  },
});
