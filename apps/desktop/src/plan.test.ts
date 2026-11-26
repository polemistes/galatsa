// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  captureFileName,
  ENGINE_IDS,
  nextPlan,
  planFromQuery,
  planToQuery,
  resultFileName,
  sessionStamp,
} from "./plan.ts";

describe("plan", () => {
  it("survives the query string", () => {
    const plan = { session: "2026-11-26_18-30-00_linux", engines: ENGINE_IDS, index: 1 };
    expect(planFromQuery(planToQuery(plan))).toEqual(plan);
  });

  it("rejects malformed plans", () => {
    expect(planFromQuery("")).toBeNull();
    expect(planFromQuery("?session=a/b&engines=konva&index=0")).toBeNull();
    expect(planFromQuery("?session=s&engines=konva,webgl&index=0")).toBeNull();
    expect(planFromQuery("?session=s&engines=konva&index=1")).toBeNull();
    expect(planFromQuery("?session=s&engines=konva&index=-1")).toBeNull();
  });

  it("moves to the next engine and stops after the last", () => {
    const first = { session: "s", engines: ["konva", "dom"] as const, index: 0 };
    const second = nextPlan(first);
    expect(second?.index).toBe(1);
    expect(second && nextPlan(second)).toBeNull();
  });

  it("names folders and files with safe characters only", () => {
    expect(sessionStamp(new Date(2026, 10, 6, 9, 5, 3))).toBe("2026-11-06_09-05-03");
    expect(resultFileName("linux", "canvas2d", 2, "timing")).toBe(
      "linux-canvas2d-2-timing.json",
    );
    const name = captureFileName("macos", "konva", 0, "Hold: stop 3 (Æ)");
    expect(name).toBe("macos-konva-capture-01-hold-stop-3.png");
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
