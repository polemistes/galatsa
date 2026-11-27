// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vite";
import { workspaceSourceResolve } from "../../vite.shared.ts";

export default defineConfig({
  ...workspaceSourceResolve,
  // The checkpoint worker is an ES module (it imports the file format).
  worker: { format: "es" },
  build: { outDir: "dist", target: "es2023" },
});
