// SPDX-License-Identifier: GPL-3.0-or-later

// Ellipse: the largest ellipse in the box (a circle in a square box).

import { defineShapeKind, shapeLabel } from "../kind.ts";

export const ellipse = defineShapeKind({
  kind: "ellipse",
  label: shapeLabel("kind.ellipse"),
  shortcut: "o",
  closed: true,
  outline({ body }, { w, h }) {
    body.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
  },
});
