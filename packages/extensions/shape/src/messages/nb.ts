// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the shape extension (namespace "galatsa.shape"). "kind.<kind>" names
// a shape kind (and its drawing tool); "param.<key>" names a property only
// some kinds have, and "param.<key>.<value>" one of its choices. Keys ending in
// ".step" name the undo step a command makes, as in "Angre ny form".

export default {
  name: "Form",
  insert: "Sett inn form",
  "insert.step": "ny form",
  "set-style": "Endre form",
  "set-style.step": "endring av form",
  fill: "Fyll",
  stroke: "Strek",
  "stroke-width": "Strektykkelse",
  "corner-radius": "Avrunding av hjørner",
  opacity: "Dekkevne",
  kind: "Form",
  "kind.rect": "Rektangel",
  "kind.ellipse": "Ellipse",
  "kind.line": "Linje",
  "kind.triangle": "Trekant",
  "param.apexX": "Toppunkt",
};
