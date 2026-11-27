// SPDX-License-Identifier: GPL-3.0-or-later

// The handles' geometry: boxes turned about their centre, which handle a
// point is on, the factor of a scaling, a resize from a side or a corner,
// angles and resize cursors. The tool itself is tested in the editor
// (packages/editor/src/selection.test.ts), with pointer events.

import { describe, expect, it } from "vitest";
import {
  CORNERS,
  SIDES,
  angleAbout,
  fromBox,
  handleAt,
  handlePoint,
  insideBox,
  normalizeAngle,
  resizeCursor,
  resizedBox,
  scaleFactor,
  snapAngle,
  toBox,
  union,
  type Box,
} from "./geometry.ts";

const QUARTER = Math.PI / 2;

describe("boxes", () => {
  it("maps points into a turned box and back", () => {
    const box: Box = { cx: 10, cy: 20, w: 40, h: 20, rot: QUARTER };
    // A quarter turn clockwise (y down): the box's own +x points down.
    const p = fromBox(box, { x: 20, y: 0 });
    expect(p.x).toBeCloseTo(10, 12);
    expect(p.y).toBeCloseTo(40, 12);
    const back = toBox(box, p);
    expect(back.x).toBeCloseTo(20, 12);
    expect(back.y).toBeCloseTo(0, 12);
    expect(insideBox(box, { x: 10, y: 39 })).toBe(true);
    expect(insideBox(box, { x: 25, y: 20 })).toBe(false);
  });

  it("finds the nearest handle within reach, the rotation handle above the box", () => {
    const box: Box = { cx: 50, cy: 50, w: 100, h: 100, rot: 0 };
    const all = [...CORNERS, ...SIDES, { kind: "rotate" as const }];
    expect(handleAt(box, all, { x: 103, y: 2 }, 5, 20)).toEqual(CORNERS[1]);
    expect(handleAt(box, all, { x: 50, y: -21 }, 5, 20)).toEqual({ kind: "rotate" });
    expect(handleAt(box, all, { x: 50, y: 50 }, 5, 20)).toBeNull();
    expect(handlePoint(box, SIDES[1]!, 20)).toEqual({ x: 100, y: 50 });
  });

  it("unites rectangles", () => {
    expect(union([])).toBeNull();
    expect(
      union([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: -5, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, w: 25, h: 15 });
  });
});

describe("dragging handles", () => {
  it("scales by the pointer projected on the diagonal, never below the minimum", () => {
    const anchor = { x: 0, y: 0 };
    const corner = { x: 100, y: 50 };
    expect(scaleFactor(anchor, corner, { x: 200, y: 100 }, 0.01)).toBeCloseTo(2, 12);
    // Off the diagonal: only the part along it counts.
    expect(scaleFactor(anchor, corner, { x: 150, y: 0 }, 0.01)).toBeCloseTo(1.2, 12);
    expect(scaleFactor(anchor, corner, { x: -50, y: -50 }, 0.01)).toBe(0.01);
  });

  it("resizes from a side or a corner, the opposite edges staying, or about the centre", () => {
    const box: Box = { cx: 50, cy: 50, w: 100, h: 100, rot: 0 };
    expect(resizedBox(box, 1, 0, { x: 150, y: 70 }, 1, false)).toEqual({
      cx: 75,
      cy: 50,
      w: 150,
      h: 100,
      rot: 0,
    });
    expect(resizedBox(box, -1, -1, { x: 20, y: 40 }, 1, false)).toEqual({
      cx: 60,
      cy: 70,
      w: 80,
      h: 60,
      rot: 0,
    });
    expect(resizedBox(box, 0, 1, { x: 50, y: 70 }, 1, true)).toMatchObject({
      cy: 50,
      h: 40,
    });
    // Past the opposite edge, the size stops at the minimum.
    expect(resizedBox(box, 1, 0, { x: -30, y: 50 }, 2, false).w).toBe(2);
  });

  it("resizes a turned box along its own axes", () => {
    const box: Box = { cx: 0, cy: 0, w: 100, h: 50, rot: QUARTER };
    // Its own +x points down; the pointer 30 further down widens it by 30.
    const next = resizedBox(box, 1, 0, { x: 0, y: 80 }, 1, false);
    expect(next.w).toBeCloseTo(130, 12);
    expect(next.h).toBe(50);
    expect(next.cx).toBeCloseTo(0, 12);
    expect(next.cy).toBeCloseTo(15, 12);
  });

  it("measures and rounds angles", () => {
    expect(angleAbout({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(QUARTER, 12);
    expect(snapAngle((40 * Math.PI) / 180, Math.PI / 12)).toBeCloseTo(Math.PI / 4, 12);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAngle(-1.5 * Math.PI)).toBeCloseTo(QUARTER, 12);
  });

  it("picks the resize cursor nearest a handle's direction on a turned box", () => {
    expect(resizeCursor({ u: 1, v: 0 }, 0)).toBe("ew-resize");
    expect(resizeCursor({ u: 1, v: 1 }, 0)).toBe("nwse-resize");
    expect(resizeCursor({ u: 1, v: -1 }, 0)).toBe("nesw-resize");
    expect(resizeCursor({ u: 0, v: 1 }, 0)).toBe("ns-resize");
    expect(resizeCursor({ u: 1, v: 0 }, QUARTER)).toBe("ns-resize");
    expect(resizeCursor({ u: 1, v: 0 }, Math.PI / 4)).toBe("nwse-resize");
  });
});
