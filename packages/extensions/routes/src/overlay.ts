// SPDX-License-Identifier: GPL-3.0-or-later

// The route on the canvas, while the routes panel is open: the outline of
// what each stop shows, a line through their centres in playing order, and a
// numbered mark at each centre. The chosen stop is drawn stronger. Sizes are
// in screen pixels whatever the zoom. Drawn in root space, like a tool's
// preview (docs/adr/0013-routes-and-stops.md).

import { Resolver, regionToWorld, stopRegion, type Rect } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import type { CommandContext, OverlayDefinition } from "@galatsa/extension-api/editing";
import { ROUTES_PANEL } from "./commands.ts";
import { readRoutes, routeSteps } from "./model.ts";
import { currentChoice } from "./state.ts";

const LINE = "#7c3aed";
const CHOSEN = "#db2777";
/** Radius of the numbered mark, in CSS pixels. */
const MARK = 10;

/** The regions of the steps of the route shown, in root space, and which step is chosen. */
export function routeShapes(context: CommandContext): {
  readonly rects: readonly (Rect | null)[];
  readonly chosen: number;
} {
  const sr = readRoutes(context.doc);
  const choice = currentChoice(context.doc, sr);
  if (choice.route === null) return { rects: [], chosen: -1 };
  const steps = routeSteps(sr, choice.route);
  const r = new Resolver(yLookup(context.doc));
  const rects = steps.map((step) => {
    const region = stopRegion(sr, r, step.stop);
    return region === null ? null : regionToWorld(r, region);
  });
  return { rects, chosen: steps.findIndex((step) => step.entry === choice.entry) };
}

export const routeOverlay: OverlayDefinition = {
  name: "route",
  quick: true,
  visible: (context) => context.services.panels.isOpen(ROUTES_PANEL),
  draw(ctx, context) {
    const { rects, chosen } = routeShapes(context);
    if (rects.length === 0) return;
    // One CSS pixel in root units: the camera's zoom is CSS pixels per unit.
    const px = 1 / context.services.camera.get().zoom;
    rects.forEach((rect, i) => {
      if (rect === null) return;
      const outline = ctx.createPath();
      outline.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.stroke(
        outline,
        i === chosen
          ? { color: CHOSEN, width: 2 * px }
          : { color: LINE, width: px, dash: [6 * px, 4 * px] },
      );
    });
    const centres = rects.map((rect) =>
      rect === null ? null : { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    );
    const line = ctx.createPath();
    let started = false;
    for (const c of centres) {
      if (c === null) continue;
      if (started) line.lineTo(c.x, c.y);
      else line.moveTo(c.x, c.y);
      started = true;
    }
    ctx.stroke(line, { color: LINE, width: 2 * px, join: "round", cap: "round" });
    centres.forEach((c, i) => {
      if (c === null) return;
      const mark = ctx.createPath();
      mark.arc(c.x, c.y, MARK * px, 0, Math.PI * 2);
      ctx.fill(mark, i === chosen ? CHOSEN : LINE);
      const text = ctx.layoutText(
        String(i + 1),
        {
          fontFamily: "system-ui, sans-serif",
          fontSize: 11 * px,
          color: "#ffffff",
          align: "center",
          bold: true,
        },
        2 * MARK * px,
      );
      ctx.drawText(text, c.x - MARK * px, c.y - text.height / 2);
    });
  },
};
