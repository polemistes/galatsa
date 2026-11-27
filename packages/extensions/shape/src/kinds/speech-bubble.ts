// SPDX-License-Identifier: GPL-3.0-or-later

// Speech bubble: the box, with rounded corners when asked for, and a tail to a
// tip that is usually outside the box. The tail comes out of the edge the tip
// is furthest beyond, from a base on the straight part of that edge that sits
// halfway between the edge's middle and the tip, so that it leans towards the
// tip. Box and tail are one outline, so the fill and the outline have no seam.
// A tip inside the box gives no tail.

import { defineShapeKind, shapeLabel, type ShapeParam } from "../kind.ts";

/** The tail's tip across the box, as a fraction of the width (beyond 0 to 1 is outside). */
const TAIL_X: ShapeParam = {
  type: "number",
  key: "tailX",
  label: shapeLabel("param.tailX"),
  min: -1,
  max: 2,
  step: 0.05,
  default: 0.2,
};

/** The tail's tip down the box, as a fraction of the height (beyond 0 to 1 is outside). */
const TAIL_Y: ShapeParam = {
  type: "number",
  key: "tailY",
  label: shapeLabel("param.tailY"),
  min: -1,
  max: 2,
  step: 0.05,
  default: 1.35,
};

/** The tail's base, as a fraction of the box's shorter side (less where the edge is short). */
const TAIL_BASE = 0.25;

type Edge = "top" | "right" | "bottom" | "left";

export const speechBubble = defineShapeKind({
  kind: "speech-bubble",
  label: shapeLabel("kind.speech-bubble"),
  shortcut: "b",
  closed: true,
  corners: true,
  params: [TAIL_X, TAIL_Y],
  outline({ body }, { w, h, cornerRadius, params }) {
    const tx = (params["tailX"] as number) * w;
    const ty = (params["tailY"] as number) * h;
    // The edge the tip is furthest beyond, if it is outside the box.
    let edge: Edge | null = null;
    let beyond = 0;
    for (const [side, by] of [
      ["bottom", ty - h],
      ["top", -ty],
      ["left", -tx],
      ["right", tx - w],
    ] as const)
      if (by > beyond) {
        edge = side;
        beyond = by;
      }
    // The corners are made less round where they would leave the tail's
    // edge no straight part for its base.
    const wanted = TAIL_BASE * Math.min(w, h);
    const edgeLength = edge === "top" || edge === "bottom" ? w : h;
    const r =
      edge === null
        ? cornerRadius
        : Math.min(cornerRadius, Math.max(0, (edgeLength - wanted) / 2));
    const base = Math.max(0, Math.min(wanted, edgeLength - 2 * r));
    // The tail's base on its edge, as two positions along it (from the
    // edge's start, in the outline's direction of travel).
    const tail = (side: Edge, length: number, tip: number): void => {
      if (side !== edge) return;
      const middle = length / 2;
      const centre = Math.min(
        length - r - base / 2,
        Math.max(r + base / 2, middle + (tip - middle) / 2),
      );
      const a = centre - base / 2;
      const b = centre + base / 2;
      switch (side) {
        case "top":
          body.lineTo(a, 0);
          body.lineTo(tx, ty);
          body.lineTo(b, 0);
          return;
        case "right":
          body.lineTo(w, a);
          body.lineTo(tx, ty);
          body.lineTo(w, b);
          return;
        case "bottom":
          body.lineTo(w - a, h);
          body.lineTo(tx, ty);
          body.lineTo(w - b, h);
          return;
        case "left":
          body.lineTo(0, h - a);
          body.lineTo(tx, ty);
          body.lineTo(0, h - b);
          return;
      }
    };
    const corner = (cx: number, cy: number, from: number): void => {
      if (r > 0) body.arc(cx, cy, r, from, from + Math.PI / 2);
      else body.lineTo(cx, cy);
    };
    // Clockwise from the top left corner: each edge, then the corner after it.
    body.moveTo(r, 0);
    tail("top", w, tx);
    body.lineTo(w - r, 0);
    corner(w - r, r, -Math.PI / 2);
    tail("right", h, ty);
    body.lineTo(w, h - r);
    corner(w - r, h - r, 0);
    tail("bottom", w, w - tx);
    body.lineTo(r, h);
    corner(r, h - r, Math.PI / 2);
    tail("left", h, h - ty);
    body.lineTo(0, r);
    corner(r, r, Math.PI);
    body.closePath();
  },
});
