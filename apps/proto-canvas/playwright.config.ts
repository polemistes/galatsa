// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "@playwright/test";

export const PORT = 5281;

// Runs against the built pages (vite build + vite preview), as the bench README
// recommends for measurements. Browsers: `pnpm exec playwright install chromium firefox`.
//
//   pnpm --filter @galatsa/proto-canvas e2e                         all tests
//   pnpm --filter @galatsa/proto-canvas e2e --project=chromium edit  one file
//
// bench.spec.ts and screenshots.spec.ts write their output to results/.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      // The full browser in its new headless mode, as in tests/e2e.
      name: "chromium",
      use: {
        browserName: "chromium",
        channel: "chromium",
        viewport: { width: 1400, height: 1000 },
        launchOptions: {
          args: [
            "--enable-precise-memory-info",
            "--enable-blink-features=ForceEagerMeasureMemory",
          ],
        },
      },
    },
    {
      // Same, with the machine's GPU: headless Chromium otherwise rasterises the
      // canvas in software ("Canvas: Software only" in chrome://gpu).
      name: "chromium-gpu",
      use: {
        browserName: "chromium",
        channel: "chromium",
        viewport: { width: 1400, height: 1000 },
        launchOptions: {
          args: [
            "--enable-precise-memory-info",
            "--enable-blink-features=ForceEagerMeasureMemory",
            "--enable-gpu",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        viewport: { width: 1400, height: 1000 },
      },
    },
  ],
});
