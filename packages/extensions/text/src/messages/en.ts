// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the text extension (namespace "galatsa.text"). Keys ending in
// ".step" name the undo step a command makes, as in "Undo new text".

export default {
  name: "Text",
  tool: "Text",
  insert: "Insert text",
  "insert.step": "new text",
  "set-style": "Change text",
  "set-style.step": "text change",
  bold: "Bold",
  "bold.step": "bold",
  italic: "Italic",
  "italic.step": "italic",
  bullets: "Bulleted list",
  "bullets.step": "bulleted list",
  numbers: "Numbered list",
  "numbers.step": "numbered list",
  "font-family": "Font",
  "font.sans": "Sans serif (Noto Sans)",
  "font.serif": "Serif (Noto Serif)",
  "font.mono": "Monospace (Noto Sans Mono)",
  "font-size": "Size",
  color: "Colour",
  align: "Alignment",
  "align.left": "Left",
  "align.center": "Centre",
  "align.right": "Right",
};
