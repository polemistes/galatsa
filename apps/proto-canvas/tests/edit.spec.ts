// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing on the canvas: typing, caret movement, selection by keyboard
// and mouse, paste, undo and IME composition (Chromium's DevTools protocol), and that
// the edited text is drawn. Screenshots go to results/edit-*.png.

import { expect, type Page, test } from "@playwright/test";
import type { EditState } from "../src/editor.ts";

const WIDTH = 960;
const HEIGHT = 540;
/** Body text, 24 units, left-aligned, sans-serif, not covered by other elements. */
const TEXT = "t0389";

const state = (page: Page): Promise<EditState | null> =>
  page.evaluate(() => window.protoCanvas!.engine.editState());

/** CSS pixels in the page for a caret offset of the text. */
async function pagePoint(page: Page, offset: number): Promise<{ x: number; y: number }> {
  const local = await page.evaluate(
    ({ id, offset }) => window.protoCanvas!.engine.caretScreenPoint(id, offset)!,
    { id: TEXT, offset },
  );
  const box = (await page.locator("#stage").boundingBox())!;
  return { x: box.x + local.x, y: box.y + local.y };
}

/** Draws now (the page redraws on the next animation frame anyway) and waits a frame. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          window.protoCanvas!.draw();
          resolve();
        }),
      ),
  );
}

async function shot(page: Page, name: string, browserName: string): Promise<Buffer> {
  await settle(page);
  return page.locator("#stage canvas").screenshot({
    path: new URL(`../results/edit-${name}-${browserName}.png`, import.meta.url).pathname,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/demo.html?width=${WIDTH}&height=${HEIGHT}`);
  await page.waitForFunction(() => window.protoCanvas !== undefined);
  await page.evaluate(() => window.protoCanvas!.ready);
  await page.evaluate((id) => {
    const api = window.protoCanvas!;
    const e = api.engine.textElement(id)!;
    // Zoom 1.5: the text's top-left corner near the view's top-left.
    const zoom = 1.5;
    api.setCamera({
      x: e.x - 30 / zoom + 480 / zoom,
      y: e.y - 30 / zoom + 270 / zoom,
      zoom,
    });
  }, TEXT);
});

test("type, move, select, paste, undo and compose in a canvas text", async ({
  page,
  browserName,
  context,
}) => {
  const original = await page.evaluate(
    (id) => window.protoCanvas!.engine.textElement(id)!.text,
    TEXT,
  );
  const before = await shot(page, "0-before", browserName);

  // Double-click in the first word starts editing with the caret there.
  const p = await pagePoint(page, 3);
  await page.mouse.dblclick(p.x, p.y);
  let s = await state(page);
  expect(s?.id).toBe(TEXT);
  expect(s?.focused).toBe(true);
  expect(s?.selectionStart).toBe(3);
  await page.evaluate(() => {
    window.protoCanvas!.engine.editor!.blink = false;
  });

  // Typing at the end.
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Hei på deg, Ørnulf!");
  s = await state(page);
  expect(s?.text).toBe(`${original} Hei på deg, Ørnulf!`);
  expect(s?.selectionStart).toBe(s!.text.length);
  const typed = await shot(page, "1-typed", browserName);
  expect(typed.equals(before)).toBe(false);

  // Caret movement: left by graphemes, word-wise (the browser's own), up a line
  // and Home/End (our line layout).
  const end = s!.text.length;
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect((await state(page))?.selectionStart).toBe(end - 2);
  await page.keyboard.press("Control+ArrowLeft");
  expect((await state(page))?.selectionStart).toBe(end - "Ørnulf!".length);
  const lastLineCaret = (await state(page))!.selectionStart;
  await page.keyboard.press("ArrowUp");
  const up = (await state(page))!.selectionStart;
  expect(up).toBeLessThan(lastLineCaret);
  const yUp = (await pagePoint(page, up)).y;
  const yDown = (await pagePoint(page, lastLineCaret)).y;
  expect(yDown - yUp).toBeCloseTo(24 * 1.25 * 1.5, 0);
  await page.keyboard.press("Home");
  const home = (await state(page))!.selectionStart;
  expect((await pagePoint(page, home)).x).toBeCloseTo((await pagePoint(page, 0)).x, 0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  expect((await state(page))!.selectionStart).toBe(end);

  // Selection with the keyboard, then replace it by typing.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
  s = await state(page);
  expect([s?.selectionStart, s?.selectionEnd, s?.direction]).toEqual([
    end - 6,
    end,
    "backward",
  ]);
  await shot(page, "2-selected", browserName);
  await page.keyboard.type("Åse!");
  s = await state(page);
  expect(s?.text.endsWith("Hei på deg, Åse!")).toBe(true);

  // Selection with the mouse: drag over the first two words.
  const a = await pagePoint(page, 0);
  const b = await pagePoint(page, original.indexOf(" ", original.indexOf(" ") + 1));
  await page.mouse.move(a.x + 1, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, b.y, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
  s = await state(page);
  expect(s?.selectionStart).toBe(0);
  expect(s?.selectionEnd).toBe(original.indexOf(" ", original.indexOf(" ") + 1));
  await shot(page, "3-mouse-selection", browserName);

  // Paste over the selection, from the system clipboard.
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("Limt inn"));
    await page.keyboard.press("Control+V");
    s = await state(page);
    expect(s?.text.startsWith("Limt inn ")).toBe(true);
    expect(s?.selectionStart).toBe("Limt inn".length);
    await shot(page, "4-pasted", browserName);

    // Undo is the textarea's own.
    await page.keyboard.press("Control+Z");
    s = await state(page);
    expect(s?.text.startsWith(original.slice(0, 10))).toBe(true);
    await page.keyboard.press("Control+Shift+Z");
    expect((await state(page))?.text.startsWith("Limt inn ")).toBe(true);
  }

  // IME composition, as a Japanese input method sends it, at the caret after "inn".
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    const at = (await state(page))!.selectionStart;
    await cdp.send("Input.imeSetComposition", {
      text: "にほ",
      selectionStart: 2,
      selectionEnd: 2,
    });
    s = await state(page);
    expect(s?.composition).toEqual({ start: at, end: at + 2 });
    expect(s?.text.slice(at, at + 2)).toBe("にほ");
    // The hidden textarea sits at the start of the composition, so the IME
    // candidate window opens there.
    const ta = (await page.locator("#stage textarea").boundingBox())!;
    const caret = await pagePoint(page, at);
    expect(Math.abs(ta.x - caret.x)).toBeLessThan(2);
    expect(Math.abs(ta.y + ta.height / 2 - caret.y)).toBeLessThan(2);
    await cdp.send("Input.imeSetComposition", {
      text: "日本語",
      selectionStart: 3,
      selectionEnd: 3,
    });
    s = await state(page);
    expect(s?.composition).toEqual({ start: at, end: at + 3 });
    const composing = await shot(page, "5-composing", browserName);
    await cdp.send("Input.insertText", { text: "日本語" });
    s = await state(page);
    expect(s?.composition).toBeNull();
    expect(s?.text.slice(at, at + 3)).toBe("日本語");
    expect(s?.text).not.toContain("にほ");
    const committed = await shot(page, "6-committed", browserName);
    // The underline is gone after the commit.
    expect(committed.equals(composing)).toBe(false);
  }

  // Escape ends editing; the edited text stays and is drawn.
  const final = (await state(page))!.text;
  await page.keyboard.press("Escape");
  expect(await state(page)).toBeNull();
  expect(await page.evaluate(() => document.querySelector("#stage textarea"))).toBeNull();
  const after = await shot(page, "7-after", browserName);
  expect(after.equals(before)).toBe(false);
  expect(await page.evaluate((id) => window.protoCanvas!.engine.textOf(id), TEXT)).toBe(
    final,
  );
});
