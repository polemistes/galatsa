// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  checkSettings,
  evaluateAges,
  isRetryableStatus,
  MINIMUM_AGE_MINUTES,
  packumentUrl,
  publishTimeOf,
  retryDelayMs,
  splitPackageId,
  type ReleaseAgeException,
} from "./release-age.ts";
import { RELEASE_AGE_EXCEPTIONS } from "./release-age-exceptions.ts";

const now = new Date("2026-11-26T12:00:00Z");

describe("package ids and registry metadata", () => {
  it("splits ids and builds registry URLs", () => {
    expect(splitPackageId("yaml@2.9.1")).toEqual({ name: "yaml", version: "2.9.1" });
    expect(splitPackageId("@types/node@26.6.6")).toEqual({
      name: "@types/node",
      version: "26.6.6",
    });
    expect(() => splitPackageId("yaml")).toThrow();
    expect(packumentUrl("@types/node")).toBe("https://registry.npmjs.org/@types%2Fnode");
  });

  it("reads publish times, and nothing else", () => {
    const packument = { time: { "1.0.0": "2026-01-01T00:00:00.000Z", "2.0.0": "x" } };
    expect(publishTimeOf(packument, "1.0.0")).toBe("2026-01-01T00:00:00.000Z");
    expect(publishTimeOf(packument, "2.0.0")).toBeUndefined();
    expect(publishTimeOf(packument, "3.0.0")).toBeUndefined();
    expect(publishTimeOf({}, "1.0.0")).toBeUndefined();
    expect(publishTimeOf(null, "1.0.0")).toBeUndefined();
  });
});

describe("evaluateAges", () => {
  const ids = new Set(["old@1.0.0", "edge@1.0.0", "young@1.0.0", "excepted@1.0.0"]);
  const times = new Map([
    ["old@1.0.0", "2026-01-01T00:00:00Z"],
    ["edge@1.0.0", "2026-11-12T12:00:00Z"], // exactly 14 days
    ["young@1.0.0", "2026-11-24T00:00:00Z"],
    ["excepted@1.0.0", "2026-11-25T00:00:00Z"],
  ]);
  const exceptions: ReleaseAgeException[] = [
    { name: "excepted", version: "1.0.0", reason: "Security fix." },
  ];

  it("fails versions younger than 14 days, unless excepted", () => {
    const result = evaluateAges(ids, times, now, exceptions);
    expect(result.young).toEqual([
      { id: "young@1.0.0", published: "2026-11-24T00:00:00Z", ageDays: 2 },
    ]);
    expect(result.excepted.map((entry) => entry.id)).toEqual(["excepted@1.0.0"]);
    expect(result.problems).toEqual([]);
    expect(result.removable).toEqual([]);
  });

  it("reports exceptions without a reason, unused ones and old enough ones", () => {
    const result = evaluateAges(ids, times, now, [
      { name: "excepted", version: "1.0.0", reason: " " },
      { name: "gone", version: "1.0.0", reason: "x" },
      { name: "old", version: "1.0.0", reason: "x" },
    ]);
    expect(result.problems).toEqual([
      "The release-age exception for excepted@1.0.0 has no reason.",
      "The release-age exception for gone@1.0.0 is not in pnpm-lock.yaml any more. Remove it.",
    ]);
    expect(result.removable).toEqual(["old@1.0.0"]);
  });

  it("has a reason for every listed project exception", () => {
    for (const exception of RELEASE_AGE_EXCEPTIONS) {
      expect(exception.reason.trim()).not.toBe("");
    }
  });
});

describe("checkSettings", () => {
  const exceptions: ReleaseAgeException[] = [
    { name: "@types/react", version: "19.3.1", reason: "x" },
    { name: "@types/react", version: "19.3.2", reason: "x" },
  ];

  it("requires minimumReleaseAge of at least 14 days and strict mode", () => {
    expect(checkSettings({ minimumReleaseAge: MINIMUM_AGE_MINUTES }, [])).toEqual([]);
    expect(checkSettings({}, [])[0]).toContain("minimumReleaseAge is undefined");
    expect(checkSettings({ minimumReleaseAge: 1440 }, [])[0]).toContain(
      "minimumReleaseAge is 1440, must be at least 20160",
    );
    expect(
      checkSettings(
        { minimumReleaseAge: MINIMUM_AGE_MINUTES, minimumReleaseAgeStrict: false },
        [],
      )[0],
    ).toContain("minimumReleaseAgeStrict is false");
  });

  it("accepts exclude entries only for listed exact versions", () => {
    const settings = (entries: unknown) => ({
      minimumReleaseAge: MINIMUM_AGE_MINUTES,
      minimumReleaseAgeExclude: entries,
    });
    expect(
      checkSettings(
        settings(["@types/react@19.3.1", "@types/react@19.3.1 || 19.3.2"]),
        exceptions,
      ),
    ).toEqual([]);
    const problems = checkSettings(
      settings([
        "@types/react@19.3.3", // pnpm added this one by itself
        "@types/react",
        "@types/*",
        "@types/react@^19.0.0",
        "@types/react@19.3.1 || 19.3.3",
      ]),
      exceptions,
    );
    expect(problems).toHaveLength(5);
    expect(problems[0]).toBe(
      'pnpm-workspace.yaml: minimumReleaseAgeExclude has "@types/react@19.3.3", which is not a listed exception. pnpm may add such entries by itself. Remove it, or add each exact version with a reason to scripts/lib/release-age-exceptions.ts.',
    );
    expect(checkSettings(settings("x"), exceptions)).toEqual([
      "pnpm-workspace.yaml: minimumReleaseAgeExclude must be a list.",
    ]);
  });
});

describe("retries", () => {
  it("retries rate limits and server errors only", () => {
    expect([408, 429, 500, 502, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 410].some(isRetryableStatus)).toBe(false);
  });

  it("backs off exponentially with jitter, and honours Retry-After", () => {
    const none = (): number => 0;
    const most = (): number => 1;
    expect(retryDelayMs(1, null, 0, none)).toBe(1000);
    expect(retryDelayMs(2, null, 0, none)).toBe(2000);
    expect(retryDelayMs(3, null, 0, most)).toBe(5000);
    expect(retryDelayMs(1, "7", 0, none)).toBe(7000);
    expect(retryDelayMs(1, "Thu, 01 Jan 1970 00:00:12 GMT", 2000, none)).toBe(10_000);
    expect(retryDelayMs(1, "3600", 0, none)).toBe(30_000); // capped
    expect(retryDelayMs(10, null, 0, none)).toBe(30_000);
    expect(retryDelayMs(1, "soon", 0, none)).toBe(1000); // unreadable header
  });
});
