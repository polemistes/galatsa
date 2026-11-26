// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig, devices } from "@playwright/test";

/** Port of the bench harness dev server (bench/index.html). */
export const BENCH_PORT = 5199;

// End-to-end tests are not part of `pnpm check`. They need browsers, which are
// installed separately with
// `pnpm --filter @galatsa/e2e exec playwright install chromium`.
export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter @galatsa/bench exec vite --port ${BENCH_PORT} --strictPort`,
    url: `http://localhost:${BENCH_PORT}/`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "bench-*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The benchmark runs alone, so that other tests do not disturb its timing.
      name: "bench-chromium",
      testMatch: "bench-*.spec.ts",
      fullyParallel: false,
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
  ],
});
