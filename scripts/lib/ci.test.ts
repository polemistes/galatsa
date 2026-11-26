// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ciReason, isOn, releaseAgeOverrides } from "./ci.ts";

describe("CI detection", () => {
  it("takes CI=true, and ignores CI that is empty, 0 or false", () => {
    expect(ciReason({ CI: "true" })).toMatch(/CI environment variable/);
    expect(ciReason({ CI: "1" })).toBeDefined();
    expect(ciReason({ CI: "false" })).toBeUndefined();
    expect(ciReason({ CI: "0" })).toBeUndefined();
    expect(ciReason({ CI: "" })).toBeUndefined();
    expect(ciReason({})).toBeUndefined();
  });

  it("counts GitHub Actions as CI whatever CI says", () => {
    expect(ciReason({ GITHUB_ACTIONS: "true", CI: "false" })).toMatch(/GITHUB_ACTIONS/);
    expect(ciReason({ GITHUB_ACTIONS: "true", CI: "" })).toMatch(/GITHUB_ACTIONS/);
    expect(ciReason({ GITHUB_ACTIONS: "true" })).toMatch(/GITHUB_ACTIONS/);
    expect(ciReason({ GITLAB_CI: "true", CI: "0" })).toMatch(/GITLAB_CI/);
    expect(ciReason({ GITHUB_ACTIONS: "" })).toBeUndefined();
  });

  it("reads switches", () => {
    expect(isOn("1")).toBe(true);
    expect(isOn("yes")).toBe(true);
    expect(isOn("false")).toBe(false);
    expect(isOn(undefined)).toBe(false);
  });

  it("finds pnpm's release-age variables in any spelling", () => {
    expect(
      releaseAgeOverrides({
        pnpm_config_minimum_release_age: "0",
        PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0",
        PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: "x",
        Pnpm_Config_MinimumReleaseAge: "0",
        "pnpm_config_minimum-release-age": "0",
        PNPM_CONFIG_REGISTRY: "x",
        PATH: "/usr/bin",
      }),
    ).toEqual([
      "PNPM_CONFIG_MINIMUM_RELEASE_AGE",
      "PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE",
      "Pnpm_Config_MinimumReleaseAge",
      "pnpm_config_minimum-release-age",
      "pnpm_config_minimum_release_age",
    ]);
  });
});
