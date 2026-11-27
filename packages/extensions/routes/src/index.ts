// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-routes: routes and stops in the editor, as a built-in
// extension against the same interface as the others. Commands over the
// document's stop and route operations, a panel (Svelte) to work with them,
// the route drawn on the canvas, and jumps to a stop along its transition.
// A viewer imports "@galatsa/extension-routes/view", which has only the
// viewing part (its messages): playing routes is the player's. See
// docs/adr/0013-routes-and-stops.md.

// The editor's Svelte binding for custom panels (CustomPanelViews.svelte).
import type { PanelProps } from "@galatsa/editor";
import { messageKey } from "@galatsa/extension-api";
import { defineEditExtension, type EditExtension } from "@galatsa/extension-api/editing";
import type { Component } from "svelte";
import { routesCommands } from "./commands.ts";
import { routeOverlay } from "./overlay.ts";
import RoutesPanel from "./RoutesPanel.svelte";
import { routesMessages, routesViewExtension } from "./view.ts";

export {
  FRAME_STOP_PADDING,
  ROUTES,
  ROUTES_PANEL,
  routesCommandEnabled,
  textChange,
  type AddedStop,
  type AddRouteArgs,
  type EntryArgs,
  type FramesArgs,
  type GoToArgs,
  type MoveVisitArgs,
  type NotesArgs,
  type PlaceArgs,
  type RenameRouteArgs,
  type RenameStopArgs,
  type RouteArgs,
  type StopArgs,
  type VisibilityArgs,
  type VisitArgs,
} from "./commands.ts";
export {
  browserJumpEnvironment,
  jumpTo,
  planJump,
  stopJump,
  type FrameScheduler,
  type JumpEnvironment,
} from "./jump.ts";
export {
  cameraForRegion,
  entryOrder,
  indexAfter,
  isLiveRoute,
  isLiveStop,
  liveStops,
  moveIndex,
  readRoutes,
  regionOf,
  routesUsing,
  screenOf,
  viewOfCamera,
  type StopsAndRoutes,
} from "./model.ts";
export { routeOverlay, routeShapes } from "./overlay.ts";
export {
  choose,
  currentChoice,
  storedChoice,
  watchChoice,
  type RouteChoice,
} from "./state.ts";
export { ROUTES_EXTENSION, routesMessages, routesViewExtension } from "./view.ts";

const panelView: Component<PanelProps> = RoutesPanel;

export const routesExtension: EditExtension = defineEditExtension({
  view: routesViewExtension,
  contributes: {
    commands: routesCommands,
    panels: [
      {
        name: "routes",
        label: messageKey(routesMessages, "panel"),
        quick: true,
        location: "side",
        content: { kind: "custom", binding: "svelte", view: panelView },
      },
    ],
    overlays: [routeOverlay],
  },
});
