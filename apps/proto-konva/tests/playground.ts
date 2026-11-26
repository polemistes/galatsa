// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for tests that drive the playground page (edit.html).

import { fileURLToPath } from "node:url";
import { type Page, expect } from "@playwright/test";

export const RESULTS_DIR = fileURLToPath(new URL("../results/", import.meta.url));

export interface TextBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly align: string;
  readonly text: string;
}

export async function openPlayground(page: Page, query = ""): Promise<void> {
  await page.goto(`/edit.html${query}`);
  await expect(page.locator(".stage[data-ready=true]")).toBeVisible({ timeout: 60_000 });
}

/** Id of the text box the camera run zooms in on. */
export async function zoomTargetId(page: Page): Promise<string> {
  return page.evaluate(() => window.protoKonva!.zoomTargetId);
}

/** A text box by id. */
export async function textBox(page: Page, id: string): Promise<TextBox> {
  return page.evaluate((id) => {
    const e = window.protoKonva!.scene.elements.find((x) => x.id === id);
    if (e === undefined || e.kind !== "text") throw new Error(`No text box ${id}`);
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
  }, id);
}

export async function setCamera(
  page: Page,
  pose: { x: number; y: number; zoom: number },
): Promise<void> {
  await page.evaluate((p) => window.protoKonva!.setCamera(p), pose);
}
