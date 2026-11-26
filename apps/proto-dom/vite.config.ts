// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
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
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        lab: fileURLToPath(new URL("lab.html", import.meta.url)),
      },
    },
  },
});
