// SPDX-License-Identifier: GPL-3.0-or-later

// The speed profile of a flight: a smooth start, a steady middle and a smooth
// stop, with the same shape at both ends.

import { describe, expect, it } from "vitest";
import { RAMP, smoothProgress, smoothSpeed } from "./easing.ts";

describe("smooth progress", () => {
  it("starts at 0 and ends at 1, and stays there outside [0, 1]", () => {
    expect(smoothProgress(0)).toBe(0);
    expect(smoothProgress(1)).toBe(1);
    expect(smoothProgress(-1)).toBe(0);
    expect(smoothProgress(2)).toBe(1);
    expect(smoothProgress(Number.NaN)).toBe(0);
    expect(smoothProgress(0.5)).toBeCloseTo(0.5, 15);
  });

  it("is symmetric: the stop mirrors the start", () => {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      expect(smoothProgress(p) + smoothProgress(1 - p)).toBeCloseTo(1, 14);
      expect(smoothSpeed(p)).toBeCloseTo(smoothSpeed(1 - p), 12);
    }
  });

  it("has known values", () => {
    // A quarter of the time to speed up along a raised cosine, half at a steady
    // speed of 1 / (1 - 0.25) = 4/3, a quarter to slow down.
    expect(RAMP).toBe(0.25);
    expect(smoothSpeed(0)).toBe(0);
    expect(smoothSpeed(1)).toBe(0);
    expect(smoothSpeed(0.125)).toBeCloseTo(2 / 3, 14);
    expect(smoothSpeed(0.25)).toBeCloseTo(4 / 3, 14);
    expect(smoothSpeed(0.5)).toBeCloseTo(4 / 3, 14);
    // Distance after the ramp: half the ramp at peak speed, (0.25 / 2) * 4/3.
    expect(smoothProgress(0.25)).toBeCloseTo(1 / 6, 14);
    // In the steady part, distance grows at 4/3.
    expect(smoothProgress(0.4)).toBeCloseTo(1 / 6 + 0.15 * (4 / 3), 14);
    // Inside the ramp: (4/3) * (p / 2 - (0.25 / (2 pi)) sin(pi p / 0.25)).
    const p = 0.1;
    const expected =
      (4 / 3) * (p / 2 - (0.25 / (2 * Math.PI)) * Math.sin((Math.PI * p) / 0.25));
    expect(smoothProgress(p)).toBeCloseTo(expected, 14);
  });

  it("is the integral of the speed, and never goes back", () => {
    const n = 20_000;
    let sum = 0;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const mid = (i + 0.5) / n;
      sum += smoothSpeed(mid) / n;
      const next = smoothProgress((i + 1) / n);
      expect(next).toBeGreaterThanOrEqual(last);
      expect(Math.abs(next - sum)).toBeLessThan(1e-8);
      last = next;
      expect(smoothSpeed(mid)).toBeLessThanOrEqual(4 / 3 + 1e-12);
    }
  });

  it("takes other ramp lengths", () => {
    // A ramp of half the time has no steady part: the speed is a raised cosine
    // over the whole time, 1 - cos(2 pi p), and the distance p - sin(2 pi p) / (2 pi).
    for (const p of [0.1, 0.3, 0.5, 0.8]) {
      expect(smoothProgress(p, 0.5)).toBeCloseTo(
        p - Math.sin(2 * Math.PI * p) / (2 * Math.PI),
        14,
      );
      expect(smoothSpeed(p, 0.5)).toBeCloseTo(1 - Math.cos(2 * Math.PI * p), 14);
    }
    // No ramp is constant speed.
    expect(smoothProgress(0.3, 0)).toBeCloseTo(0.3, 15);
    expect(smoothSpeed(0.3, 0)).toBe(1);
  });
});
