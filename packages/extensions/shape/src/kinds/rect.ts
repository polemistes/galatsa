// SPDX-License-Identifier: GPL-3.0-or-later

// Rectangle: the whole box, with rounded corners when asked for.

import { defineShapeKind, shapeLabel } from "../kind.ts";

export const rect = defineShapeKind({
  kind: "rect",
  label: shapeLabel("kind.rect"),
  shortcut: "r",
  closed: true,
  corners: true,
  // Sharp corners, as rectangles are expected to have.
  join: "miter",
  outline({ body }, { w, h, cornerRadius }) {
    if (cornerRadius > 0) body.roundRect(0, 0, w, h, cornerRadius);
    else body.rect(0, 0, w, h);
  },
});
