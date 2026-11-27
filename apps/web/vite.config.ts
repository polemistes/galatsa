// SPDX-License-Identifier: GPL-3.0-or-later

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { workspaceConfig } from "../../vite.shared.ts";

export default defineConfig(
  workspaceConfig({
    // The editor's interface is Svelte components, compiled from source.
    plugins: [svelte()],
    // The checkpoint worker is an ES module (it imports the file format).
    worker: { format: "es" },
    build: { outDir: "dist", target: "es2023" },
  }),
);
