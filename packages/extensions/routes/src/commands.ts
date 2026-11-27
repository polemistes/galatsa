// SPDX-License-Identifier: GPL-3.0-or-later

// The commands of the routes extension, over the stop and route operations of
// @galatsa/core (docs/adr/0001, section 6). Each command that changes the
// document is one undo step (docs/adr/0005, section 4.2); jumping to a stop
// and showing the panel change only the camera and the editor. Arguments are
// plain JSON values and are checked in `enabled` as well as in `execute`.
// See docs/adr/0013-routes-and-stops.md.

import {
  FRAME_TYPE,
  Resolver,
  type ElementId,
  type RouteEntryId,
  type RouteId,
  type StopId,
  type TextRun,
} from "@galatsa/core";
import {
  addRoute,
  addStop,
  edit,
  insertRouteEntry,
  moveRouteEntry,
  removeRoute,
  removeRouteEntry,
  removeStop,
  renameRoute,
  renameStop,
  setStopTransition,
  setRouteEntryStop,
  setStopView,
  setVisibility,
  stopNotes,
  yLookup,
} from "@galatsa/core/ydoc";
import { messageKey, type Label } from "@galatsa/extension-api";
import { defineCommand, type CommandContext } from "@galatsa/extension-api/editing";
import type { BundleKey } from "@galatsa/i18n";
import { jumpTo, type JumpEnvironment } from "./jump.ts";
import { routesMessages } from "./messages/index.ts";
import { ROUTES_EXTENSION } from "./view.ts";
import {
  entryOrder,
  indexAfter,
  isLiveRoute,
  isLiveStop,
  moveIndex,
  readRoutes,
  regionOf,
  routeSteps,
  viewOfCamera,
  type StopsAndRoutes,
} from "./model.ts";
import { choose, currentChoice } from "./state.ts";

export { ROUTES_EXTENSION };

/** Command ids. */
export const ROUTES = {
  togglePanel: `${ROUTES_EXTENSION}/toggle-panel`,
  addRoute: `${ROUTES_EXTENSION}/add-route`,
  renameRoute: `${ROUTES_EXTENSION}/rename-route`,
  deleteRoute: `${ROUTES_EXTENSION}/delete-route`,
  addStopFromView: `${ROUTES_EXTENSION}/add-stop-from-view`,
  addStopsFromFrames: `${ROUTES_EXTENSION}/add-stops-from-frames`,
  addVisit: `${ROUTES_EXTENSION}/add-visit`,
  moveVisit: `${ROUTES_EXTENSION}/move-visit`,
  removeVisit: `${ROUTES_EXTENSION}/remove-visit`,
  deleteStop: `${ROUTES_EXTENSION}/delete-stop`,
  renameStop: `${ROUTES_EXTENSION}/rename-stop`,
  setStopNotes: `${ROUTES_EXTENSION}/set-stop-notes`,
  updateStopView: `${ROUTES_EXTENSION}/update-stop-view`,
  copyStopForRoute: `${ROUTES_EXTENSION}/copy-stop-for-route`,
  setVisibility: `${ROUTES_EXTENSION}/set-visibility`,
  goToStop: `${ROUTES_EXTENSION}/go-to-stop`,
} as const;

/** The panel's id. */
export const ROUTES_PANEL = `${ROUTES_EXTENSION}/routes`;

/** A frame stop shows the frame with this margin, as a share of its larger side. */
export const FRAME_STOP_PADDING = 0;

function label(key: BundleKey<typeof routesMessages>): Label {
  return messageKey(routesMessages, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** The route to add to: the given one (it must be there), or the one shown, or none yet. */
function routeFor(
  ctx: CommandContext,
  sr: StopsAndRoutes,
  given: unknown,
): RouteId | null | undefined {
  if (given !== undefined && given !== null)
    return isLiveRoute(sr, given) ? given : undefined;
  return currentChoice(ctx.doc, sr).route;
}

/** Where a new visit goes: after `after` if given, else after the chosen step, else last. */
function afterFor(
  ctx: CommandContext,
  sr: StopsAndRoutes,
  route: RouteId | null,
  given: unknown,
): RouteEntryId | null {
  if (route === null) return null;
  if (isString(given)) return given;
  const choice = currentChoice(ctx.doc, sr);
  return choice.route === route ? choice.entry : null;
}

/** An entry of a route that is there. */
function isEntryOf(sr: StopsAndRoutes, route: unknown, entry: unknown): boolean {
  return (
    isLiveRoute(sr, route) && isString(entry) && entryOrder(sr, route).includes(entry)
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface AddRouteArgs {
  readonly name?: string;
}

const addRouteCommand = defineCommand<AddRouteArgs | undefined, RouteId>({
  name: "add-route",
  label: label("add-route"),
  undoLabel: label("add-route.step"),
  quick: true,
  enabled: (_ctx, args) =>
    args === undefined || (isRecord(args) && optionalString(args.name)),
  execute(ctx, args) {
    const id = addRoute(ctx.doc, args?.name ? { name: args.name } : {});
    choose(ctx.doc, { route: id, entry: null });
    return id;
  },
});

export interface RouteArgs {
  readonly route: RouteId;
}

export interface RenameRouteArgs extends RouteArgs {
  readonly name: string;
}

const renameRouteCommand = defineCommand<RenameRouteArgs, void>({
  name: "rename-route",
  label: label("rename-route"),
  undoLabel: label("rename-route.step"),
  quick: true,
  // Also a removed route: a name typed while another user deleted the route
  // is saved, and the route stays (docs/adr/0001, section 6.5).
  enabled: (ctx, args) =>
    isRecord(args) &&
    isString(args.name) &&
    isString(args.route) &&
    Object.hasOwn(readRoutes(ctx.doc).routes, args.route),
  execute(ctx, { route, name }) {
    renameRoute(ctx.doc, route, name);
  },
});

const deleteRouteCommand = defineCommand<RouteArgs, void>({
  name: "delete-route",
  label: label("delete-route"),
  undoLabel: label("delete-route.step"),
  quick: true,
  enabled: (ctx, args) => isRecord(args) && isLiveRoute(readRoutes(ctx.doc), args.route),
  execute(ctx, { route }) {
    removeRoute(ctx.doc, route);
  },
});

// ---------------------------------------------------------------------------
// Stops and visits
// ---------------------------------------------------------------------------

/** Where a new stop or visit goes. Without `route`, the route shown (a new one if there is none). */
export interface PlaceArgs {
  readonly route?: RouteId;
  /** The new visit comes right after this entry; default: after the chosen step, or last. */
  readonly after?: RouteEntryId;
}

export interface AddedStop {
  readonly route: RouteId;
  readonly stop: StopId;
  readonly entry: RouteEntryId;
}

function placeArgsOk(ctx: CommandContext, args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args) || !optionalString(args.after)) return false;
  return routeFor(ctx, readRoutes(ctx.doc), args.route) !== undefined;
}

/**
 * The route to add to (made in this step when there is none) and the entry
 * the new visit comes after.
 */
function place(
  ctx: CommandContext,
  args: PlaceArgs | undefined,
): { route: RouteId; after: RouteEntryId | null } {
  const sr = readRoutes(ctx.doc);
  const route = routeFor(ctx, sr, args?.route);
  if (route === undefined) throw new Error("No such route");
  const after = afterFor(ctx, sr, route, args?.after);
  return { route: route ?? addRoute(ctx.doc), after };
}

function visit(
  ctx: CommandContext,
  route: RouteId,
  stop: StopId,
  after: RouteEntryId | null,
): RouteEntryId {
  const sr = readRoutes(ctx.doc);
  const entry = insertRouteEntry(ctx.doc, route, stop, {
    index: indexAfter(sr, route, after),
  });
  choose(ctx.doc, { route, entry });
  return entry;
}

const addStopFromView = defineCommand<PlaceArgs | undefined, AddedStop>({
  name: "add-stop-from-view",
  label: label("add-stop-from-view"),
  undoLabel: label("add-stop-from-view.step"),
  quick: true,
  enabled: (ctx, args) => placeArgsOk(ctx, args),
  execute(ctx, args) {
    const { route, after } = place(ctx, args);
    const stop = addStop(ctx.doc, { view: viewOfCamera(ctx.doc, ctx.services) });
    return { route, stop, entry: visit(ctx, route, stop, after) };
  },
});

export interface FramesArgs extends PlaceArgs {
  /** Frames to make stops of; default: the selected frames. */
  readonly ids?: readonly ElementId[];
}

/** The frames among the ids (or the selection) that the user sees. */
function framesOf(ctx: CommandContext, ids: unknown): ElementId[] {
  const list: unknown = ids ?? ctx.services.selection.get();
  if (!Array.isArray(list)) return [];
  const r = new Resolver(yLookup(ctx.doc));
  return [...new Set(list)].filter(
    (id): id is ElementId =>
      isString(id) && r.get(id)?.type === FRAME_TYPE && !r.isGone(id),
  );
}

const addStopsFromFrames = defineCommand<FramesArgs | undefined, AddedStop[]>({
  name: "add-stops-from-frames",
  label: label("add-stops-from-frames"),
  undoLabel: label("add-stops-from-frames.step"),
  quick: true,
  enabled: (ctx, args) =>
    placeArgsOk(ctx, args) &&
    (args?.ids === undefined || Array.isArray(args.ids)) &&
    framesOf(ctx, args?.ids).length > 0,
  execute(ctx, args) {
    const frames = framesOf(ctx, args?.ids);
    if (frames.length === 0) throw new Error("No frames");
    const placed = place(ctx, args);
    const route = placed.route;
    let after = placed.after;
    const out: AddedStop[] = [];
    for (const frame of frames) {
      const stop = addStop(ctx.doc, {
        view: { kind: "frame", frame, padding: FRAME_STOP_PADDING },
      });
      const entry = visit(ctx, route, stop, after);
      after = entry;
      out.push({ route, stop, entry });
    }
    return out;
  },
});

export interface VisitArgs extends PlaceArgs {
  readonly stop: StopId;
}

/** Adds a visit to a stop that exists: the stop is then shared by the routes that visit it. */
const addVisit = defineCommand<VisitArgs, AddedStop>({
  name: "add-visit",
  label: label("add-visit"),
  undoLabel: label("add-visit.step"),
  quick: true,
  enabled: (ctx, args) =>
    isRecord(args) &&
    placeArgsOk(ctx, args) &&
    isLiveStop(readRoutes(ctx.doc), args.stop),
  execute(ctx, args) {
    const { route, after } = place(ctx, args);
    return { route, stop: args.stop, entry: visit(ctx, route, args.stop, after) };
  },
});

export interface EntryArgs {
  readonly route: RouteId;
  readonly entry: RouteEntryId;
}

export interface MoveVisitArgs extends EntryArgs {
  /** The step it becomes, counted from 0 among the steps the route plays. */
  readonly index: number;
}

const moveVisit = defineCommand<MoveVisitArgs, void>({
  name: "move-visit",
  label: label("move-visit"),
  undoLabel: label("move-visit.step"),
  quick: true,
  enabled: (ctx, args) =>
    isRecord(args) &&
    Number.isInteger(args.index) &&
    (args.index as number) >= 0 &&
    isEntryOf(readRoutes(ctx.doc), args.route, args.entry),
  execute(ctx, { route, entry, index }) {
    const sr = readRoutes(ctx.doc);
    const steps = routeSteps(sr, route);
    const from = steps.findIndex((step) => step.entry === entry);
    // Past the end is the end: a move there from the end changes nothing.
    const to = Math.min(index, Math.max(0, steps.length - 1));
    if (from === to) return;
    moveRouteEntry(ctx.doc, route, entry, moveIndex(sr, route, entry, to));
  },
});

const removeVisit = defineCommand<EntryArgs, void>({
  name: "remove-visit",
  label: label("remove-visit"),
  undoLabel: label("remove-visit.step"),
  quick: true,
  enabled: (ctx, args) =>
    isRecord(args) && isEntryOf(readRoutes(ctx.doc), args.route, args.entry),
  execute(ctx, { route, entry }) {
    removeRouteEntry(ctx.doc, route, entry);
  },
});

export interface StopArgs {
  readonly stop: StopId;
}

const stopArgsOk = (ctx: CommandContext, args: unknown): boolean =>
  isRecord(args) && isLiveStop(readRoutes(ctx.doc), args.stop);

/**
 * A stop that exists, also one that is removed: a name or notes the user
 * typed while another user deleted the stop are still saved, and, as for
 * every edit made without knowing of a delete, the stop then stays
 * (docs/adr/0001, section 6.5). The panel offers nothing else for a removed stop.
 */
const stopRecordOk = (ctx: CommandContext, args: unknown): boolean =>
  isRecord(args) &&
  isString(args.stop) &&
  Object.hasOwn(readRoutes(ctx.doc).stops, args.stop);

/** True for the first half of a UTF-16 surrogate pair. */
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
/** True for the second half of a UTF-16 surrogate pair. */
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * The part of `old` that differs from `text`: the lengths of their common
 * beginning and end, in UTF-16 code units (the units of a Y.Text), never
 * splitting a surrogate pair (an emoji): half a pair would be stored as U+FFFD.
 */
export function textChange(old: string, text: string): { start: number; end: number } {
  const max = Math.min(old.length, text.length);
  let start = 0;
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  if (start > 0 && isHigh(old.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < max - start &&
    old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
  )
    end++;
  if (end > 0 && isLow(old.charCodeAt(old.length - end))) end--;
  return { start, end };
}

/**
 * Deletes a stop. It disappears from every route that visits it, until an
 * undo brings it back (docs/adr/0001, section 6.3). The warning when routes
 * use it is the panel's: the command does what it is told.
 */
const deleteStop = defineCommand<StopArgs, void>({
  name: "delete-stop",
  label: label("delete-stop"),
  undoLabel: label("delete-stop.step"),
  quick: true,
  enabled: stopArgsOk,
  execute(ctx, { stop }) {
    removeStop(ctx.doc, stop);
  },
});

export interface RenameStopArgs extends StopArgs {
  readonly name: string;
}

const renameStopCommand = defineCommand<RenameStopArgs, void>({
  name: "rename-stop",
  label: label("rename-stop"),
  undoLabel: label("rename-stop.step"),
  quick: true,
  enabled: (ctx, args) =>
    stopRecordOk(ctx, args) && isString((args as RenameStopArgs).name),
  execute(ctx, { stop, name }) {
    renameStop(ctx.doc, stop, name);
  },
});

export interface NotesArgs extends StopArgs {
  readonly text: string;
}

/**
 * Replaces the stop's notes with plain text, changing only the part that
 * differs, so formatting elsewhere and a concurrent edit elsewhere in the
 * notes are kept. Notes that hold embedded objects, which plain text cannot
 * show, are replaced whole.
 */
const setStopNotes = defineCommand<NotesArgs, void>({
  name: "set-stop-notes",
  label: label("set-stop-notes"),
  undoLabel: label("set-stop-notes.step"),
  quick: true,
  enabled: (ctx, args) => stopRecordOk(ctx, args) && isString((args as NotesArgs).text),
  execute(ctx, { stop, text }) {
    const notes = stopNotes(ctx.doc, stop);
    const plain = (notes.toDelta() as TextRun[]).every((run) => isString(run.insert));
    const old = plain ? notes.toString() : null;
    if (old === text) return;
    edit(ctx.doc, () => {
      if (old === null) {
        notes.delete(0, notes.length);
        notes.insert(0, text);
        return;
      }
      const { start, end } = textChange(old, text);
      if (old.length - start - end > 0) notes.delete(start, old.length - start - end);
      if (text.length - start - end > 0)
        notes.insert(start, text.slice(start, text.length - end));
    });
  },
});

/** Points the stop at the rectangle the camera shows now. */
const updateStopView = defineCommand<StopArgs, void>({
  name: "update-stop-view",
  label: label("update-stop-view"),
  undoLabel: label("update-stop-view.step"),
  quick: true,
  enabled: stopArgsOk,
  execute(ctx, { stop }) {
    setStopView(ctx.doc, stop, viewOfCamera(ctx.doc, ctx.services));
  },
});

/**
 * Gives one visit a stop of its own: a copy of the stop (view, name, notes,
 * what it shows and hides, transition, ext) takes the visit's place, so a
 * change made for this route no longer changes the others (docs/adr/0001,
 * section 6.3). The visit is pointed at the copy where it stands, so two users
 * doing this at once, or one doing it while another moves the visit, never
 * double it: one of the two writes wins (docs/adr/0013).
 */
const copyStopForRoute = defineCommand<EntryArgs, AddedStop>({
  name: "copy-stop-for-route",
  label: label("copy-stop-for-route"),
  undoLabel: label("copy-stop-for-route.step"),
  quick: true,
  enabled: (ctx, args) => {
    if (!isRecord(args)) return false;
    const sr = readRoutes(ctx.doc);
    if (!isEntryOf(sr, args.route, args.entry)) return false;
    const stop = sr.routes[args.route as RouteId]!.entries[args.entry as string]!.stop;
    return isLiveStop(sr, stop);
  },
  execute(ctx, { route, entry }) {
    const sr = readRoutes(ctx.doc);
    const old = sr.routes[route]!.entries[entry]!.stop;
    const source = sr.stops[old]!;
    const stop = addStop(ctx.doc, {
      view: source.view,
      name: source.name,
      notes: source.notes.delta,
      ext: source.ext,
    });
    for (const [element, change] of Object.entries(source.visibility))
      setVisibility(
        ctx.doc,
        stop,
        element,
        change.action,
        change.ext ? { ext: change.ext } : {},
      );
    if (source.transition !== null) setStopTransition(ctx.doc, stop, source.transition);
    setRouteEntryStop(ctx.doc, route, entry, stop);
    choose(ctx.doc, { route, entry });
    return { route, stop, entry };
  },
});

export interface VisibilityArgs extends StopArgs {
  /** Elements to show or hide on arrival at the stop; default: the selection. */
  readonly ids?: readonly ElementId[];
  /** Null takes the change away. */
  readonly action: "show" | "hide" | null;
}

function visibilityIds(ctx: CommandContext, ids: unknown): ElementId[] {
  const list: unknown = ids ?? ctx.services.selection.get();
  if (!Array.isArray(list) || !list.every(isString)) return [];
  const r = new Resolver(yLookup(ctx.doc));
  return [...new Set(list)].filter((id) => r.get(id) !== undefined);
}

const setVisibilityCommand = defineCommand<VisibilityArgs, void>({
  name: "set-visibility",
  label: label("set-visibility"),
  undoLabel: label("set-visibility.step"),
  quick: true,
  enabled: (ctx, args) =>
    stopArgsOk(ctx, args) &&
    [null, "show", "hide"].includes((args as VisibilityArgs).action) &&
    visibilityIds(ctx, (args as VisibilityArgs).ids).length > 0,
  execute(ctx, { stop, ids, action }) {
    const elements = visibilityIds(ctx, ids);
    if (elements.length === 0) throw new Error("No elements");
    const current = readRoutes(ctx.doc).stops[stop]!.visibility;
    for (const element of elements) {
      const now = Object.hasOwn(current, element) ? current[element]!.action : null;
      if (now !== action) setVisibility(ctx.doc, stop, element, action);
    }
  },
});

// ---------------------------------------------------------------------------
// The camera and the panel
// ---------------------------------------------------------------------------

export interface GoToArgs extends StopArgs {
  /** Along the stop's transition (default), or at once. */
  readonly animate?: boolean;
  /** For tests: animation frames, clock and comfort settings. */
  readonly environment?: JumpEnvironment;
}

/** Moves the camera to show a stop. Not an undo step: the camera is not document content. */
const goToStop = defineCommand<GoToArgs, void>({
  name: "go-to-stop",
  label: label("go-to-stop"),
  quick: true,
  undoable: false,
  enabled: (ctx, args) => {
    if (!stopArgsOk(ctx, args)) return false;
    return regionOf(ctx.doc, readRoutes(ctx.doc), (args as GoToArgs).stop) !== null;
  },
  execute(ctx, { stop, animate, environment }) {
    const sr = readRoutes(ctx.doc);
    const region = regionOf(ctx.doc, sr, stop);
    if (region === null) throw new Error("The stop shows nothing");
    jumpTo(ctx.doc, ctx.services, region, sr.stops[stop]!.transition, {
      animate: animate ?? true,
      ...(environment ? { environment } : {}),
    });
  },
});

const togglePanel = defineCommand<unknown, void>({
  name: "toggle-panel",
  label: label("toggle-panel"),
  // Shift and R ("rute", "route"): a plain letter picks a tool, and Alt with a
  // letter opens the browser's menus in Firefox, depending on its language.
  shortcuts: ["Shift+R"],
  quick: true,
  undoable: false,
  // A button in the editor's toolbar, pressed while the panel is open.
  toolbar: "panels",
  icon: "route",
  active: (ctx) => ctx.services.panels.isOpen(ROUTES_PANEL),
  execute(ctx) {
    const panels = ctx.services.panels;
    if (panels.isOpen(ROUTES_PANEL)) panels.close(ROUTES_PANEL);
    else panels.open(ROUTES_PANEL);
  },
});

export const routesCommands = [
  togglePanel,
  addRouteCommand,
  renameRouteCommand,
  deleteRouteCommand,
  addStopFromView,
  addStopsFromFrames,
  addVisit,
  moveVisit,
  removeVisit,
  deleteStop,
  renameStopCommand,
  setStopNotes,
  updateStopView,
  copyStopForRoute,
  setVisibilityCommand,
  goToStop,
];

/** The commands by id, so the panel can ask whether one would run (as a menu greys out entries). */
export const ROUTES_COMMANDS: ReadonlyMap<string, (typeof routesCommands)[number]> =
  new Map(
    routesCommands.map((command) => [`${ROUTES_EXTENSION}/${command.name}`, command]),
  );

/** Whether a command of this extension would run now with these arguments. */
export function routesCommandEnabled(
  ctx: CommandContext,
  id: string,
  args?: unknown,
): boolean {
  const command = ROUTES_COMMANDS.get(id);
  if (command === undefined) return false;
  try {
    return (
      (command.enabled as ((c: CommandContext, a: unknown) => boolean) | undefined)?.(
        ctx,
        args,
      ) ?? true
    );
  } catch {
    return false;
  }
}
