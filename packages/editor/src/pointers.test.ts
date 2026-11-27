// SPDX-License-Identifier: GPL-3.0-or-later

// Which pointer the canvas follows: the right button is not the tool's, and a
// pointer whose pointerup never came does not lock the canvas.

import { describe, expect, it } from "vitest";
import { PointerTracker, type PointerFacts } from "./pointers.ts";

function mouse(button: number, buttons: number, x = 0, y = 0): PointerFacts {
  return { id: 1, type: "mouse", button, buttons, x, y };
}

const kinds = (actions: readonly { kind: string }[]) => actions.map((a) => a.kind);

describe("PointerTracker", () => {
  it("does not give the right button to the tool", () => {
    const t = new PointerTracker();
    expect(kinds(t.down(mouse(2, 2), false))).toEqual([]);
    expect(t.active).toBeNull();
    // The context menu took the release: no pointerup ever comes. The next
    // left press works.
    expect(kinds(t.down(mouse(0, 1), false))).toEqual(["capture", "tool-down"]);
  });

  it("drops a press whose pointerup never came when the same pointer goes down again", () => {
    const t = new PointerTracker();
    t.down(mouse(0, 1), false);
    expect(kinds(t.down(mouse(0, 1), true))).toEqual([
      "tool-cancel",
      "capture",
      "tool-down",
    ]);
  });

  it("drops a press that moves with no button down", () => {
    const t = new PointerTracker();
    t.down(mouse(0, 1), false);
    expect(kinds(t.move(mouse(-1, 1, 5, 5)))).toEqual(["tool-move"]);
    expect(kinds(t.move(mouse(-1, 0, 6, 6)))).toEqual(["release", "tool-cancel"]);
    expect(t.active).toBeNull();
    expect(kinds(t.move(mouse(-1, 0, 7, 7)))).toEqual(["hover"]);
  });

  it("turns a second finger into a pinch of the canvas, and cancels the tool's drag", () => {
    const t = new PointerTracker();
    const finger = (id: number, x: number, y: number, buttons = 1): PointerFacts => ({
      id,
      type: "touch",
      button: 0,
      buttons,
      x,
      y,
    });
    expect(kinds(t.down(finger(7, 100, 100), false))).toEqual(["capture", "tool-down"]);
    expect(kinds(t.move(finger(7, 110, 100)))).toEqual(["tool-move"]);
    // The second finger: the tool's drag is cancelled, the two fingers hold the canvas.
    expect(kinds(t.down(finger(8, 210, 100), true))).toEqual(["tool-cancel", "capture"]);
    expect(t.pinching).toBe(true);
    // Spreading the fingers zooms about the point between them; moving both pans.
    expect(t.move(finger(8, 310, 100))).toEqual([
      { kind: "pinch", from: { x: 160, y: 100 }, to: { x: 210, y: 100 }, factor: 2 },
    ]);
    expect(t.move(finger(7, 110, 120))).toEqual([
      {
        kind: "pinch",
        from: { x: 210, y: 100 },
        to: { x: 210, y: 110 },
        factor: Math.hypot(200, 20) / 200,
      },
    ]);
    // A third finger is ignored.
    expect(t.down(finger(9, 0, 0), true)).toEqual([]);
    expect(t.move(finger(9, 5, 5))).toEqual([]);
    // One finger up: the other drags the canvas until it is lifted too.
    expect(kinds(t.up(finger(8, 310, 100, 0)))).toEqual(["release"]);
    expect(t.pinching).toBe(false);
    expect(t.move(finger(7, 115, 125))).toEqual([{ kind: "pan", dx: 5, dy: 5 }]);
    expect(kinds(t.up(finger(7, 115, 125, 0)))).toEqual(["release"]);
    expect(t.active).toBeNull();
    // The next touch is the tool's again.
    expect(kinds(t.down(finger(10, 0, 0), false))).toEqual(["capture", "tool-down"]);
  });

  it("ends a pinch when its pointers are cancelled", () => {
    const t = new PointerTracker();
    const finger = (id: number, x: number): PointerFacts => ({
      id,
      type: "touch",
      button: 0,
      buttons: 1,
      x,
      y: 0,
    });
    t.down(finger(1, 0), false);
    t.down(finger(2, 100), true);
    expect(t.cancel({ id: 1 })).toEqual([]);
    expect(t.cancel({ id: 2 })).toEqual([]);
    expect(t.active).toBeNull();
    expect(t.pinching).toBe(false);
  });

  it("ignores a finger while a pen draws, unless the pen lost its capture", () => {
    const t = new PointerTracker();
    const pen: PointerFacts = { id: 3, type: "pen", button: 0, buttons: 1, x: 0, y: 0 };
    const finger = (id: number): PointerFacts => ({
      id,
      type: "touch",
      button: 0,
      buttons: 1,
      x: 0,
      y: 0,
    });
    t.down(pen, false);
    expect(kinds(t.down(finger(8), true))).toEqual([]);
    expect(t.active).toBe(3);
    expect(kinds(t.down(finger(9), false))).toEqual([
      "release",
      "tool-cancel",
      "capture",
      "tool-down",
    ]);
    expect(t.active).toBe(9);
  });

  it("drags the canvas with the middle button, and ends a press with its pointerup", () => {
    const t = new PointerTracker();
    expect(kinds(t.down(mouse(1, 4, 10, 10), false))).toEqual(["capture"]);
    expect(t.move(mouse(-1, 4, 15, 12))).toEqual([{ kind: "pan", dx: 5, dy: 2 }]);
    expect(kinds(t.up(mouse(1, 0)))).toEqual(["release"]);
    t.down(mouse(0, 1), false);
    expect(kinds(t.up(mouse(0, 0)))).toEqual(["release", "tool-up"]);
    expect(t.active).toBeNull();
  });
});
