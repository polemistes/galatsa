// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { TEST_FILE_GLOB, workspaceConfig } from "./vite.shared.ts";

/**
 * Workspace packages whose tests need a browser-like DOM, by folder, with the
 * environment to use. Every other test file runs in Node. Vitest loads the
 * environment package from the repository root, so "happy-dom" or "jsdom" must be
 * in the root's devDependencies. See docs/new-package.md.
 *
 * Example: { "packages/renderer": "happy-dom" }
 */
const DOM_TEST_PACKAGES: Readonly<Record<string, "happy-dom" | "jsdom">> = {};

// Installed and generated files, and Playwright's end-to-end tests (tests/e2e,
// *.spec.ts), which run separately with `pnpm e2e`.
const EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/target/**",
  "**/.claude/**",
  "tests/e2e/**",
];

export default defineConfig(
  // Svelte components compile in tests too (the editor's interface).
  workspaceConfig({
    plugins: [svelte()],
    test: {
      // One Vitest project per test environment. Each project inherits the settings
      // above ("extends: true"), so workspace packages are read from source everywhere.
      projects: [
        {
          extends: true,
          test: {
            name: "node",
            // Every test file in the repository, in any folder, except the packages
            // listed in DOM_TEST_PACKAGES.
            include: [TEST_FILE_GLOB],
            exclude: [
              ...EXCLUDE,
              ...Object.keys(DOM_TEST_PACKAGES).map((dir) => `${dir}/**`),
            ],
            environment: "node",
          },
        },
        ...Object.entries(DOM_TEST_PACKAGES).map(([dir, environment]) => ({
          extends: true,
          test: {
            name: dir,
            include: [`${dir}/${TEST_FILE_GLOB}`],
            exclude: EXCLUDE,
            environment,
          },
        })),
      ],
    },
  }),
);
