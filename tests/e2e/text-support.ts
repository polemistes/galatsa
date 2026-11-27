// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for the text tests (text-edit.spec.ts, text-visual.spec.ts): the
// development page with an empty document, and what its editor holds.

import { expect, type Page } from "@playwright/test";
import { WEB_PORT } from "./playwright.config.ts";

export const EMPTY = `http://localhost:${WEB_PORT}/?scene=empty&lang=en`;
export const TEXT_TYPE = "galatsa.text/text";

/** The parts of the page's editor the tests read. */
export interface DevEditor {
  readonly doc: {
    getMap(name: string): {
      get(id: string): {
        get(key: string): {
          get(key: string): {
            toString(): string;
            toDelta(): unknown[];
            format(i: number, n: number, a: object): void;
          };
        };
        toJSON(): { size: { w: number; h: number } };
      };
    };
    transact(fn: () => void, origin?: unknown): void;
  };
  readonly live: {
    ids(): Iterable<string>;
    get(id: string): { type: string } | undefined;
    isGone(id: string): boolean;
  };
  readonly undo: { undoStack: unknown[] };
  readonly camera: { zoom: number; cx: number; cy: number };
  readonly selection: readonly string[];
  readonly textEdit: { id: string | null };
  readonly tools: { current: string | null };
  readonly renderer: { setOverlay(draw: null): void };
  readonly services: {
    camera: { set(view: object): void };
    selection: { set(ids: string[]): void };
  };
  run(command: string, args?: unknown): { ok: boolean; value?: unknown };
  editText(id: string): boolean;
}

declare global {
  interface Window {
    galatsaDev?: { editor(): unknown };
  }
}

/** Opens the development page on an empty document and waits for the editor. */
export async function openEmpty(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(EMPTY);
  await page.waitForFunction(() => Boolean(window.galatsaDev?.editor()), null, {
    timeout: 90_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".galatsa-canvas")).toBeVisible();
  return errors;
}

/** The text boxes of the document and their text, the edited one, and the undo steps. */
export async function textState(page: Page): Promise<{
  texts: { id: string; text: string; h: number }[];
  editing: string | null;
  undoSteps: number;
  zoom: number;
  cx: number;
  cy: number;
  selection: readonly string[];
}> {
  return page.evaluate((type) => {
    const editor = window.galatsaDev!.editor() as DevEditor;
    const texts = [...editor.live.ids()]
      .filter((id) => !editor.live.isGone(id) && editor.live.get(id)?.type === type)
      .map((id) => {
        const record = editor.doc.getMap("elements").get(id);
        return {
          id,
          text: record.get("data").get("text").toString(),
          h: record.toJSON().size.h,
        };
      });
    return {
      texts,
      editing: editor.textEdit.id,
      undoSteps: editor.undo.undoStack.length,
      zoom: editor.camera.zoom,
      cx: editor.camera.cx,
      cy: editor.camera.cy,
      selection: editor.selection,
    };
  }, TEXT_TYPE);
}

/** The shared text of a text box as a delta. */
export async function delta(page: Page, id: string): Promise<unknown[]> {
  return page.evaluate((elementId) => {
    const editor = window.galatsaDev!.editor() as DevEditor;
    return editor.doc.getMap("elements").get(elementId).get("data").get("text").toDelta();
  }, id);
}

/** Waits for two frames, so the canvas shows the last change. */
export async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}
