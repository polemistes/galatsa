// SPDX-License-Identifier: GPL-3.0-or-later

// The shape gallery (shapes.html), a development page: every shape kind of the
// shape extension in the same set of cases (shapeGallery), drawn with the real
// renderer, one canvas per kind. tests/e2e/shapes-visual.spec.ts compares each
// canvas with a stored picture, so a new kind gets its screenshot test by
// being listed. The canvases have a device pixel ratio of 1 whatever the
// screen, so the pictures do not depend on it.
//
// `window.galatsaShapeGallery.ready` resolves with the kinds once every canvas
// is drawn. Query parameter: `lang=nb|en`.

import type { Element, ElementId } from "@galatsa/core";
import { ViewHost } from "@galatsa/extension-api";
import {
  GALLERY_CELL,
  SHAPE_KINDS,
  SHAPE_TYPE,
  shapeGallery,
  shapeKinds,
  shapeMessages,
  shapeView,
  shapeViewExtension,
} from "@galatsa/extension-shape/view";
import { browserLocaleStorage, createI18n, isLocale } from "@galatsa/i18n";
import { CanvasRenderer, sceneFromSnapshot } from "@galatsa/renderer";
import { webMessages } from "./messages/index.ts";

declare global {
  interface Window {
    galatsaShapeGallery?: {
      /** Resolves with the kinds, in order, when every canvas is drawn. */
      readonly ready: Promise<string[]>;
    };
  }
}

const lang = new URLSearchParams(location.search).get("lang");
const i18n = createI18n({
  dev: import.meta.env.DEV,
  storage: browserLocaleStorage(),
  ...(lang !== null && isLocale(lang) ? { locale: lang } : {}),
  bundles: [webMessages, shapeMessages],
});
document.documentElement.lang = i18n.locale;
document.title = i18n.t("web:gallery.title");

const root = document.getElementById("gallery");
if (root === null) throw new Error("The page has no #gallery element");

const host = new ViewHost();
const problems = host.load([shapeViewExtension]);
if (problems.length > 0) throw new Error(problems.map((p) => p.detail).join("; "));

/** Draws one kind's cases side by side and returns its canvas. */
function drawKind(kind: (typeof SHAPE_KINDS)[number]): HTMLCanvasElement {
  const cases = shapeGallery(shapeKinds, kind);
  const width = cases.length * GALLERY_CELL;
  const height = GALLERY_CELL;
  const elements: { [id: ElementId]: Element } = {};
  cases.forEach((c, index) => {
    elements[`${kind.kind}-${index}`] = {
      type: SHAPE_TYPE,
      typeVersion: shapeView.typeVersion,
      order: `a${String(index).padStart(4, "0")}`,
      parent: null,
      pos: { x: index * GALLERY_CELL + c.x, y: c.y, space: null },
      rebase: null,
      name: "",
      locked: false,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [],
      ext: {},
      data: c.data,
      size: { w: c.w, h: c.h },
      rot: c.rot,
    } as Element;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.dataset["kind"] = kind.kind;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("No 2D canvas context");
  const renderer = new CanvasRenderer({ host, background: "#ffffff" });
  renderer.attach(ctx, { width, height, devicePixelRatio: 1 });
  renderer.setScene(sceneFromSnapshot({ elements }));
  renderer.setCamera({ space: null, cx: width / 2, cy: height / 2, zoom: 1 });
  renderer.render();
  return canvas;
}

const ready = (async () => {
  for (const kind of SHAPE_KINDS) {
    const heading = document.createElement("h2");
    heading.textContent = i18n.t(kind.label);
    root.append(heading, drawKind(kind));
  }
  return SHAPE_KINDS.map((k) => k.kind);
})();

window.galatsaShapeGallery = { ready };
