// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing on the playground page: open a text box by double-clicking,
// type, move the caret, select, paste, compose characters with an input method, and
// check that the canvas draws the edited text afterwards. IME composition uses the
// Chrome DevTools Protocol, so the test runs in Chromium only.

import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openPlayground, RESULTS_DIR, setCamera, type TextBox } from "./playground.ts";

/**
 * A left-aligned, unrotated body text box with nothing painted over it, so the
 * double-click hits it and caret positions are easy to reason about.
 */
async function plainTextBox(page: Page): Promise<TextBox> {
  return page.evaluate(() => {
    const elements = window.protoKonva!.scene.elements;
    const covered = (i: number) => {
      const a = elements[i]!;
      const margin = 300;
      return elements.some(
        (b, j) =>
          j > i &&
          b.x < a.x + a.width + margin &&
          b.x + b.width + margin > a.x &&
          b.y < a.y + a.height + margin &&
          b.y + b.height + margin > a.y,
      );
    };
    const index = elements.findIndex(
      (x, i) =>
        x.kind === "text" &&
        x.rotation === 0 &&
        x.align === "left" &&
        x.opacity === 1 &&
        x.fontSize >= 16 &&
        x.fontSize <= 40 &&
        x.width >= 400 &&
        !covered(i),
    );
    const e = elements[index];
    if (e === undefined || e.kind !== "text") throw new Error("No suitable text box");
    return {
      id: e.id,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      fontSize: e.fontSize,
      lineHeight: e.lineHeight,
      align: e.align,
      text: e.text,
    };
  });
}

const selection = (page: Page) =>
  page.evaluate(() => {
    const t = window.protoKonva!.engine.textarea!;
    return [t.selectionStart, t.selectionEnd, t.value] as const;
  });

test("edit a text box in place: type, caret, selection, paste, IME", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "IME composition is driven through CDP");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPlayground(page);
  const box = await plainTextBox(page);
  // Zoom 1, the box's top-left corner 100 px in from the stage's top-left.
  await setCamera(page, { x: box.x - 100 + 640, y: box.y - 100 + 360, zoom: 1 });
  const stage = page.locator(".stage");
  const region = { x: 60, y: 60, width: Math.min(box.width + 80, 1200), height: 240 };
  const before = await stage.screenshot({ clip: region });

  // Double-click on the first line opens the editor with the box's text.
  const point = await page.evaluate(([x, y]) => window.protoKonva!.toClient(x, y), [
    box.x + 10,
    box.y + box.fontSize / 2,
  ] as const);
  await page.mouse.dblclick(point.x, point.y);
  const textarea = page.locator("textarea.galatsa-text-editor");
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue(box.text);

  // Typing replaces a selection.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Hello world");
  await expect(textarea).toHaveValue("Hello world");

  // Caret movement.
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  expect(await selection(page)).toEqual([5, 5, "Hello world"]);
  await page.keyboard.type(",");
  await page.keyboard.press("End");
  expect(await selection(page)).toEqual([12, 12, "Hello, world"]);
  await page.keyboard.press("ControlOrMeta+ArrowLeft");
  expect((await selection(page))[0]).toBe(7);

  // Selection with the keyboard, then typing over it.
  await page.keyboard.press("Shift+End");
  expect(await selection(page)).toEqual([7, 12, "Hello, world"]);
  await stage.screenshot({ path: join(RESULTS_DIR, "edit-selection.png"), clip: region });
  await page.keyboard.type("there");
  await expect(textarea).toHaveValue("Hello, there");

  // Selection with the mouse: double-click a word.
  const wordAt = await textarea.boundingBox();
  await page.mouse.dblclick(wordAt!.x + 5, wordAt!.y + box.fontSize / 2);
  expect(await selection(page)).toEqual([0, 5, "Hello, there"]);

  // Paste from the clipboard at the caret.
  await page.evaluate(() => navigator.clipboard.writeText("Blåbærsyltetøy! "));
  await page.keyboard.press("Home");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(textarea).toHaveValue("Blåbærsyltetøy! Hello, there");

  // IME composition, as with a dead key (´ then e) and with a Japanese input method.
  const events: string[] = await page.evaluate(() => {
    const log: string[] = [];
    const t = window.protoKonva!.engine.textarea!;
    for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
      t.addEventListener(type, (e) =>
        log.push(`${type}:${(e as CompositionEvent).data}`),
      );
    }
    (window as unknown as { imeLog: string[] }).imeLog = log;
    return log;
  });
  expect(events).toEqual([]);
  const cdp = await context.newCDPSession(page);
  await page.keyboard.press("End");
  await page.keyboard.type(" caf");
  await cdp.send("Input.imeSetComposition", {
    text: "´",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect(textarea).toHaveValue("Blåbærsyltetøy! Hello, there caf´");
  await cdp.send("Input.insertText", { text: "é" });
  await expect(textarea).toHaveValue("Blåbærsyltetøy! Hello, there café");

  await page.keyboard.type(" ");
  await cdp.send("Input.imeSetComposition", {
    text: "か",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await cdp.send("Input.imeSetComposition", {
    text: "かな",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await stage.screenshot({
    path: join(RESULTS_DIR, "edit-ime-composing.png"),
    clip: region,
  });
  await cdp.send("Input.insertText", { text: "仮名" });
  const expected = "Blåbærsyltetøy! Hello, there café 仮名";
  await expect(textarea).toHaveValue(expected);
  const log = await page.evaluate(
    () => (window as unknown as { imeLog: string[] }).imeLog,
  );
  expect(log).toContain("compositionstart:");
  expect(log).toContain("compositionupdate:かな");
  expect(log).toContain("compositionend:仮名");
  await stage.screenshot({ path: join(RESULTS_DIR, "edit-typed.png"), clip: region });

  // Escape ends editing; the canvas now draws the new text.
  await page.keyboard.press("Escape");
  await expect(textarea).toBeHidden();
  expect(await page.evaluate((id) => window.protoKonva!.engine.textOf(id), box.id)).toBe(
    expected,
  );
  const lines = await page.evaluate(
    (id) => window.protoKonva!.engine.textLines(id),
    box.id,
  );
  expect(lines.map((l) => l.text).join(" ")).toBe(expected);
  await page.evaluate(() => window.protoKonva!.nextFrame());
  await page.evaluate(() => window.protoKonva!.nextFrame());
  const after = await stage.screenshot({
    path: join(RESULTS_DIR, "edit-after.png"),
    clip: region,
  });
  expect(after.equals(before)).toBe(false);

  // Clicking on the canvas outside the editor also ends editing (blur).
  await page.mouse.dblclick(point.x, point.y);
  await expect(textarea).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.mouse.click(point.x, point.y + 300);
  await expect(textarea).toBeHidden();
  expect(await page.evaluate((id) => window.protoKonva!.engine.textOf(id), box.id)).toBe(
    `${expected}!`,
  );
});
