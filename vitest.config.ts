// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";
import { workspaceSourceResolve } from "./vite.shared.ts";

export default defineConfig({
  ...workspaceSourceResolve,
  test: {
    // Every test file in the repository, in any folder, except installed and
    // generated files. Playwright's end-to-end tests (tests/e2e, *.spec.ts) run
    // separately with `pnpm e2e`.
    include: ["**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/coverage/**",
      "**/target/**",
      "**/.claude/**",
      "tests/e2e/**",
    ],
    environment: "node",
  },
});
