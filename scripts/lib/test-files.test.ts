// SPDX-License-Identifier: GPL-3.0-or-later

// Keeps the test file pattern used by Vitest and the one that keeps tests out of
// dist/ in sync.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TEST_FILE_EXTENSIONS } from "../../vite.shared.ts";

describe("test file patterns", () => {
  it("tsconfig.build.base.json excludes every test file that Vitest runs", () => {
    const path = fileURLToPath(
      new URL("../../tsconfig.build.base.json", import.meta.url),
    );
    const { config, error } = ts.parseConfigFileTextToJson(
      path,
      readFileSync(path, "utf8"),
    );
    expect(error).toBeUndefined();
    const exclude = (config as { exclude: string[] }).exclude;
    for (const extension of TEST_FILE_EXTENSIONS) {
      expect(exclude).toContain(`**/*.test.${extension}`);
    }
  });
});
