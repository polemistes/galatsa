// SPDX-License-Identifier: GPL-3.0-or-later

import { resolve } from "node:path";
import { defineConfig } from "vite";
import { workspaceSourceResolve } from "../../vite.shared.ts";

// Cross-origin isolation lets Chromium offer performance.measureUserAgentSpecificMemory(),
// as on the bench's own harness page.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  ...workspaceSourceResolve,
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    outDir: "build",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        harness: resolve(import.meta.dirname, "index.html"),
        demo: resolve(import.meta.dirname, "demo.html"),
      },
    },
  },
});
