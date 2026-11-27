// SPDX-License-Identifier: GPL-3.0-or-later

// Every shape kind the shape extension lists has its stored pictures for the
// screenshot test (tests/e2e/shapes-visual.spec.ts), in each browser the
// pictures are kept for, and no picture is left of a kind that is gone. The
// screenshot test itself needs browsers and is not part of `pnpm check`; this
// makes a kind without pictures fail the check. See
// packages/extensions/shape/README.md, "Adding a kind".

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SHAPE_KINDS } from "@galatsa/extension-shape";
import { describe, expect, it } from "vitest";

const PICTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "tests",
  "e2e",
  "shapes-visual.spec.ts-snapshots",
);

/** The Playwright projects and platforms pictures are stored for. */
const STORED = ["chromium-linux", "editor-firefox-linux"];

describe("shape pictures", () => {
  it.each(SHAPE_KINDS.map((k) => k.kind))("%s has its pictures", (kind) => {
    for (const suffix of STORED)
      expect(
        existsSync(join(PICTURES, `${kind}-${suffix}.png`)),
        `${kind}-${suffix}.png`,
      ).toBe(true);
  });

  it("has no pictures of kinds that are not listed", () => {
    const kinds = new Set(SHAPE_KINDS.map((k) => k.kind));
    for (const file of readdirSync(PICTURES)) {
      const suffix = STORED.find((s) => file.endsWith(`-${s}.png`));
      expect(suffix, file).toBeDefined();
      expect(kinds.has(file.slice(0, -`-${suffix}.png`.length)), file).toBe(true);
    }
  });
});
