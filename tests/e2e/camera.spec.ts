// SPDX-License-Identifier: GPL-3.0-or-later

// Camera and navigation in a real browser (docs/adr/0010-camera.md): the
// mouse wheel and a trackpad's two fingers scroll the canvas, Ctrl with the
// wheel (what browsers send for a trackpad pinch) zooms about the pointer and
// the point under it stays within a pixel, the middle button and Space with a
// drag move the canvas, two fingers pan and pinch, Safari's gesture events
// zoom, and the keyboard zooms, shows everything and shows the selection.
// Runs in the "chromium", "editor-firefox" and, where Playwright's WebKit can
// run, "editor-webkit" projects
// (`pnpm --filter @galatsa/e2e exec playwright test camera.spec.ts`).

import { expect, test, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

const URL = `http://localhost:${WEB_PORT}/?lang=en&fresh&scene=empty`;

interface View {
  space: string | null;
  cx: number;
  cy: number;
  zoom: number;
}

interface DevEditor {
  camera: View;
  selection: readonly string[];
  projection(space: string | null): { scale: number; ox: number; oy: number };
  renderer: {
    screenBounds(id: string): { x: number; y: number; w: number; h: number } | null;
  };
  tools: { current: string | null };
}

async function camera(page: Page): Promise<View> {
  return page.evaluate(() => {
    const dev = (window as unknown as { galatsaDev: { editor(): DevEditor | null } })
      .galatsaDev;
    return { ...dev.editor()!.camera };
  });
}

/** The root point under a point of the canvas (CSS pixels). */
async function under(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const dev = (window as unknown as { galatsaDev: { editor(): DevEditor | null } })
        .galatsaDev;
      const p = dev.editor()!.projection(null);
      return { x: (sx! - p.ox) / p.scale, y: (sy! - p.oy) / p.scale };
    },
    [x, y],
  );
}

/** Where a root point is on the canvas now. */
async function onScreen(
  page: Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const dev = (window as unknown as { galatsaDev: { editor(): DevEditor | null } })
      .galatsaDev;
    const pr = dev.editor()!.projection(null);
    return { x: p.x * pr.scale + pr.ox, y: p.y * pr.scale + pr.oy };
  }, point);
}

async function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dev = (window as unknown as { galatsaDev: { editor(): DevEditor | null } })
      .galatsaDev;
    return [...dev.editor()!.selection];
  });
}

async function screenBox(page: Page, id: string) {
  return page.evaluate((elementId) => {
    const dev = (window as unknown as { galatsaDev: { editor(): DevEditor | null } })
      .galatsaDev;
    return dev.editor()!.renderer.screenBounds(elementId);
  }, id);
}

/** Pointer events as a touch screen sends them, dispatched on the canvas. */
async function touch(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  id: number,
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ([kind, pointerId, cx, cy]) => {
      const surface = document.querySelector<HTMLElement>(".galatsa-canvas")!;
      const rect = surface.getBoundingClientRect();
      surface.dispatchEvent(
        new PointerEvent(kind as string, {
          pointerId: pointerId as number,
          pointerType: "touch",
          isPrimary: pointerId === 1,
          clientX: rect.left + (cx as number),
          clientY: rect.top + (cy as number),
          button: kind === "pointermove" ? -1 : 0,
          buttons: kind === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [type, id, x, y] as const,
  );
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

test("the camera follows the mouse, the trackpad, touch and the keyboard", async ({
  page,
  browserName,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(URL);
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as unknown as { galatsaDev?: { editor(): unknown } }
        ).galatsaDev?.editor(),
      ),
    null,
    { timeout: 90_000 },
  );
  const surface = page.locator(".galatsa-canvas");
  await expect(surface).toBeVisible();
  const box = (await surface.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
  const start = await camera(page);
  expect(start.zoom).toBe(1);

  // A rectangle to look at, drawn with the rectangle tool.
  await surface.focus();
  await page.keyboard.press("r");
  const a = at(box.width * 0.45, box.height * 0.45);
  const b = at(box.width * 0.55, box.height * 0.55);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(
      async () => (await page.evaluate(() => document.activeElement?.className)) ?? "",
    )
    .toContain("galatsa-canvas");

  // The wheel scrolls (a mouse wheel, or two fingers on a trackpad).
  let before = await camera(page);
  const pointer = at(box.width * 0.7, box.height * 0.3);
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(30, 100);
  await expect.poll(async () => (await camera(page)).cy).toBeCloseTo(before.cy + 100, 3);
  expect((await camera(page)).cx).toBeCloseTo(before.cx + 30, 3);
  expect((await camera(page)).zoom).toBe(1);

  // Ctrl with the wheel zooms about the pointer, which keeps its point: a
  // mouse wheel's notches in, then a trackpad pinch's small steps out.
  const local = { x: box.width * 0.7, y: box.height * 0.3 };
  const target = await under(page, local.x, local.y);
  await page.keyboard.down("Control");
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1000);
  expect(close(await onScreen(page, target), local)).toBeLessThan(1);
  await page.keyboard.down("Control");
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 7);
  await page.keyboard.up("Control");
  expect((await camera(page)).zoom).toBeLessThan(1000);
  expect(close(await onScreen(page, target), local)).toBeLessThan(1);

  // Back to actual size, from the keyboard: Ctrl+0.
  await page.keyboard.press("Control+0");
  await expect.poll(async () => (await camera(page)).zoom).toBe(1);

  // Zoom in with Ctrl and + (the + key of a Norwegian keyboard gives "+"
  // without Shift) and with Ctrl and = (US); out with Ctrl and -.
  await page.keyboard.press("Control++");
  await expect.poll(async () => (await camera(page)).zoom).toBe(2);
  await page.keyboard.press("Control+Equal");
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
  await page.keyboard.press("Control+Minus");
  await expect.poll(async () => (await camera(page)).zoom).toBe(2);
  // The browser did not zoom the page itself.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  // The arrow keys move the view.
  before = await camera(page);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await camera(page)).cx).toBeGreaterThan(before.cx);

  // The middle button drags the canvas.
  before = await camera(page);
  const m = at(box.width * 0.2, box.height * 0.8);
  await page.mouse.move(m.x, m.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(m.x + 40, m.y - 20, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  await expect
    .poll(async () => (await camera(page)).cx)
    .toBeCloseTo(before.cx - 40 / 2, 3);
  expect((await camera(page)).cy).toBeCloseTo(before.cy + 20 / 2, 3);

  // Space and a drag move the canvas instead of using the tool.
  const selectedBefore = await selection(page);
  before = await camera(page);
  await page.keyboard.down("Space");
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  await page.mouse.move(m.x - 60, m.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect
    .poll(async () => (await camera(page)).cx)
    .toBeCloseTo(before.cx + 60 / 2, 3);
  expect((await camera(page)).cy).toBeCloseTo(before.cy - 30 / 2, 3);
  expect(await selection(page)).toEqual(selectedBefore);

  // Show everything (Shift+1): the rectangle fills the view.
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Shift+Digit1");
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(5);

  // Two fingers: spreading them zooms about the point between them, moving
  // them pans.
  await page.keyboard.press("Control+0");
  before = await camera(page);
  const mid = { x: box.width * 0.5, y: box.height * 0.5 };
  const between = await under(page, mid.x, mid.y);
  await touch(page, "pointerdown", 1, mid.x - 50, mid.y);
  await touch(page, "pointerdown", 2, mid.x + 50, mid.y);
  for (let i = 1; i <= 5; i++) {
    await touch(page, "pointermove", 1, mid.x - 50 - 10 * i, mid.y + 4 * i);
    await touch(page, "pointermove", 2, mid.x + 50 + 10 * i, mid.y + 4 * i);
  }
  await touch(page, "pointerup", 2, mid.x + 100, mid.y + 20);
  await touch(page, "pointerup", 1, mid.x - 100, mid.y + 20);
  const pinched = await camera(page);
  expect(pinched.zoom).toBeCloseTo(before.zoom * 2, 6);
  expect(close(await onScreen(page, between), { x: mid.x, y: mid.y + 20 })).toBeLessThan(
    1,
  );
  // The fingers neither drew nor selected anything.
  expect(await selection(page)).toEqual(selectedBefore);

  // Safari's gesture events for a pinch on a trackpad.
  before = await camera(page);
  await page.evaluate(
    ([x, y]) => {
      const surface = document.querySelector<HTMLElement>(".galatsa-canvas")!;
      const rect = surface.getBoundingClientRect();
      for (const [type, scale] of [
        ["gesturestart", 1],
        ["gesturechange", 1.5],
        ["gesturechange", 3],
        ["gestureend", 3],
      ] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          scale: { value: scale },
          clientX: { value: rect.left + x! },
          clientY: { value: rect.top + y! },
        });
        surface.dispatchEvent(event);
      }
    },
    [mid.x, mid.y],
  );
  expect((await camera(page)).zoom).toBeCloseTo(before.zoom * 3, 6);

  // Show the selection (Shift+2): select the rectangle, zoom out, show it.
  await page.keyboard.press("Shift+Digit1");
  const centre = at(box.width / 2, box.height / 2);
  await page.mouse.click(centre.x, centre.y);
  const selected = await selection(page);
  expect(selected).toHaveLength(1);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+Minus");
  const small = (await screenBox(page, selected[0]!))!;
  await page.keyboard.press("Shift+Digit2");
  await expect
    .poll(async () => (await screenBox(page, selected[0]!))!.w)
    .toBeGreaterThan(small.w * 8);

  expect(errors, browserName).toEqual([]);
});

test("two real fingers pinch the canvas (Chromium's touch input)", async ({
  page,
  browserName,
  context,
}) => {
  test.skip(
    browserName !== "chromium",
    "touch is sent through Chromium's DevTools protocol",
  );
  await page.goto(URL);
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as unknown as { galatsaDev?: { editor(): unknown } }
        ).galatsaDev?.editor(),
      ),
    null,
    { timeout: 90_000 },
  );
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const local = { x: box.width / 2, y: box.height / 2 };
  const target = await under(page, local.x, local.y);
  const fingers = (d: number, dy = 0) => [
    { x: mid.x - d, y: mid.y + dy, id: 1 },
    { x: mid.x + d, y: mid.y + dy, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: fingers(40),
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: fingers(40 + 5 * i),
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(2, 6);
  expect(close(await onScreen(page, target), local)).toBeLessThan(1);
});
