// SPDX-License-Identifier: GPL-3.0-or-later

// More of in-place text editing (docs/adr/0011-text.md), from the review:
// text being composed survives a change of the box by someone else and the
// end of editing; a double click puts the caret where it was clicked; typing
// does not make the renderer keep a layout per key; copying gives plain text
// and plain HTML; a pasted tab becomes a space; Ctrl and = zooms the canvas,
// not the page. Runs where text-edit.spec.ts runs. Composition is driven
// through Chromium's DevTools protocol in Chromium and by events elsewhere.

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { openEmpty, textState, type Dev, type DevEditor } from "./text-support.ts";

const editing = (page: Page) => page.locator(".galatsa-text-edit");

async function newBox(page: Page, x: number, y: number): Promise<string> {
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  await surface.focus();
  await page.keyboard.press("t");
  await page.mouse.click(box.x + x, box.y + y);
  await expect(editing(page)).toBeFocused();
  return (await textState(page)).editing!;
}

async function textOf(page: Page, id: string): Promise<string> {
  return (await textState(page)).texts.find((t) => t.id === id)?.text ?? "";
}

/** Starts or continues a composition showing `text` at the caret. */
async function compose(page: Page, cdp: CDPSession | null, text: string): Promise<void> {
  if (cdp !== null) {
    await cdp.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    return;
  }
  await editing(page).evaluate((el, shown) => {
    const state = el as HTMLElement & {
      composing?: { node: Text; at: number; length: number };
    };
    if (state.composing === undefined) {
      const sel = document.getSelection()!;
      state.composing = { node: sel.focusNode as Text, at: sel.focusOffset, length: 0 };
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { data: "", bubbles: true }),
      );
    }
    const c = state.composing;
    c.node.data = c.node.data.slice(0, c.at) + shown + c.node.data.slice(c.at + c.length);
    c.length = shown.length;
    el.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: shown,
        isComposing: true,
        bubbles: true,
      }),
    );
  }, text);
}

/** Ends a composition with `text`. */
async function commit(page: Page, cdp: CDPSession | null, text: string): Promise<void> {
  if (cdp !== null) {
    await cdp.send("Input.insertText", { text });
    return;
  }
  await compose(page, null, text);
  await editing(page).evaluate((el, shown) => {
    delete (el as HTMLElement & { composing?: unknown }).composing;
    el.dispatchEvent(
      new CompositionEvent("compositionend", { data: shown, bubbles: true }),
    );
    el.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: shown,
        bubbles: true,
      }),
    );
  }, text);
}

test("text being composed survives others' changes and the end of editing", async ({
  page,
  browserName,
}) => {
  const errors = await openEmpty(page);
  const cdp =
    browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  const id = await newBox(page, 200, 200);
  await page.keyboard.type("start");
  await compose(page, cdp, "かな");
  // Someone else changes the box's size and colour while the user composes.
  await page.evaluate((elementId) => {
    const editor = (window as unknown as Dev).galatsaDev.editor() as DevEditor;
    editor.run("galatsa.text/set-style", {
      ids: [elementId],
      key: "fontSize",
      value: 40,
    });
    editor.run("galatsa.text/set-style", {
      ids: [elementId],
      key: "color",
      value: "#aa0000",
    });
  }, id);
  await expect(editing(page)).toContainText("かな");
  await commit(page, cdp, "仮名");
  await expect.poll(() => textOf(page, id)).toBe("start仮名\n");
  await expect(editing(page).locator("span").first()).toHaveCSS(
    "color",
    "rgb(170, 0, 0)",
  );

  // Editing ends while the user composes (input turned off, as when the
  // document closes): what was composed is kept.
  await compose(page, cdp, "かな");
  await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor() as DevEditor & {
      setInputEnabled(on: boolean): void;
    };
    editor.setInputEnabled(false);
    editor.setInputEnabled(true);
  });
  await expect(editing(page)).toHaveCount(0);
  await expect.poll(() => textOf(page, id)).toBe("start仮名かな\n");
  expect(errors).toEqual([]);
});

test("a double click puts the caret where it was clicked", async ({ page }) => {
  const errors = await openEmpty(page);
  const id = await page.evaluate(() => {
    const editor = (window as unknown as Dev).galatsaDev.editor() as DevEditor;
    const outcome = editor.run("galatsa.text/insert", {
      x: -300,
      y: -100,
      w: 800,
      fontSize: 40,
      text: "alpha beta gamma delta",
    });
    editor.services.selection.set([]);
    return outcome.value as string;
  });
  // Where "m" of "gamma" is on screen, from the editing element.
  await page.evaluate((elementId) => {
    ((window as unknown as Dev).galatsaDev.editor() as DevEditor).editText(elementId);
  }, id);
  const at = await editing(page).evaluate((el) => {
    const node = el.querySelector("span")!.firstChild as Text;
    const index = node.data.indexOf("gamma") + 2;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const r = range.getBoundingClientRect();
    return { x: r.left + 2, y: r.top + r.height / 2 };
  });
  await page.keyboard.press("Escape");
  await expect(editing(page)).toHaveCount(0);
  await page.mouse.dblclick(at.x, at.y);
  await expect(editing(page)).toBeFocused();
  await page.keyboard.type("X");
  await expect.poll(() => textOf(page, id)).toBe("alpha beta gaXmma delta\n");
  expect(errors).toEqual([]);
});

test("typing keeps few layouts; copy gives plain text and plain HTML; tabs and zoom", async ({
  page,
}) => {
  const errors = await openEmpty(page);
  const id = await newBox(page, 200, 200);
  // Each key is a new text; the renderer keeps only a few layouts for it.
  await page.keyboard.type("The quick brown fox jumps over the lazy dog. ".repeat(4));
  const count = await page.evaluate(
    () =>
      (
        (window as unknown as Dev).galatsaDev.editor() as {
          renderer: { textLayoutCount: number };
        }
      ).renderer.textLayoutCount,
  );
  expect(count).toBeLessThanOrEqual(4);

  // Copy: the selection as plain text and as HTML without the element's sizes.
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  const copied = await editing(page).evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
  });
  // Firefox empties a page's own clipboard events (see text-edit.spec.ts).
  if (copied.text !== "") {
    expect(copied.text).toBe("The");
    expect(copied.html).toBe("<p>The</p>");
  }

  // A pasted tab becomes a space, as the canvas would draw it.
  await page.keyboard.press("ControlOrMeta+End");
  await editing(page).evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "a\tb");
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertFromPaste",
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(async () => (await textOf(page, id)).endsWith("a b\n")).toBe(true);

  // Ctrl and = zooms the canvas, not the page.
  const zoom = (await textState(page)).zoom;
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(async () => (await textState(page)).zoom).toBeCloseTo(zoom * 2, 6);
  await expect(editing(page)).toBeFocused();
  expect(errors).toEqual([]);
});
