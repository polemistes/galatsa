// SPDX-License-Identifier: GPL-3.0-or-later

// In-place text editing on the development page (apps/web) in a real browser
// (docs/adr/0011-text.md): the text tool makes a box and starts editing; keys
// go to the text, not the canvas (Space and Shift+1 do not move the camera);
// Enter makes a paragraph; Ctrl+B makes the selection bold; Ctrl+Z and
// Ctrl+Shift+Z undo and redo while editing; pasting from the system clipboard;
// composed characters (an input method); Escape ends editing and selects the
// box; Enter and a double click edit it again; a pinch that began with the
// press that made the box takes the box back. Runs in the "chromium",
// "editor-firefox" and, where Playwright's WebKit can run, "editor-webkit"
// projects. Input methods are driven through Chromium's DevTools protocol in
// Chromium; elsewhere the test sends the composition events and changes the
// element as a browser does, which tests the program's handling but not the
// browser's.

import { expect, test, type Page } from "@playwright/test";
import { delta, frames, openEmpty, textState } from "./text-support.ts";

const editing = (page: Page) => page.locator(".galatsa-text-edit");

/** Makes a text box with the text tool at a point of the canvas. */
async function newBox(page: Page, x: number, y: number): Promise<string> {
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  await surface.focus();
  const before = (await textState(page)).texts.length;
  await page.keyboard.press("t");
  await page.mouse.click(box.x + x, box.y + y);
  await expect.poll(async () => (await textState(page)).texts.length).toBe(before + 1);
  await expect(editing(page)).toBeFocused();
  return (await textState(page)).editing!;
}

test("text is typed, formatted, undone and pasted in place, and keys stay in the text", async ({
  page,
  browserName,
}) => {
  const errors = await openEmpty(page);
  const id = await newBox(page, 200, 200);
  const start = await textState(page);
  expect(start.selection).toEqual([]);

  // Space and Shift+1 are text here, not the hand and "show everything".
  await page.keyboard.type("Hello world! ");
  await page.keyboard.press("Shift+Digit1");
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  let state = await textState(page);
  expect(state.texts.find((t) => t.id === id)!.text).toBe(
    "Hello world! ! \nsecond line\n",
  );
  expect([state.zoom, state.cx, state.cy]).toEqual([start.zoom, start.cx, start.cy]);
  // The box grew with its second line.
  expect(state.texts[0]!.h).toBeGreaterThan(start.texts[0]!.h * 1.9);
  // The element shows the same text, line by line.
  await expect(editing(page).locator("div")).toHaveText([
    "Hello world! ! ",
    "second line",
  ]);

  // Bold for a selection: Shift+Home selects back to the start of the line.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("ControlOrMeta+b");
  await expect
    .poll(() => delta(page, id))
    .toEqual([
      { insert: "Hello world! ! \n" },
      { insert: "second line", attributes: { bold: true } },
      { insert: "\n" },
    ]);
  await expect(editing(page).locator("div").nth(1).locator("span")).toHaveCSS(
    "font-weight",
    "700",
  );

  // Undo takes back the bold, then the typing; redo brings the typing back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => delta(page, id))
    .toEqual([{ insert: "Hello world! ! \nsecond line\n" }]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await textState(page)).texts[0]!.text).toBe("\n");
  expect((await textState(page)).editing).toBe(id);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text)
    .toBe("Hello world! ! \nsecond line\n");

  // Paste: copy "second" from the text itself and paste it at the end, through
  // the system clipboard; then a paste event with text from elsewhere.
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+v");
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text)
    .toBe("Hello world! ! \nsecond linese\n");
  await editing(page).evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", " pasted\r\nlines");
    const paste = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    // Firefox empties the data of a paste event made by a page; the
    // editing element also takes a paste as the input event that follows.
    el.dispatchEvent(
      paste.clipboardData?.getData("text/plain")
        ? paste
        : new InputEvent("beforeinput", {
            inputType: "insertFromPaste",
            dataTransfer: data,
            bubbles: true,
            cancelable: true,
          }),
    );
  });
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text)
    .toBe("Hello world! ! \nsecond linese pasted\nlines\n");

  // Composition (an input method): the composed text is written once, at the end.
  const before = await textState(page);
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "ka",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await cdp.send("Input.imeSetComposition", {
      text: "かな",
      selectionStart: 2,
      selectionEnd: 2,
    });
    // Nothing is written while composing.
    expect((await textState(page)).texts[0]!.text).toBe(before.texts[0]!.text);
    await cdp.send("Input.insertText", { text: "仮名" });
  } else {
    await editing(page).evaluate((el) => {
      const sel = document.getSelection()!;
      const node = sel.focusNode as Text;
      const at = sel.focusOffset;
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { data: "", bubbles: true }),
      );
      for (const step of ["k", "か", "仮名"]) {
        node.data =
          node.data.slice(0, at) +
          step +
          node.data.slice(at + (step === "k" ? 0 : step === "か" ? 1 : 1));
        el.dispatchEvent(
          new InputEvent("input", {
            inputType: "insertCompositionText",
            data: step,
            isComposing: true,
            bubbles: true,
          }),
        );
      }
      el.dispatchEvent(
        new CompositionEvent("compositionend", { data: "仮名", bubbles: true }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertCompositionText",
          data: "仮名",
          bubbles: true,
        }),
      );
    });
  }
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text)
    .toBe("Hello world! ! \nsecond linese pasted\nlines仮名\n");
  // One undo takes the composed text back whole.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text)
    .toBe("Hello world! ! \nsecond linese pasted\nlines\n");

  // Escape ends editing and selects the box; Enter edits it again.
  await page.keyboard.press("Escape");
  await expect(editing(page)).toHaveCount(0);
  state = await textState(page);
  expect(state.editing).toBe(null);
  expect(state.selection).toEqual([id]);
  await page.keyboard.press("Enter");
  await expect(editing(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editing(page)).toHaveCount(0);

  // A double click on the text edits it, with the caret where it was clicked.
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  await page.mouse.dblclick(box.x + 205, box.y + 200);
  await expect(editing(page)).toBeFocused();
  await page.keyboard.type("X");
  await expect
    .poll(async () => (await textState(page)).texts[0]!.text.startsWith("X"))
    .toBe(true);
  await page.keyboard.press("Escape");

  // A click on empty canvas with the text tool, left empty, leaves nothing.
  const steps = (await textState(page)).undoSteps;
  await newBox(page, 600, 450);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textState(page)).texts.length).toBe(1);
  expect((await textState(page)).undoSteps).toBe(steps);

  expect(errors).toEqual([]);
});

/** Pointer events as a touch screen sends them, dispatched on the canvas. */
async function touch(
  page: Page,
  type: "pointerdown" | "pointerup",
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
          button: 0,
          buttons: kind === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [type, id, x, y] as const,
  );
}

test("a pinch that began with the press that made a text box takes it back", async ({
  page,
}) => {
  const errors = await openEmpty(page);
  // A text box to keep, typed into.
  const kept = await newBox(page, 150, 150);
  await page.keyboard.type("kept");
  await page.keyboard.press("Escape");
  const before = await textState(page);
  await page.locator(".galatsa-canvas").focus();
  await page.keyboard.press("t");
  await touch(page, "pointerdown", 1, 400, 300);
  await expect.poll(async () => (await textState(page)).texts.length).toBe(2);
  await expect(editing(page)).toHaveCount(1);
  await touch(page, "pointerdown", 2, 500, 300);
  await touch(page, "pointerup", 2, 500, 300);
  await touch(page, "pointerup", 1, 400, 300);
  await expect(editing(page)).toHaveCount(0);
  const after = await textState(page);
  expect(after.texts.map((t) => [t.id, t.text])).toEqual([[kept, "kept\n"]]);
  expect(after.undoSteps).toBe(before.undoSteps);
  await frames(page);
  expect(errors).toEqual([]);
});
