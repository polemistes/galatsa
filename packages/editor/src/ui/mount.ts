// SPDX-License-Identifier: GPL-3.0-or-later

// Puts the editor's Svelte interface into the page.

import { mount, unmount } from "svelte";
import type { EditorApp } from "../app.ts";
import EditorUi from "./EditorUi.svelte";

/** Draws the editor's interface into `container`; returns how to remove it. */
export function renderEditorUi(app: EditorApp, container: HTMLElement): () => void {
  const ui = mount(EditorUi, { target: container, props: { app } });
  return () => {
    void unmount(ui);
  };
}
