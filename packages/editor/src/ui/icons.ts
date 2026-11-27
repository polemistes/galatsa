// SPDX-License-Identifier: GPL-3.0-or-later

// The program's icon set (docs/adr/0016): line drawings on a 24 × 24 grid,
// drawn with a 2 px round stroke and no fill, made for Galatsa (no icon
// library). Tools and commands name an icon with `icon`; without one, the
// toolbar looks for their name here ("galatsa.shape/rect" → "rect"), and
// falls back to a dot.

/** Each icon is one SVG path, in a 24 × 24 view box. */
export const ICONS: { readonly [name: string]: string } = {
  select: "M5 3v16l4.5-4.5 3 6.5 2.5-1-3-6.5H18Z",
  // i18n-ignore: an SVG path, not text
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  rect: "M4 6h16v12H4Z",
  ellipse: "M3 12a9 6.5 0 1 0 18 0a9 6.5 0 1 0-18 0Z",
  triangle: "M12 4l9 15H3Z",
  line: "M5 19L19 5",
  arrow: "M5 19L19 5M10 5h9v9",
  "speech-bubble": "M4 5h16v10h-9l-5 4v-4H4Z",
  bracket: "M10 4H6v16h4",
  crop: "M6 2v16h16M2 6h16v16",
  image:
    "M3 5h18v14H3ZM3 16l5-5 5 5M12 15l3-3 6 6M17 8.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0",
  frame: "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8Z",
  route:
    "M3 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M17 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 18c7 0 3-12 10-12",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h4",
  present: "M3 4h18v12H3ZM12 16v4M8 20h8M10 7.5v5l4.5-2.5Z",
  open: "M3 6h6l2 2h10v11H3Z",
  save: "M12 3v12M7 10l5 5 5-5M4 17v4h16v-4",
  language:
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c-4 4-4 14 0 18M12 3c4 4 4 14 0 18",
  dot: "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
};

const DOT = "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0";

/**
 * The path of the icon for a contribution: its `icon`, else its name (the
 * part of its id after the slash), else a dot.
 */
export function iconPath(icon: string | undefined, id: string): string {
  const named = icon === undefined ? undefined : ICONS[icon];
  if (named !== undefined) return named;
  return ICONS[id.slice(id.indexOf("/") + 1)] ?? DOT;
}
