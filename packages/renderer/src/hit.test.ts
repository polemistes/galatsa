// SPDX-License-Identifier: GPL-3.0-or-later

// Hit testing and screen bounds.

import { FRAME_TYPE, GROUP_TYPE, type Element } from "@galatsa/core";
import { describe, expect, it } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import {
  box,
  ELLIPSE,
  RECT,
  RecordingContext,
  record,
  testHost,
} from "./test-support.ts";

function setup(elements: ReturnType<typeof record>, dpr = 1) {
  const { host } = testHost();
  const renderer = new CanvasRenderer({ host });
  renderer.attach(new RecordingContext(), {
    width: 400,
    height: 300,
    devicePixelRatio: dpr,
  });
  renderer.setScene(sceneFromSnapshot({ elements }));
  // World (0, 0) at the top-left corner of the view, zoom 1.
  renderer.setCamera({ space: null, cx: 200, cy: 150, zoom: 1 });
  return renderer;
}

describe("hitTest", () => {
  const elements = record([
    ["back", box(RECT, 0, 0, 200, 200)],
    ["front", box(RECT, 50, 50, 50, 50)],
    ["oval", box(ELLIPSE, 250, 0, 100, 100)],
    ["turned", box(RECT, 100, 220, 100, 20, { rot: Math.PI / 2 } as Partial<Element>)],
  ]);

  it("returns the topmost element", () => {
    const r = setup(elements);
    expect(r.hitTest(75, 75)).toBe("front");
    expect(r.hitTest(10, 10)).toBe("back");
    expect(r.hitTest(390, 290)).toBeNull();
  });

  it("is the same at another device pixel ratio", () => {
    const r = setup(elements, 2.5);
    expect(r.hitTest(75, 75)).toBe("front");
    expect(r.hitTest(10, 10)).toBe("back");
  });

  it("uses the type's own test: an ellipse is not hit in its corner", () => {
    const r = setup(elements);
    expect(r.hitTest(300, 50)).toBe("oval");
    expect(r.hitTest(253, 3)).toBeNull();
    expect(r.hitTest(253, 3, { tolerance: 30 })).toBe("oval");
  });

  it("follows rotation", () => {
    const r = setup(elements);
    // 100 x 20 at (100, 220), turned a quarter about its centre (150, 230): it
    // now spans x 140..160 and y 180..280.
    expect(r.hitTest(150, 270)).toBe("turned");
    expect(r.hitTest(110, 230)).toBeNull();
  });

  it("passes over elements that are not accepted", () => {
    const r = setup(elements);
    expect(r.hitTest(75, 75, { accept: (id) => id !== "front" })).toBe("back");
  });

  it("finds elements in frames and groups, and the frame itself on empty parts", () => {
    const r = setup(
      record([
        ["F", box(FRAME_TYPE, 100, 100, 100, 100, { data: { clip: true } })],
        [
          "G",
          box(GROUP_TYPE, 10, 10, 0, 0, {
            parent: "F",
            size: undefined,
          } as Partial<Element>),
        ],
        ["a", box(RECT, 0, 0, 20, 20, { parent: "G" })],
        ["hidden", box(RECT, 150, 0, 20, 20, { parent: "F" })],
      ]),
    );
    expect(r.hitTest(115, 115)).toBe("a");
    expect(r.hitTest(180, 180)).toBe("F");
    // Outside the clipping frame: not hit even though the element is there.
    expect(r.hitTest(255, 105)).toBeNull();
  });

  it("finds elements deep inside a far frame at high zoom", () => {
    const far = 2 ** 50;
    const { host } = testHost();
    const renderer = new CanvasRenderer({ host });
    renderer.attach(new RecordingContext(), {
      width: 400,
      height: 300,
      devicePixelRatio: 1,
    });
    renderer.setScene(
      sceneFromSnapshot({
        elements: record([
          ["F", box(FRAME_TYPE, far, far, 10, 10)],
          ["a", box(RECT, 1, 1, 1e-6, 1e-6, { parent: "F" })],
          ["b", box(RECT, 1 + 1e-6, 1, 1e-6, 1e-6, { parent: "F" })],
        ]),
      }),
    );
    // Zoom 1e8: each element is 100 pixels wide, side by side.
    renderer.setCamera({ space: "F", cx: 1 + 1e-6, cy: 1 + 0.5e-6, zoom: 1e8 });
    expect(renderer.hitTest(150, 150)).toBe("a");
    expect(renderer.hitTest(250, 150)).toBe("b");
  });
});

describe("screenBounds", () => {
  it("gives the rotated corners in CSS pixels", () => {
    const r = setup(
      record([
        ["t", box(RECT, 100, 100, 100, 20, { rot: Math.PI / 2 } as Partial<Element>)],
      ]),
      2,
    );
    const b = r.screenBounds("t")!;
    expect(b.x).toBeCloseTo(140, 9);
    expect(b.y).toBeCloseTo(60, 9);
    expect(b.w).toBeCloseTo(20, 9);
    expect(b.h).toBeCloseTo(100, 9);
    expect(b.rotation).toBeCloseTo(Math.PI / 2, 12);
    // The box's top-left corner went to the top-right.
    expect(b.corners[0].x).toBeCloseTo(160, 9);
    expect(b.corners[0].y).toBeCloseTo(60, 9);
  });

  it("follows the camera and gives groups their members' bounds", () => {
    const r = setup(
      record([
        ["G", box(GROUP_TYPE, 10, 10, 0, 0, { size: undefined } as Partial<Element>)],
        ["a", box(RECT, 0, 0, 20, 20, { parent: "G" })],
        ["b", box(RECT, 40, 30, 20, 20, { parent: "G" })],
      ]),
    );
    r.setCamera({ space: null, cx: 200, cy: 150, zoom: 2 });
    const b = r.screenBounds("G")!;
    // World (10, 10)..(70, 60) around centre (200, 150) at zoom 2.
    expect(b).toMatchObject({ x: 200 - 380, y: 150 - 280, w: 120, h: 100 });
    expect(r.screenBounds("nothing")).toBeNull();
  });
});

describe("elementsInRect", () => {
  it("finds what a rubber band touches or encloses", () => {
    const r = setup(
      record([
        ["a", box(RECT, 0, 0, 20, 20)],
        ["b", box(RECT, 50, 0, 20, 20)],
      ]),
    );
    expect(r.elementsInRect({ x: 10, y: 10, w: 50, h: 5 })).toEqual(["a", "b"]);
    expect(r.elementsInRect({ x: -1, y: -1, w: 60, h: 30 }, { inside: true })).toEqual([
      "a",
    ]);
  });
});
