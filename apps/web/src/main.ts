// SPDX-License-Identifier: GPL-3.0-or-later

// The web page: starts the editor with the shape, image, text and routes
// extensions on a new, empty presentation (docs/adr/0016), or, with
// `?scene=bench`, on the sample scene (the benchmark scene of bench/ as a
// document, 2,000 elements), which the end-to-end tests and measurements use.
//
// Query parameters: `lang=nb|en` (otherwise the stored choice or the system's
// language), `scene=bench`, `fresh` (with `scene=bench`: a new copy of the
// sample scene instead of the stored one), `mode=advanced`.
//
// `window.galatsaDev` gives tests and the browser console the running program.

import { EditorApp, renderEditorUi, type Editor } from "@galatsa/editor";
import { imageExtension } from "@galatsa/extension-image";
import { routesExtension } from "@galatsa/extension-routes";
import { shapeExtension } from "@galatsa/extension-shape";
import { textExtension } from "@galatsa/extension-text";
import "@galatsa/renderer/fonts.css";
import { browserLocaleStorage, createI18n, isLocale } from "@galatsa/i18n";
import { webMessages } from "./messages/index.ts";

declare global {
  interface Window {
    galatsaDev?: {
      /** Resolves when the program has started (a document is open or offered). */
      readonly ready: Promise<EditorApp>;
      /** The editor of the open document, or null. */
      editor(): Editor | null;
    };
  }
}

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
const i18n = createI18n({
  dev: import.meta.env.DEV,
  storage: browserLocaleStorage(),
  ...(lang !== null && isLocale(lang) ? { locale: lang } : {}),
  bundles: [webMessages],
});
// The language can be changed in the toolbar: the page follows.
const showLanguage = (): void => {
  document.documentElement.lang = i18n.locale;
  document.title = i18n.t("web:page.title");
};
showLanguage();
i18n.subscribe(showLanguage);

const root = document.getElementById("app");
if (root === null) throw new Error("The page has no #app element");

let app: EditorApp | null = null;
const ready = EditorApp.start({
  root,
  i18n,
  // The shape, image and text extensions. The shape, image, text and
  // selection sketches are left out: the extensions replace three of them, and
  // the editor's own selection tool (galatsa.select) is loaded first and is
  // the default tool.
  extensions: [textExtension, shapeExtension, imageExtension, routesExtension],
  createWorker: () =>
    new Worker(new URL("./checkpoint-worker.ts", import.meta.url), { type: "module" }),
  mode: params.get("mode") === "advanced" ? "advanced" : "quick",
  renderUi: renderEditorUi,
  onEditor: (editor) => {
    const surface = root.querySelector<HTMLElement>(".galatsa-canvas");
    surface?.focus({ preventScroll: true });
    editor.invalidate();
  },
  async openDefault(storage) {
    if (params.get("scene") !== "bench") {
      const session = await storage.create();
      return { ok: true, session, notices: [] };
    }
    const { openSampleScene } = await import("./sample-scene.ts");
    return openSampleScene(storage, {
      title: i18n.t("web:sample.title"),
      fresh: params.has("fresh"),
    });
  },
}).then((started) => {
  app = started;
  return started;
});

window.galatsaDev = {
  ready,
  editor: () => app?.state.editor ?? null,
};
