// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CORE_VERSION } from "@galatsa/core";
import { describe, expect, it } from "vitest";

describe("bench", () => {
  it("imports @galatsa/core from source in Vitest", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("imports @galatsa/core from source when Node runs it", () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--conditions=@galatsa/source", main], {
      encoding: "utf8",
    });
    expect(result.stderr).not.toMatch(/Error/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`@galatsa/core ${CORE_VERSION}`);
  });
});
