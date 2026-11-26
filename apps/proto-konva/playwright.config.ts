// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "@playwright/test";

/** Port of the preview server for this app. */
export const PORT = 5741;

// Not part of `pnpm check`. Builds the app and serves the built pages, so that the
// benchmark measures bundled code. Needs the browsers installed:
// `pnpm --filter @galatsa/proto-konva exec playwright install chromium firefox`.
//
//   pnpm --filter @galatsa/proto-konva e2e                         everything
//   pnpm --filter @galatsa/proto-konva e2e --project=chromium edit  one file
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/edit.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // The full browser in new headless mode (see tests/e2e/playwright.config.ts).
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
      name: "firefox",
      use: { browserName: "firefox", viewport: { width: 1400, height: 1000 } },
    },
  ],
});
