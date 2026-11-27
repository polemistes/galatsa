// SPDX-License-Identifier: GPL-3.0-or-later

// The navigation commands, as an extension built into the editor: zoom in and
// out, actual size, show everything, show the selection, and moving the view
// with the arrow keys. They change only the camera (undoable: false) and use
// nothing but the editor services, like any other extension. The editor loads
// them after the basics and before the program's other extensions, so the
// basics keep their shortcuts and a tool that uses the arrow keys (to nudge a
// selection) gets them first. See docs/adr/0008-camera.md.

import { Resolver, type ElementId, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import { EXTENSION_API_VERSION, messageKey, type Label } from "@galatsa/extension-api";
import {
  defineCommand,
  defineEditExtension,
  defineViewExtension,
  type CommandContext,
  type EditExtension,
  type SceneQuery,
} from "@galatsa/extension-api/editing";
import type { BundleKey } from "@galatsa/i18n";
import { editorMessages } from "./messages/index.ts";

/** The id: its labels are in the editor's message namespace ("editor"), a prefix of it. */
export const NAVIGATION_EXTENSION = "editor.navigation";

/** Command ids. */
export const NAVIGATION = {
  zoomIn: `${NAVIGATION_EXTENSION}/zoom-in`,
  zoomOut: `${NAVIGATION_EXTENSION}/zoom-out`,
  actualSize: `${NAVIGATION_EXTENSION}/actual-size`,
  viewAll: `${NAVIGATION_EXTENSION}/view-all`,
  viewSelection: `${NAVIGATION_EXTENSION}/view-selection`,
  panLeft: `${NAVIGATION_EXTENSION}/pan-left`,
  panRight: `${NAVIGATION_EXTENSION}/pan-right`,
  panUp: `${NAVIGATION_EXTENSION}/pan-up`,
  panDown: `${NAVIGATION_EXTENSION}/pan-down`,
} as const;

/** Zoom step of the zoom-in and zoom-out commands. */
export const ZOOM_STEP = 2;
/** Share of the view the arrow keys move it by. */
export const PAN_STEP = 1 / 8;

function label(key: BundleKey<typeof editorMessages>): Label {
  return messageKey(editorMessages, key);
}

const EVERYWHERE: Rect = {
  x: -Number.MAX_VALUE / 2,
  y: -Number.MAX_VALUE / 2,
  w: Number.MAX_VALUE,
  h: Number.MAX_VALUE,
};

/** The bounds, in root space, of everything at the top level of the canvas; null if empty. */
export function contentBounds(scene: SceneQuery): Rect | null {
  let all: Rect | null = null;
  for (const id of scene.elementsIn(EVERYWHERE, "touching")) {
    const b = scene.bounds(id);
    if (b === null) continue;
    if (all === null) all = b;
    else {
      const x = Math.min(all.x, b.x);
      const y = Math.min(all.y, b.y);
      all = {
        x,
        y,
        w: Math.max(all.x + all.w, b.x + b.w) - x,
        h: Math.max(all.y + all.h, b.y + b.h) - y,
      };
    }
  }
  return all;
}

/**
 * The bounds of elements in the space of their lowest common container, so a
 * selection deep in a frame far from the root is shown exactly; null if none
 * of them is shown.
 */
export function boundsTogether(
  r: Resolver,
  ids: readonly ElementId[],
): { rect: Rect; space: ElementId | null } | null {
  const shown = ids.filter((id) => r.get(id) !== undefined && !r.isGone(id));
  if (shown.length === 0) return null;
  const containers = (id: ElementId): (ElementId | null)[] => {
    const out: (ElementId | null)[] = [];
    const seen = new Set<ElementId>();
    for (let at = r.parentOf(id); at !== null && !seen.has(at); at = r.parentOf(at)) {
      seen.add(at);
      out.push(at);
    }
    out.push(null);
    return out;
  };
  let common = containers(shown[0]!);
  for (const id of shown.slice(1)) {
    const theirs = new Set(containers(id));
    common = common.filter((c) => theirs.has(c));
  }
  const space = common[0] ?? null;
  let rect: Rect | null = null;
  for (const id of shown) {
    const b = r.boundsIn(id, space);
    if (b === null) continue;
    if (rect === null) rect = b;
    else {
      const x = Math.min(rect.x, b.x);
      const y = Math.min(rect.y, b.y);
      rect = {
        x,
        y,
        w: Math.max(rect.x + rect.w, b.x + b.w) - x,
        h: Math.max(rect.y + rect.h, b.y + b.h) - y,
      };
    }
  }
  return rect === null ? null : { rect, space };
}

/** The ids a command is given (`{ ids }`), or the selection. */
function idsOf(ctx: CommandContext, args: unknown): readonly ElementId[] {
  const given = (args as { ids?: unknown } | undefined)?.ids;
  if (Array.isArray(given) && given.every((id) => typeof id === "string"))
    return given as ElementId[];
  return ctx.services.selection.get();
}

function zoomBy(ctx: CommandContext, factor: number): void {
  const view = ctx.services.camera.get();
  // About the centre of the view, which is the camera's centre: it stays.
  ctx.services.camera.set({ ...view, zoom: view.zoom * factor });
}

function panBy(ctx: CommandContext, fx: number, fy: number): void {
  const view = ctx.services.camera.get();
  const shown = ctx.services.camera.viewport();
  ctx.services.camera.set({
    ...view,
    cx: view.cx + fx * shown.w,
    cy: view.cy + fy * shown.h,
  });
}

const zoomIn = defineCommand<unknown, void>({
  name: "zoom-in",
  label: label("nav.zoomIn"),
  // Mod++ is Ctrl and the + key on a Norwegian keyboard (and the keypad's +);
  // on a US keyboard + needs Shift (Mod+Shift++), and Ctrl and = is what
  // browsers use there.
  shortcuts: ["Mod++", "Mod+=", "Mod+Shift++"],
  quick: true,
  undoable: false,
  execute: (ctx) => zoomBy(ctx, ZOOM_STEP),
});

const zoomOut = defineCommand<unknown, void>({
  name: "zoom-out",
  label: label("nav.zoomOut"),
  shortcuts: ["Mod+-"],
  quick: true,
  undoable: false,
  execute: (ctx) => zoomBy(ctx, 1 / ZOOM_STEP),
});

const actualSize = defineCommand<unknown, void>({
  name: "actual-size",
  label: label("nav.actualSize"),
  shortcuts: ["Mod+0"],
  quick: true,
  undoable: false,
  execute(ctx) {
    ctx.services.camera.set({ ...ctx.services.camera.get(), zoom: 1 });
  },
});

const viewAll = defineCommand<unknown, void>({
  name: "view-all",
  label: label("nav.viewAll"),
  shortcuts: ["Shift+1"],
  quick: true,
  undoable: false,
  enabled: (ctx) => contentBounds(ctx.services.scene) !== null,
  execute(ctx) {
    const all = contentBounds(ctx.services.scene);
    if (all !== null) ctx.services.camera.fit(all, null);
  },
});

const viewSelection = defineCommand<unknown, void>({
  name: "view-selection",
  label: label("nav.viewSelection"),
  shortcuts: ["Shift+2"],
  quick: true,
  undoable: false,
  enabled: (ctx, args) =>
    boundsTogether(new Resolver(yLookup(ctx.doc)), idsOf(ctx, args)) !== null,
  execute(ctx, args) {
    const found = boundsTogether(new Resolver(yLookup(ctx.doc)), idsOf(ctx, args));
    if (found !== null) ctx.services.camera.fit(found.rect, found.space);
  },
});

const pan = (
  name: string,
  text: BundleKey<typeof editorMessages>,
  key: string,
  fx: number,
  fy: number,
) =>
  defineCommand<unknown, void>({
    name,
    label: label(text),
    shortcuts: [key],
    quick: true,
    undoable: false,
    execute: (ctx) => panBy(ctx, fx * PAN_STEP, fy * PAN_STEP),
  });

export const navigationViewExtension = defineViewExtension({
  id: NAVIGATION_EXTENSION,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [editorMessages],
});

export const navigationExtension: EditExtension = defineEditExtension({
  view: navigationViewExtension,
  contributes: {
    commands: [
      zoomIn,
      zoomOut,
      actualSize,
      viewAll,
      viewSelection,
      pan("pan-left", "nav.panLeft", "ArrowLeft", -1, 0),
      pan("pan-right", "nav.panRight", "ArrowRight", 1, 0),
      pan("pan-up", "nav.panUp", "ArrowUp", 0, -1),
      pan("pan-down", "nav.panDown", "ArrowDown", 0, 1),
    ],
  },
});
