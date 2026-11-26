// SPDX-License-Identifier: GPL-3.0-or-later

// Editing text in place on the canvas: the text element itself becomes
// contenteditable, so caret, selection, clipboard and input methods are the
// browser's own. Shows typing, caret movement, selection, paste (rich text arrives
// as plain text), IME composition (Chromium, through the DevTools protocol), and
// that the edited text renders and survives a zoom change. Screenshots go to
// results/<project>/edit/.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const RESULTS = new URL("../results/", import.meta.url);
const X = 28800;
const Y = 6600;
const CLIP = { x: 0, y: 0, width: 1280, height: 720 };
const VARIANT = process.env["EDIT_VARIANT"] ?? "dom";

const textOf = (page: Page) => page.evaluate(() => window.protoLab!.textOf("body") ?? "");

test(`edit text in place: ${VARIANT}`, async ({ page, browserName }, testInfo) => {
  const folder = new URL(`${testInfo.project.name}/edit/`, RESULTS);
  mkdirSync(folder, { recursive: true });
  await page.goto("/lab.html");
  await page.waitForFunction(() => window.protoLab !== undefined);
  await page.evaluate((v) => window.protoLab!.init(v, "text"), VARIANT);
  // The body text (16 world units) at zoom 2: 32 px on screen.
  await page.evaluate((pose) => window.protoLab!.setCamera(pose), {
    x: X + 250,
    y: Y + 110,
    zoom: 2,
  });
  await page.evaluate(() => window.protoLab!.waitSharp(5000));
  const original = await textOf(page);
  writeFileSync(new URL("0-before.png", folder), await page.screenshot({ clip: CLIP }));

  // A source of rich text outside the canvas, for the paste test.
  await page.evaluate(() => {
    const source = document.createElement("div");
    source.id = "rich";
    source.innerHTML = "<b>fet</b> <i>tekst</i>";
    source.style.position = "fixed";
    source.style.left = "0";
    source.style.top = "730px";
    document.body.append(source);
  });

  // Double-click the text to start editing; the engine focuses it.
  const body = page.locator('[data-id="body"]');
  await body.dblclick({ position: { x: 40, y: 15 } });
  await expect(body).toHaveAttribute("contenteditable", /plaintext-only|true/);
  await expect(body).toBeFocused();

  // Typing at the start.
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("Hei ");
  expect(await textOf(page)).toBe(`Hei ${original}`);

  // Caret movement: four characters left from the end, then type.
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("#");
  expect(await textOf(page)).toMatch(/0123456#789\.$/);

  // Selection with the keyboard, replaced by typing.
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Hei");
  await page.keyboard.type("Hallo");
  expect(await textOf(page)).toMatch(/^Hallo Kameraet/);

  // Selection with the mouse: a double-click selects a word.
  await body.dblclick({ position: { x: 40, y: 15 } });
  const word = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(word.trim().length).toBeGreaterThan(0);
  writeFileSync(
    new URL("1-mouse-selection.png", folder),
    await page.screenshot({ clip: CLIP }),
  );

  // Paste: copy rich text from outside, paste at the end; it arrives as plain text.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("rich")!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("Control+C");
  await body.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+V");
  expect(await textOf(page)).toMatch(/fet tekst$/);
  expect(await body.locator("b, i, span, font").count()).toBe(0);

  // IME composition (Chromium): compose "にほ", then commit "日本".
  let ime = "skipped (no DevTools protocol in this browser)";
  if (browserName === "chromium") {
    await page.evaluate(() => {
      const node = document.querySelector('[data-id="body"]')!;
      const log: string[] = [];
      (window as unknown as { imeLog: string[] }).imeLog = log;
      for (const type of ["compositionstart", "compositionupdate", "compositionend"])
        node.addEventListener(type, (e) =>
          log.push(`${type}:${(e as CompositionEvent).data}`),
        );
    });
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.type(" ");
    await cdp.send("Input.imeSetComposition", {
      text: "に",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send("Input.imeSetComposition", {
      text: "にほ",
      selectionStart: 2,
      selectionEnd: 2,
    });
    expect(await textOf(page)).toMatch(/にほ$/);
    writeFileSync(
      new URL("2-ime-composing.png", folder),
      await page.screenshot({ clip: CLIP }),
    );
    await cdp.send("Input.insertText", { text: "日本" });
    const text = await textOf(page);
    expect(text).toMatch(/fet tekst 日本$/);
    expect(text).not.toMatch(/にほ/);
    const log = await page.evaluate(
      () => (window as unknown as { imeLog: string[] }).imeLog,
    );
    expect(log[0]).toBe("compositionstart:");
    expect(log).toContain("compositionend:日本");
    ime = `ok: ${log.join(", ")}`;
  }

  // The edited text renders: stop editing, compare with the first screenshot, and
  // zoom in so the engine lays the text out again at the new zoom.
  await page.evaluate(() => window.protoLab!.endEdit());
  await page.evaluate(() => window.protoLab!.frames(2));
  const after = await page.screenshot({ clip: CLIP });
  writeFileSync(new URL("3-after-edit.png", folder), after);
  const edited = await textOf(page);
  await expect(body).toContainText("Hallo Kameraet");
  await page.evaluate((pose) => window.protoLab!.setCamera(pose), {
    x: X + 60,
    y: Y + 85,
    zoom: 8,
  });
  await page.evaluate(() => window.protoLab!.waitSharp(5000));
  await page.evaluate(() => window.protoLab!.frames(2));
  writeFileSync(
    new URL("4-after-edit-zoom-8.png", folder),
    await page.screenshot({ clip: CLIP }),
  );
  await expect(body).toContainText("Hallo Kameraet");
  expect(await textOf(page)).toBe(edited);

  const summary = {
    variant: VARIANT,
    project: testInfo.project.name,
    original,
    edited,
    ime,
  };
  writeFileSync(new URL("summary.json", folder), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
});
