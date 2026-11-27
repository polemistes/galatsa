// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig, devices } from "@playwright/test";

/** Port of the bench harness dev server (bench/index.html). */
export const BENCH_PORT = 5199;
/** Port of the web app's dev server (apps/web, the editor's development page). */
export const WEB_PORT = 5198;

/**
 * Playwright's WebKit needs the libraries of the Ubuntu release it was built
 * for, so it runs where that is so (GitHub Actions) or when asked for with
 * E2E_WEBKIT=1; elsewhere the WebKit project is left out.
 */
const WEBKIT = Boolean(process.env["CI"] || process.env["E2E_WEBKIT"]);

// End-to-end tests are not part of `pnpm check`. They need browsers, which are
// installed separately with
// `pnpm --filter @galatsa/e2e exec playwright install chromium firefox`
// (and webkit, with its system libraries, where it can run).
export default defineConfig({
  testDir: ".",
  // One test at a time: benchmark runs must not compete for the CPU.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @galatsa/bench exec vite --port ${BENCH_PORT} --strictPort`,
      url: `http://localhost:${BENCH_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @galatsa/web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      testIgnore: "bench-*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The storage layer in Firefox too (WebKit: see bench/README.md, "Storage
      // check"). Chromium runs it in the "chromium" project above.
      name: "storage-firefox",
      testMatch: "storage.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      // The editor's development page in Firefox and WebKit too. Chromium runs it
      // in the "chromium" project above.
      name: "editor-firefox",
      testMatch: "editor.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
    ...(WEBKIT
      ? [
          {
            name: "editor-webkit",
            testMatch: "editor.spec.ts",
            use: { ...devices["Desktop Safari"] },
          },
        ]
      : []),
    {
      name: "bench-chromium",
      testMatch: "bench-*.spec.ts",
      // No device preset: it would replace the browser's real user agent, which the
      // results record. "chromium" is the full browser in its new headless mode,
      // closer to a normal window than the separate headless shell.
      use: {
        browserName: "chromium",
        channel: "chromium",
        baseURL: `http://localhost:${BENCH_PORT}`,
        viewport: { width: 1400, height: 1000 },
        launchOptions: {
          // Exact performance.memory values, and measureUserAgentSpecificMemory()
          // without waiting for the next garbage collection.
          args: [
            "--enable-precise-memory-info",
            "--enable-blink-features=ForceEagerMeasureMemory",
          ],
        },
      },
    },
    {
      name: "bench-firefox",
      testMatch: "bench-*.spec.ts",
      use: {
        browserName: "firefox",
        baseURL: `http://localhost:${BENCH_PORT}`,
        viewport: { width: 1400, height: 1000 },
      },
    },
  ],
});
