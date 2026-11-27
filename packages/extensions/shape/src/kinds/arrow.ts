// SPDX-License-Identifier: GPL-3.0-or-later

// Arrow: a line drawn from point to point, as the line kind is, with an
// arrowhead at the end, at the start, at both or at neither. The shaft is
// stroked with flat ends that meet the heads, so that it never shows through
// a tip, even half transparent; an end without a head gets a round end as a
// mark instead, so that it looks like the line's.

import { defineShapeKind, shapeLabel, type ShapeParam } from "../kind.ts";

const START_HEAD: ShapeParam = {
  type: "choice",
  key: "startHead",
  label: shapeLabel("param.startHead"),
  options: [
    { value: "none", label: shapeLabel("param.startHead.none") },
    { value: "arrow", label: shapeLabel("param.startHead.arrow") },
  ],
  default: "none",
};

const END_HEAD: ShapeParam = {
  type: "choice",
  key: "endHead",
  label: shapeLabel("param.endHead"),
  options: [
    { value: "none", label: shapeLabel("param.endHead.none") },
    { value: "arrow", label: shapeLabel("param.endHead.arrow") },
  ],
  default: "arrow",
};

/**
 * The size of the heads: a head is this many times the outline width plus
 * HEAD_BASE world units long, so that a thin arrow's heads are still seen.
 */
const HEAD_SIZE: ShapeParam = {
  type: "number",
  key: "headSize",
  label: shapeLabel("param.headSize"),
  min: 1,
  max: 6,
  step: 0.5,
  default: 3,
};

/** World units added to the outline width for a head's length (see HEAD_SIZE). */
const HEAD_BASE = 3;
/** A head's half width, as a fraction of its length. */
const HEAD_SPREAD = 0.5;

export const arrow = defineShapeKind({
  kind: "arrow",
  label: shapeLabel("kind.arrow"),
  shortcut: "a",
  closed: false,
  drawing: "line",
  cap: "butt",
  params: [START_HEAD, END_HEAD, HEAD_SIZE],
  outline({ body, marks }, { w, h, strokeWidth, params }) {
    const y = h / 2;
    const start = params["startHead"] === "arrow";
    const end = params["endHead"] === "arrow";
    const heads = (start ? 1 : 0) + (end ? 1 : 0);
    // Heads share the length when the arrow is too short for them.
    const size = (params["headSize"] as number) * (strokeWidth + HEAD_BASE);
    const length = heads === 0 ? 0 : Math.max(0, Math.min(size, w / heads));
    const spread = length * HEAD_SPREAD;
    body.moveTo(start ? length : 0, y);
    body.lineTo(end ? w - length : w, y);
    const radius = strokeWidth / 2;
    if (start) {
      marks.moveTo(0, y);
      marks.lineTo(length, y + spread);
      marks.lineTo(length, y - spread);
      marks.closePath();
    } else if (radius > 0) {
      marks.moveTo(0, y + radius);
      marks.arc(0, y, radius, Math.PI / 2, (3 * Math.PI) / 2);
      marks.closePath();
    }
    if (end) {
      marks.moveTo(w, y);
      marks.lineTo(w - length, y - spread);
      marks.lineTo(w - length, y + spread);
      marks.closePath();
    } else if (radius > 0) {
      marks.moveTo(w, y - radius);
      marks.arc(w, y, radius, -Math.PI / 2, Math.PI / 2);
      marks.closePath();
    }
  },
});
