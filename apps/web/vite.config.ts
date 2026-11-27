// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { workspaceConfig } from "../../vite.shared.ts";

/** The font packages whose files the page ships (packages/renderer/src/fonts.css). */
const FONT_PACKAGES = ["noto-sans", "noto-serif", "noto-sans-mono"];

/**
 * Puts the fonts' licence (SIL Open Font License, with their copyright
 * notices) into the build, as licenses/fonts/<family>.txt: the licence asks
 * that every copy of the fonts carries it (docs/adr/0011-text.md).
 */
function fontLicenses(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "galatsa-font-licenses",
    apply: "build",
    generateBundle() {
      for (const name of FONT_PACKAGES)
        this.emitFile({
          type: "asset",
          fileName: `licenses/fonts/${name}.txt`,
          source: readFileSync(require.resolve(`@fontsource/${name}/LICENSE`), "utf8"),
        });
    },
  };
}

export default defineConfig(
  workspaceConfig({
    // The editor's interface is Svelte components, compiled from source.
    plugins: [svelte(), fontLicenses()],
    // The checkpoint worker is an ES module (it imports the file format).
    worker: { format: "es" },
    build: { outDir: "dist", target: "es2023" },
  }),
);
