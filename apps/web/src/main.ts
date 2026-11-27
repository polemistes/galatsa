// SPDX-License-Identifier: GPL-3.0-or-later

// The development page: starts the editor with the shape and image extensions
// and the text sketch, on the
// sample scene (the benchmark scene as a document) or, with `?scene=empty`, on
// a new empty document.
//
// Query parameters: `lang=nb|en` (otherwise the stored choice or the system's
// language), `scene=empty`, `fresh` (a new copy of the sample scene instead of
// the stored one), `mode=advanced`.
//
// `window.galatsaDev` gives tests and the browser console the running program.

import { EditorApp, renderEditorUi, type Editor } from "@galatsa/editor";
import { textExtension } from "@galatsa/extension-examples";
import { imageExtension } from "@galatsa/extension-image";
import { shapeExtension } from "@galatsa/extension-shape";
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
document.documentElement.lang = i18n.locale;
document.title = i18n.t("web:page.title");

const root = document.getElementById("app");
if (root === null) throw new Error("The page has no #app element");

let app: EditorApp | null = null;
const ready = EditorApp.start({
  root,
  i18n,
  // The shape and image extensions and the text sketch. The shape, image and
  // selection sketches are left out: the extensions replace two of them, and
  // the editor's own selection tool (galatsa.select) is loaded first and is
  // the default tool.
  extensions: [textExtension, shapeExtension, imageExtension],
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
    if (params.get("scene") === "empty") {
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
