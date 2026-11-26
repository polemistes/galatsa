// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { workspaceSourceResolve } from "../../vite.shared.ts";

// Two pages: the start screen (index.html) and the page that runs one engine
// (run.html). Tauri serves dist/ in the app and uses the dev server on port 1420
// with `pnpm tauri dev`. No cross-origin isolation headers: memory is measured by
// the host, so the page's own memory API is not needed.
export default defineConfig({
  ...workspaceSourceResolve,
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        run: fileURLToPath(new URL("run.html", import.meta.url)),
      },
    },
  },
});
