// SPDX-License-Identifier: GPL-3.0-or-later

// Vite settings shared by vitest.config.ts and, later, the vite.config.ts of each app
// and browser package. Spread it into the config:
//
//   export default defineConfig({ ...workspaceSourceResolve, plugins: [...] });
//
// It adds the "@galatsa/source" export condition (see tsconfig.base.json), so Vite and
// Vitest load other workspace packages from their src/ instead of their dist/, and no
// build is needed first. Setting "conditions" replaces Vite's defaults, so the
// defaults are listed again. "ssr" covers Vitest's Node environment.

import { defaultClientConditions, defaultServerConditions, type UserConfig } from "vite";

/**
 * Extensions of test files. Vitest runs every "*.test.<ext>" file, and
 * tsconfig.build.base.json keeps the same files out of dist/.
 */
export const TEST_FILE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
] as const;

/** Glob for every test file, for Vitest's "include". */
export const TEST_FILE_GLOB = `**/*.test.{${TEST_FILE_EXTENSIONS.join(",")}}`;

export const SOURCE_CONDITION = "@galatsa/source";

export const workspaceSourceResolve = {
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
    },
  },
} satisfies UserConfig;
