// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { workspaceSourceResolve } from "../../vite.shared.ts";

// Cross-origin isolation lets Chromium offer performance.measureUserAgentSpecificMemory()
// (see bench/vite.config.ts). Every resource of the page is same-origin.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  ...workspaceSourceResolve,
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    rollupOptions: {
      input: {
        harness: fileURLToPath(new URL("index.html", import.meta.url)),
        edit: fileURLToPath(new URL("edit.html", import.meta.url)),
      },
    },
  },
});
