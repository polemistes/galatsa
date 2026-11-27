// SPDX-License-Identifier: GPL-3.0-or-later

// The shape kinds the shape extension offers, in the order of its menus and
// toolbar. A new kind is one file in this folder, listed here (README.md).

import type { ShapeKind } from "../kind.ts";
import { arrow } from "./arrow.ts";
import { bracket } from "./bracket.ts";
import { ellipse } from "./ellipse.ts";
import { line } from "./line.ts";
import { rect } from "./rect.ts";
import { triangle } from "./triangle.ts";

export const SHAPE_KINDS: readonly ShapeKind[] = [
  rect,
  ellipse,
  triangle,
  line,
  arrow,
  bracket,
];
