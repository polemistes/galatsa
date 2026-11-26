// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "@playwright/test";

/** Port of the built prototype pages, served by `vite preview`. */
export const PORT = 5207;

// Measurements and screenshots use the built pages (the dev server serves unbundled
// modules). Browsers are installed with `pnpm exec playwright install chromium
// firefox webkit`. Run one project at a time for measurements, so that runs do not
// share the machine: `pnpm e2e --project=chromium`.
const memoryArgs = [
  "--enable-precise-memory-info",
  "--enable-blink-features=ForceEagerMeasureMemory",
];

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 5 * 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      // The full browser in its new headless mode (software rendering).
      name: "chromium",
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: { args: memoryArgs },
      },
    },
    {
      // The same, with the GPU enabled through ANGLE on OpenGL.
      name: "chromium-gpu",
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: {
          args: [
            ...memoryArgs,
            "--enable-gpu",
            "--ignore-gpu-blocklist",
            "--use-angle=gl",
          ],
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
