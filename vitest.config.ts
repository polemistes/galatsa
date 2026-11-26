// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages from their source, see tsconfig.base.json.
    conditions: ["@galatsa/source"],
  },
  test: {
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.claude/**",
      "**/tests/e2e/**",
    ],
    environment: "node",
  },
});
