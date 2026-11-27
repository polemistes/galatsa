// SPDX-License-Identifier: GPL-3.0-or-later

// Screen questions on gone and tiny elements, region rendering, and updates
// from changed ids when a container's record is removed.

import { FRAME_TYPE, GROUP_TYPE, type Element, type ElementId } from "@galatsa/core";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasRenderer } from "./renderer.ts";
import { sceneFromSnapshot } from "./scene.ts";
import { box, RECT, RecordingContext, record, testHost } from "./test-support.ts";

const VIEW = { width: 800, height: 600, devicePixelRatio: 1 };

function setup(elements: ReturnType<typeof record>) {
  const { host, drawn } = testHost();
  const renderer = new CanvasRenderer({ host, background: "#fff" });
  renderer.attach(new RecordingContext(), VIEW);
  renderer.setScene(sceneFromSnapshot({ elements }));
  return { renderer, drawn };
}

describe("gone and tiny elements", () => {
  it("elementsInRect gives the members of a dissolved group, never the group", () => {
    const { renderer } = setup(
      record([
        [
          "g",
          box(GROUP_TYPE, 0, 0, 0, 0, {
            dissolved: true,
            size: undefined,
          } as Partial<Element>),
        ],
        ["a", box(RECT, 10, 10, 10, 10, { parent: "g" })],
        ["b", box(RECT, 30, 10, 10, 10, { parent: "g" })],
        ["c", box(RECT, 60, 10, 10, 10)],
      ]),
    );
    renderer.setCamera({ space: null, cx: 400, cy: 300, zoom: 1 });
    expect(renderer.elementsInRect({ x: 0, y: 0, w: 800, h: 600 })).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      renderer.elementsInRect({ x: 5, y: 5, w: 40, h: 20 }, { inside: true }),
    ).toEqual(["a", "b"]);
  });

  it("hitTest passes over deleted elements and dissolved groups", () => {
    const { renderer } = setup(
      record([
        ["back", box(RECT, 0, 0, 100, 100)],
        [
          "deleted",
          box(RECT, 0, 0, 100, 100, { deleted: { x: { seen: { deleted: "" } } } }),
        ],
        [
          "g",
          box(GROUP_TYPE, 0, 0, 0, 0, {
            dissolved: true,
            size: undefined,
          } as Partial<Element>),
        ],
        ["inside", box(RECT, 50, 50, 10, 10, { parent: "g" })],
      ]),
    );
    renderer.setCamera({ space: null, cx: 400, cy: 300, zoom: 1 });
    expect(renderer.hitTest(10, 10)).toBe("back");
    expect(renderer.hitTest(55, 55)).toBe("inside");
  });

  it("hitTest does not return an element too small to be drawn", () => {
    const { renderer } = setup(
      record([
        ["big", box(RECT, 0, 0, 100, 100)],
        ["dust", box(RECT, 50, 50, 0.001, 0.001)],
      ]),
    );
    renderer.setCamera({ space: null, cx: 50, cy: 50, zoom: 1 });
    // Tolerance 4 CSS pixels, as an editor would use.
    expect(renderer.hitTest(400, 300, { tolerance: 4 })).toBe("big");
    // Zoomed in, the same element is drawn and hit.
    renderer.setCamera({ space: null, cx: 50.0005, cy: 50.0005, zoom: 100000 });
    expect(renderer.hitTest(400, 300)).toBe("dust");
  });
});

describe("updates from changed ids", () => {
  it("keeps the children of a container whose record was removed", () => {
    const before = record([
      ["P", box(FRAME_TYPE, 0, 0, 500, 500)],
      ["F", box(FRAME_TYPE, 10, 10, 100, 100, { parent: "P" })],
      ["r", box(RECT, 5, 5, 10, 10, { parent: "F" })],
    ]);
    const { renderer, drawn } = setup(before);
    renderer.setCamera({ space: null, cx: 400, cy: 300, zoom: 1 });
    const after = { ...before };
    delete after["F" as ElementId];
    // Only F is reported; r now resolves to the root.
    renderer.applyChanges(["F" as ElementId], sceneFromSnapshot({ elements: after }));
    renderer.render();
    expect(drawn).toContain("r");
  });
});

describe("renderRegion", () => {
  const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  afterEach(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
  });

  /** A stand-in OffscreenCanvas over the recording context. */
  function fakeOffscreen(): RecordingContext[] {
    const made: RecordingContext[] = [];
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
      getContext() {
        const ctx = new RecordingContext();
        made.push(ctx);
        return ctx;
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["image"]));
      }
    };
    return made;
  }

  it("draws the region on its own canvas and keeps the counters of the frames on screen", async () => {
    const made = fakeOffscreen();
    const { renderer, drawn } = setup(
      record([
        ["a", box(RECT, 0, 0, 10, 10)],
        ["b", box(RECT, 1000, 0, 10, 10)],
      ]),
    );
    renderer.setCamera({ space: null, cx: 5, cy: 5, zoom: 1 });
    renderer.render();
    const before = { ...renderer.stats };
    drawn.length = 0;
    const bytes = await renderer.renderRegion(
      { space: null, rect: { x: 990, y: -10, w: 30, h: 30 } },
      { width: 300, height: 300, mediaType: "image/png" },
    );
    expect(new TextDecoder().decode(bytes)).toBe("image");
    expect(drawn).toEqual(["b"]);
    expect(made.length).toBeGreaterThan(0);
    expect(renderer.stats).toEqual(before);
  });

  it("refuses an empty region or image", async () => {
    fakeOffscreen();
    const { renderer } = setup(record([["a", box(RECT, 0, 0, 10, 10)]]));
    const image = { width: 100, height: 100, mediaType: "image/png" } as const;
    await expect(
      renderer.renderRegion({ space: null, rect: { x: 0, y: 0, w: 0, h: 10 } }, image),
    ).rejects.toThrow(RangeError);
    await expect(
      renderer.renderRegion(
        { space: null, rect: { x: 0, y: 0, w: 10, h: 10 } },
        { ...image, width: 0 },
      ),
    ).rejects.toThrow(RangeError);
  });
});
