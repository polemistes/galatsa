// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vite";
import { workspaceSourceResolve } from "../vite.shared.ts";

// Cross-origin isolation lets Chromium offer performance.measureUserAgentSpecificMemory().
// Every resource of the page is same-origin, so these headers break nothing.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  ...workspaceSourceResolve,
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    // dist/ holds the library build (tsc); the harness page goes to build/harness.
    outDir: "build/harness",
    emptyOutDir: true,
  },
});
