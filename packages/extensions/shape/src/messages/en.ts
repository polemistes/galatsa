// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the shape extension (namespace "galatsa.shape"). "kind.<kind>" names
// a shape kind (and its drawing tool); "param.<key>" names a property only
// some kinds have, and "param.<key>.<value>" one of its choices. Keys ending in
// ".step" name the undo step a command makes, as in "Undo new shape".

export default {
  name: "Shape",
  insert: "Insert shape",
  "insert.step": "new shape",
  "set-style": "Change shape",
  "set-style.step": "shape change",
  fill: "Fill",
  stroke: "Outline",
  "stroke-width": "Outline width",
  "corner-radius": "Corner rounding",
  opacity: "Opacity",
  kind: "Shape",
  "kind.rect": "Rectangle",
  "kind.ellipse": "Ellipse",
  "kind.line": "Line",
  "kind.triangle": "Triangle",
  "param.apexX": "Top point",
};
