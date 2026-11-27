// SPDX-License-Identifier: GPL-3.0-or-later

// The storage layer in real browsers (bench/storage-check.html): IndexedDB,
// recovery after a page that stops without closing its document, several tabs
// with the same document, files through the File System Access API, and the
// checkpoint worker.

import { expect, test, type Page } from "@playwright/test";
import { BENCH_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${BENCH_PORT}/storage-check.html`;

type CheckWindow = Window & {
  galatsaStorageCheck?: Record<string, (...args: unknown[]) => unknown>;
};

interface Features {
  userAgent: string;
  indexedDB: boolean;
  broadcastChannel: boolean;
  createWritable: boolean;
}

async function load(page: Page): Promise<void> {
  await page.goto(URL);
  await page.waitForFunction(
    () => (window as CheckWindow).galatsaStorageCheck !== undefined,
  );
}

/** Calls a function of the check page (bench/src/storage-check.ts). */
function call<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([n, a]) => (window as CheckWindow).galatsaStorageCheck![n]!(...a),
    [name, args] as const,
  ) as Promise<T>;
}

/**
 * Ends a page without letting it close its documents: the page goes away, as
 * when a tab is closed or crashes, and no session is closed. (Chromium's
 * Page.crash takes the whole headless context with it, so it is not used.)
 */
async function stop(page: Page): Promise<void> {
  await page.close({ runBeforeUnload: false });
}

test.describe("storage layer", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
    await call(page, "reset");
  });

  test("IndexedDB keeps the backend contract", async ({ page }) => {
    const features = await call<Features>(page, "features");
    test.info().annotations.push({ type: "browser", description: features.userAgent });
    expect(features.indexedDB).toBe(true);
    expect(await call(page, "contract")).toBe(true);
  });

  test("a stopped page's work is offered and restored at the next start", async ({
    page,
    context,
  }) => {
    const slot = await call<string>(page, "create", "Crash");
    await call(page, "edit", slot, 25, 1);
    expect(await call(page, "flush", slot)).toBe(true);
    const expected = await call<string>(page, "snapshot", slot);
    await stop(page);

    const next = await context.newPage();
    await load(next);
    expect(await call(next, "recoverable")).toEqual([slot]);
    const opened = await call<{ ok: boolean }>(next, "open", slot);
    expect(opened.ok).toBe(true);
    expect(await call(next, "snapshot", slot)).toBe(expected);
    expect(await call(next, "recoverable")).toEqual([]);
  });

  test("a damaged newest checkpoint falls back to the one before", async ({ page }) => {
    expect(await call(page, "tornCheckpoint")).toBe(true);
  });

  test("two tabs with the same document merge their work", async ({ page, context }) => {
    const features = await call<Features>(page, "features");
    const slot = await call<string>(page, "create", "Shared");
    const other = await context.newPage();
    await load(other);
    expect((await call<{ ok: boolean }>(other, "open", slot)).ok).toBe(true);
    // A running tab's document is not offered for recovery.
    expect(await call(other, "recoverable")).toEqual([]);

    const fromA = await call<string[]>(page, "edit", slot, 5, 1);
    const fromB = await call<string[]>(other, "edit", slot, 5, 2);
    await Promise.all([call(page, "flush", slot), call(other, "flush", slot)]);
    if (features.broadcastChannel) {
      // The other tab shows the changes once they are stored.
      await expect
        .poll(() => call(other, "elementIds", slot))
        .toEqual([...fromA, ...fromB].sort());
    }
    await Promise.all([call(page, "checkpoint", slot), call(other, "checkpoint", slot)]);
    await call(page, "edit", slot, 2, 3);
    await call(page, "flush", slot);
    await stop(page);
    await stop(other);

    const third = await context.newPage();
    await load(third);
    expect(await call(third, "recoverable")).toEqual([slot]);
    expect((await call<{ ok: boolean }>(third, "open", slot)).ok).toBe(true);
    const ids = await call<string[]>(third, "elementIds", slot);
    for (const id of [...fromA, ...fromB]) expect(ids).toContain(id);
    expect(ids).toHaveLength(12);
  });

  test("saves through a file handle atomically", async ({ page }) => {
    const features = await call<Features>(page, "features");
    test.skip(
      !features.createWritable,
      "no FileSystemWritableFileStream in this browser",
    );
    expect(await call(page, "fileHandle")).toBe(true);
  });

  test("the checkpoint worker builds the same file", async ({ page }) => {
    expect(await call(page, "worker")).toBe(true);
  });
});
