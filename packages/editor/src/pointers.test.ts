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

  it("ignores a second finger, unless the first lost its capture", () => {
    const t = new PointerTracker();
    const finger = (id: number): PointerFacts => ({
      id,
      type: "touch",
      button: 0,
      buttons: 1,
      x: 0,
      y: 0,
    });
    t.down(finger(7), false);
    expect(kinds(t.down(finger(8), true))).toEqual([]);
    expect(t.active).toBe(7);
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
