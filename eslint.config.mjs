// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

// Everything that git ignores (node_modules, dist, build, out, agent worktrees under
// .claude/, and so on) is ignored by ESLint too, so there is one list to maintain.
const gitignore = includeIgnoreFile(
  fileURLToPath(new URL(".gitignore", import.meta.url)),
);

export default tseslint.config(
  gitignore,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Svelte components (the editor's interface): Svelte's own rules, with
  // TypeScript in their <script lang="ts"> blocks, in a browser.
  ...svelte.configs.recommended,
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
