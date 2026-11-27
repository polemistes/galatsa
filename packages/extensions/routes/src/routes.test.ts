// SPDX-License-Identifier: GPL-3.0-or-later

// The routes extension in the real editor (in Node, drawing nothing): stops
// from the view and from frames, a frame stop that follows its frame, a stop
// shared by two routes and changed in both, deleting a stop that routes use
// and taking it back, what each stop shows and hides, notes, the order of a
// route, one undo step per command, the route on the canvas, and jumps.

import { FRAME_TYPE, hiddenAt, type ElementId, type StopId } from "@galatsa/core";
import { addElement, stopNotes, edit, setStopView } from "@galatsa/core/ydoc";
import { Editor, loadExtensions } from "@galatsa/editor";
import { DEFAULT_COMFORT, type DrawContext, type Path } from "@galatsa/extension-api";
import { BASICS } from "@galatsa/extension-basics";
import { fixturesExtension, visibleState } from "@galatsa/extension-basics/testing";
import { shapeExtension, SHAPE_INSERT } from "@galatsa/extension-examples";
import { SELECT_TOOL } from "@galatsa/extension-select";
import { createI18n, memoryLocaleStorage } from "@galatsa/i18n";
import type { Canvas2D } from "@galatsa/renderer";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { initDocument } from "@galatsa/core/ydoc";
import {
  ROUTES,
  ROUTES_PANEL,
  choose,
  currentChoice,
  liveStops,
  readRoutes,
  regionOf,
  routeShapes,
  routesExtension,
  routesUsing,
  speedOfTransition,
  textChange,
  transitionForSpeed,
  viewOfCamera,
  type AddedStop,
  type JumpEnvironment,
} from "./index.ts";
import { routeSteps, liveRoutes } from "./model.ts";

const INSERT_FRAME = "test.fixtures/insert-frame";

/** A 2D context that accepts every call and draws nothing. */
function nullContext(): Canvas2D {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Canvas2D;
}

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function setup(given?: Y.Doc) {
  const i18n = createI18n({ locale: "en", dev: false, storage: memoryLocaleStorage() });
  const loaded = loadExtensions(i18n, [
    shapeExtension,
    fixturesExtension,
    routesExtension,
  ]);
  if (loaded.problems.length > 0)
    throw new Error(loaded.problems.map((p) => `${p.extension}: ${p.detail}`).join("; "));
  const doc = given ?? new Y.Doc();
  if (!given) initDocument(doc);
  const frames: Array<() => void> = [];
  const editor = new Editor({
    doc,
    host: loaded.host,
    i18n,
    platform: { mac: false },
    schedule: (frame) => {
      frames.push(frame);
      return () => {};
    },
    defaultTool: SELECT_TOOL,
  });
  editors.push(editor);
  editor.attach(nullContext(), { width: 1000, height: 800, devicePixelRatio: 1 });
  editor.services.camera.set({ space: null, cx: 500, cy: 400, zoom: 1 });
  const must = <R = unknown>(id: string, args?: unknown): R => {
    const outcome = editor.run<R>(id, args);
    if (!outcome.ok)
      throw new Error(`${id} ${outcome.reason}: ${String(outcome.error ?? "")}`);
    return outcome.value;
  };
  const frame = (x: number, y: number, w = 200, h = 100): ElementId =>
    must<ElementId>(INSERT_FRAME, { x, y, w, h });
  const steps = (route: string) => routeSteps(readRoutes(doc), route).map((s) => s.stop);
  const steps0 = () => steps(currentChoice(doc, readRoutes(doc)).route!);
  return { editor, doc, must, frame, steps, steps0, frames };
}

/** Runs a command and checks it made exactly one undo step that takes everything back. */
function oneStep<R>(t: ReturnType<typeof setup>, id: string, args?: unknown): R {
  const before = JSON.stringify(visibleState(t.doc));
  const depth = t.editor.undo.undoStack.length;
  const value = t.must<R>(id, args);
  expect(t.editor.undo.undoStack.length, `${id} makes one step`).toBe(depth + 1);
  const after = JSON.stringify(visibleState(t.doc));
  expect(after, `${id} changes the document`).not.toBe(before);
  t.editor.undo.undo();
  expect(JSON.stringify(visibleState(t.doc)), `undo of ${id}`).toBe(before);
  t.editor.undo.redo();
  expect(JSON.stringify(visibleState(t.doc)), `redo of ${id}`).toBe(after);
  return value;
}

describe("stops", () => {
  it("makes a stop of the view, with a route when there is none, as one step", () => {
    const t = setup();
    t.editor.services.camera.set({ space: null, cx: 100, cy: 50, zoom: 2 });
    const added = oneStep<AddedStop>(t, ROUTES.addStopFromView);
    const sr = readRoutes(t.doc);
    expect(liveRoutes(sr)).toEqual([added.route]);
    expect(sr.stops[added.stop]!.view).toEqual({
      kind: "rect",
      space: null,
      x: 100 - 250,
      y: 50 - 200,
      w: 500,
      h: 400,
    });
    expect(currentChoice(t.doc, sr)).toEqual({ route: added.route, entry: added.entry });
    // Undo takes the route away too.
    t.editor.undo.undo();
    expect(liveRoutes(readRoutes(t.doc))).toEqual([]);
  });

  it("anchors a stop of the view in the innermost frame that holds it whole", () => {
    const t = setup();
    const outer = t.frame(1000, 1000, 2000, 2000);
    const inner = addElement(t.doc, {
      type: FRAME_TYPE,
      parent: outer,
      x: 100,
      y: 100,
      size: { w: 400, h: 400 },
      data: {},
    });
    // A view of 250 x 200 in the middle of the inner frame.
    t.editor.services.camera.set({ space: null, cx: 1300, cy: 1300, zoom: 4 });
    expect(t.editor.camera.space).toBe(inner);
    expect(viewOfCamera(t.doc, t.editor.services)).toEqual({
      kind: "rect",
      space: inner,
      x: 75,
      y: 100,
      w: 250,
      h: 200,
    });
    // At zoom 2 the view (500 x 400) does not fit in the inner frame, but in the outer one.
    t.editor.services.camera.set({ space: null, cx: 1300, cy: 1300, zoom: 2 });
    expect(t.editor.camera.space).toBe(inner);
    expect(viewOfCamera(t.doc, t.editor.services)).toEqual({
      kind: "rect",
      space: outer,
      x: 50,
      y: 100,
      w: 500,
      h: 400,
    });
    // At zoom 0.25 not even there: the root.
    t.editor.services.camera.set({ space: null, cx: 1300, cy: 1300, zoom: 0.25 });
    expect(viewOfCamera(t.doc, t.editor.services)).toMatchObject({ space: null });
  });

  it("follows the frame it shows when the frame moves, and the camera finds it", () => {
    const t = setup();
    const f = t.frame(100, 100, 200, 100);
    t.editor.services.selection.set([f]);
    const [added] = oneStep<AddedStop[]>(t, ROUTES.addStopsFromFrames);
    const stop = added!.stop;
    expect(readRoutes(t.doc).stops[stop]!.view).toEqual({
      kind: "frame",
      frame: f,
      padding: 0,
    });
    const before = regionOf(t.doc, readRoutes(t.doc), stop)!;
    expect(before.rect).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    t.must(BASICS.move, { ids: [f], dx: 300, dy: -50 });
    const after = regionOf(t.doc, readRoutes(t.doc), stop)!;
    expect(after.rect).toEqual({ x: 400, y: 50, w: 200, h: 100 });
    t.must(ROUTES.goToStop, { stop, animate: false });
    // The frame, 200 x 100, fills the 1000 x 800 view: zoom 5, centred on it.
    const camera = t.editor.camera;
    const o = t.editor.scene.offset(camera.space, null);
    expect(camera.cx + o.x).toBeCloseTo(500, 9);
    expect(camera.cy + o.y).toBeCloseTo(100, 9);
    expect(camera.zoom).toBe(5);
  });

  it("makes stops of the selected frames only, in order after the chosen step", () => {
    const t = setup();
    const a = t.frame(0, 0);
    const b = t.frame(300, 0);
    const shape = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 500,
      w: 5,
      h: 5,
    });
    const first = t.must<AddedStop>(ROUTES.addStopFromView);
    const last = t.must<AddedStop>(ROUTES.addStopFromView);
    t.editor.services.selection.set([shape]);
    expect(t.editor.isEnabled(ROUTES.addStopsFromFrames)).toBe(false);
    t.editor.services.selection.set([b, shape, a]);
    // After the first stop: the chosen step.
    t.must(ROUTES.addVisit, { stop: first.stop, after: first.entry });
    t.must(ROUTES.moveVisit, {
      route: first.route,
      entry: currentChoice(t.doc, readRoutes(t.doc)).entry!,
      index: 2,
    });
    const route = first.route;
    const frames = t.must<AddedStop[]>(ROUTES.addStopsFromFrames, {
      route,
      after: first.entry,
    });
    expect(t.steps(route)).toEqual([
      first.stop,
      frames[0]!.stop,
      frames[1]!.stop,
      last.stop,
      first.stop,
    ]);
    const sr = readRoutes(t.doc);
    expect(
      frames.map((f) => (sr.stops[f.stop]!.view as { frame: string }).frame),
    ).toEqual([b, a]);
  });
});

describe("routes and shared stops", () => {
  it("changes a shared stop in every route that visits it", () => {
    const t = setup();
    const f = t.frame(100, 100);
    t.editor.services.selection.set([f]);
    const [added] = t.must<AddedStop[]>(ROUTES.addStopsFromFrames);
    const stop = added!.stop;
    const one = added!.route;
    const two = oneStep<string>(t, ROUTES.addRoute);
    oneStep(t, ROUTES.addVisit, { stop, route: two });
    expect(t.steps(one)).toEqual([stop]);
    expect(t.steps(two)).toEqual([stop]);
    expect(routesUsing(readRoutes(t.doc), stop)).toEqual([one, two]);
    oneStep(t, ROUTES.renameStop, { stop, name: "Start" });
    t.editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    oneStep(t, ROUTES.updateStopView, { stop });
    oneStep(t, ROUTES.setStopNotes, { stop, text: "Say hello" });
    // Both routes point at the one stop, so both see every change.
    const sr = readRoutes(t.doc);
    for (const route of [one, two]) {
      const [s] = routeSteps(sr, route);
      expect(sr.stops[s!.stop]!.name).toBe("Start");
      expect(sr.stops[s!.stop]!.view).toMatchObject({ kind: "rect", x: -500, y: -400 });
    }
    expect(stopNotes(t.doc, stop).toString()).toBe("Say hello");
    // A stop of its own for route two: changes no longer reach route one.
    const own = oneStep<AddedStop>(t, ROUTES.copyStopForRoute, {
      route: two,
      entry: routeSteps(readRoutes(t.doc), two)[0]!.entry,
    });
    expect(own.stop).not.toBe(stop);
    expect(t.steps(two)).toEqual([own.stop]);
    expect(readRoutes(t.doc).stops[own.stop]).toMatchObject({ name: "Start" });
    expect(stopNotes(t.doc, own.stop).toString()).toBe("Say hello");
    t.must(ROUTES.renameStop, { stop: own.stop, name: "Other" });
    expect(readRoutes(t.doc).stops[stop]!.name).toBe("Start");
  });

  it("renames, deletes and orders routes and visits, each as one step", () => {
    const t = setup();
    const a = t.must<AddedStop>(ROUTES.addStopFromView);
    const b = t.must<AddedStop>(ROUTES.addStopFromView);
    const c = t.must<AddedStop>(ROUTES.addStopFromView);
    const route = a.route;
    expect(t.steps(route)).toEqual([a.stop, b.stop, c.stop]);
    oneStep(t, ROUTES.renameRoute, { route, name: "Tour" });
    expect(readRoutes(t.doc).routes[route]!.name).toBe("Tour");
    oneStep(t, ROUTES.moveVisit, { route, entry: c.entry, index: 0 });
    expect(t.steps(route)).toEqual([c.stop, a.stop, b.stop]);
    oneStep(t, ROUTES.moveVisit, { route, entry: c.entry, index: 5 });
    expect(t.steps(route)).toEqual([a.stop, b.stop, c.stop]);
    // Moving to where it is changes nothing and makes no step.
    const depth = t.editor.undo.undoStack.length;
    t.must(ROUTES.moveVisit, { route, entry: a.entry, index: 0 });
    expect(t.editor.undo.undoStack.length).toBe(depth);
    oneStep(t, ROUTES.removeVisit, { route, entry: b.entry });
    expect(t.steps(route)).toEqual([a.stop, c.stop]);
    // The stop is still there, without a route.
    expect(liveStops(readRoutes(t.doc))).toContain(b.stop);
    oneStep(t, ROUTES.deleteRoute, { route });
    expect(liveRoutes(readRoutes(t.doc))).toEqual([]);
    expect(t.editor.isEnabled(ROUTES.deleteRoute, { route })).toBe(false);
    // A name typed while the route was deleted is still saved, in the removed
    // route, which an undo of the delete brings back with it.
    t.must(ROUTES.renameRoute, { route, name: "Kept" });
    expect(readRoutes(t.doc).routes[route]!.name).toBe("Kept");
  });

  it("deletes a stop from every route that uses it, and one undo brings it back", () => {
    const t = setup();
    const a = t.must<AddedStop>(ROUTES.addStopFromView);
    const b = t.must<AddedStop>(ROUTES.addStopFromView);
    const two = t.must<string>(ROUTES.addRoute);
    t.must(ROUTES.addVisit, { stop: a.stop, route: two });
    t.must(ROUTES.addVisit, { stop: b.stop, route: two });
    t.must(ROUTES.addVisit, { stop: a.stop, route: two });
    expect(routesUsing(readRoutes(t.doc), a.stop)).toEqual([a.route, two]);
    oneStep(t, ROUTES.deleteStop, { stop: a.stop });
    expect(t.steps(a.route)).toEqual([b.stop]);
    expect(t.steps(two)).toEqual([b.stop]);
    expect(routesUsing(readRoutes(t.doc), a.stop)).toEqual([]);
    expect(t.editor.isEnabled(ROUTES.deleteStop, { stop: a.stop })).toBe(false);
    t.editor.undo.undo();
    expect(t.steps(a.route)).toEqual([a.stop, b.stop]);
    expect(t.steps(two)).toEqual([a.stop, b.stop, a.stop]);
  });
});

describe("what a stop shows and hides", () => {
  it("shows and hides the selection on arrival, and takes changes away", () => {
    const t = setup();
    const x = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 5, h: 5 });
    const y = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 9, y: 0, w: 5, h: 5 });
    const s1 = t.must<AddedStop>(ROUTES.addStopFromView);
    const s2 = t.must<AddedStop>(ROUTES.addStopFromView);
    const s3 = t.must<AddedStop>(ROUTES.addStopFromView);
    t.editor.services.selection.set([x, y]);
    oneStep(t, ROUTES.setVisibility, { stop: s2.stop, action: "show" });
    oneStep(t, ROUTES.setVisibility, { stop: s3.stop, ids: [y], action: "hide" });
    const route = s1.route;
    const hidden = (at: number) => [...hiddenAt(readRoutes(t.doc), route, at)].sort();
    expect(hidden(0)).toEqual([x, y].sort());
    expect(hidden(1)).toEqual([]);
    expect(hidden(2)).toEqual([y]);
    oneStep(t, ROUTES.setVisibility, { stop: s2.stop, ids: [x], action: null });
    expect(hidden(0)).toEqual([y]);
    // Nothing selected: nothing to show or hide.
    t.editor.services.selection.set([]);
    expect(
      t.editor.isEnabled(ROUTES.setVisibility, { stop: s2.stop, action: "show" }),
    ).toBe(false);
  });

  it("changes only the part of the notes that differs, keeping formatting", () => {
    const t = setup();
    const s = t.must<AddedStop>(ROUTES.addStopFromView);
    const notes = stopNotes(t.doc, s.stop);
    edit(t.doc, () => {
      notes.insert(0, "Hello ");
      notes.insert(6, "world", { bold: true });
    });
    oneStep(t, ROUTES.setStopNotes, { stop: s.stop, text: "Hello world, again" });
    // Text typed after bold text is bold, as in a word processor.
    expect(notes.toDelta()).toEqual([
      { insert: "Hello " },
      { insert: "world, again", attributes: { bold: true } },
    ]);
    oneStep(t, ROUTES.setStopNotes, { stop: s.stop, text: "Hi world, again" });
    expect(notes.toDelta()).toEqual([
      { insert: "Hi " },
      { insert: "world, again", attributes: { bold: true } },
    ]);
    const depth = t.editor.undo.undoStack.length;
    t.must(ROUTES.setStopNotes, { stop: s.stop, text: "Hi world, again" });
    expect(t.editor.undo.undoStack.length).toBe(depth);
  });
});

describe("the route on the canvas", () => {
  /** A drawing context that records paths and fills. */
  function recorder() {
    const calls: string[] = [];
    const path = (): Path =>
      new Proxy({} as Path, {
        get:
          (_t, name) =>
          (...args: number[]) =>
            calls.push(`${String(name)} ${args.join(" ")}`),
      });
    const ctx: DrawContext = {
      scale: 1,
      detail: "full",
      createPath: path,
      fill: (_p, color) => calls.push(`fill ${color}`),
      stroke: (_p, style) => calls.push(`stroke ${style.color}`),
      withOpacity: (_a, draw) => draw(),
      withClip: (_p, draw) => draw(),
      withOffset: (_x, _y, draw) => draw(),
      drawImage: () => "drawn",
      layoutText: () => ({ width: 10, height: 10, lineCount: 1 }),
      drawText: (_l, x, y) => calls.push(`text ${x} ${y}`),
      t: (label) => label,
    };
    return { ctx, calls };
  }

  it("draws the route shown while the panel is open, through the stops' centres", () => {
    const t = setup();
    const f = t.frame(100, 100, 200, 100);
    t.editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    const a = t.must<AddedStop>(ROUTES.addStopFromView);
    t.editor.services.selection.set([f]);
    t.must(ROUTES.addStopsFromFrames);
    const context = t.editor.host.commands.context(t.editor.environment());
    const shapes = routeShapes(context);
    expect(shapes.rects).toEqual([
      { x: -500, y: -400, w: 1000, h: 800 },
      { x: 100, y: 100, w: 200, h: 100 },
    ]);
    expect(shapes.chosen).toBe(1);
    const overlay = t.editor.host
      .overlays("quick")
      .find((o) => o.id === `galatsa.routes/route`)!;
    expect(overlay.definition.visible!(context)).toBe(false);
    t.must(ROUTES.togglePanel);
    expect(t.editor.services.panels.isOpen(ROUTES_PANEL)).toBe(true);
    const open = t.editor.host.commands.context(t.editor.environment());
    expect(overlay.definition.visible!(open)).toBe(true);
    const { ctx, calls } = recorder();
    overlay.definition.draw(ctx, open);
    // The line from the first centre to the second.
    expect(calls).toContain("moveTo 0 0");
    expect(calls).toContain("lineTo 200 150");
    expect(calls.filter((c) => c.startsWith("text"))).toHaveLength(2);
    // The frame moves: so does its stop on the canvas.
    t.must(BASICS.move, { ids: [f], dx: 100, dy: 0 });
    expect(routeShapes(open).rects[1]).toEqual({ x: 200, y: 100, w: 200, h: 100 });
    t.must(ROUTES.togglePanel);
    expect(t.editor.services.panels.isOpen(ROUTES_PANEL)).toBe(false);
    void a;
  });
});

describe("jumps", () => {
  function environment(reducedMotion = false) {
    let time = 0;
    const pending: Array<() => void> = [];
    const env: JumpEnvironment = {
      schedule: (frame) => {
        pending.push(frame);
        return () => {
          const i = pending.indexOf(frame);
          if (i >= 0) pending.splice(i, 1);
        };
      },
      now: () => time,
      comfort: { ...DEFAULT_COMFORT, reducedMotion },
    };
    const advance = (ms: number) => {
      time += ms;
      for (const frame of pending.splice(0)) frame();
    };
    return { env, advance, pending };
  }

  function twoStops(t: ReturnType<typeof setup>): StopId {
    t.editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    t.must(ROUTES.addStopFromView);
    t.editor.services.camera.set({ space: null, cx: 2000, cy: 0, zoom: 1 });
    const b = t.must<AddedStop>(ROUTES.addStopFromView);
    t.editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
    return b.stop;
  }

  it("flies to a stop along the transition and ends exactly there", () => {
    const t = setup();
    const stop = twoStops(t);
    const { env, advance, pending } = environment();
    t.must(ROUTES.goToStop, { stop, environment: env });
    expect(t.editor.camera.cx).toBe(0);
    const seen: number[] = [];
    for (let i = 0; i < 400 && pending.length > 0; i++) {
      advance(16);
      seen.push(t.editor.camera.cx);
    }
    expect(pending).toHaveLength(0);
    expect(seen.some((x) => x > 100 && x < 1900)).toBe(true);
    expect(t.editor.camera).toEqual({ space: null, cx: 2000, cy: 0, zoom: 1 });
  });

  it("shows only the start and the goal with reduced motion", () => {
    const t = setup();
    const stop = twoStops(t);
    const { env, advance, pending } = environment(true);
    t.must(ROUTES.goToStop, { stop, environment: env });
    for (let i = 0; i < 400 && pending.length > 0; i++) {
      advance(16);
      expect([0, 2000]).toContain(t.editor.camera.cx);
    }
    expect(t.editor.camera.cx).toBe(2000);
  });

  it("stops when the camera is moved by anything else", () => {
    const t = setup();
    const stop = twoStops(t);
    const { env, advance, pending } = environment();
    t.must(ROUTES.goToStop, { stop, environment: env });
    advance(200);
    t.editor.services.camera.set({ space: null, cx: -77, cy: 0, zoom: 1 });
    advance(16);
    expect(pending).toHaveLength(0);
    expect(t.editor.camera.cx).toBe(-77);
  });
});

describe("after the review", () => {
  it("never splits an emoji in the notes, and undo takes the change back whole", () => {
    const t = setup();
    const s = t.must<AddedStop>(ROUTES.addStopFromView);
    t.must(ROUTES.setStopNotes, { stop: s.stop, text: "Bra \u{1F44D} ja" });
    oneStep(t, ROUTES.setStopNotes, { stop: s.stop, text: "Bra \u{1F44E} ja" });
    expect(stopNotes(t.doc, s.stop).toString()).toBe("Bra \u{1F44E} ja");
    t.editor.undo.undo();
    expect(stopNotes(t.doc, s.stop).toString()).toBe("Bra \u{1F44D} ja");
    // Pairs that share their first half, an emoji at either end, one doubled.
    for (const [from, to] of [
      ["\u{1F600}x", "\u{1F601}x"],
      ["x\u{1F600}", "x\u{1F601}"],
      ["\u{1F600}", "a\u{1F600}"],
      ["a\u{1F600}b", "a\u{1F600}\u{1F600}b"],
      ["a\u{1F600}\u{1F600}b", "a\u{1F600}b"],
    ] as const) {
      const { start, end } = textChange(from, to);
      expect(start + end).toBeLessThanOrEqual(Math.min(from.length, to.length));
      t.must(ROUTES.setStopNotes, { stop: s.stop, text: from });
      t.must(ROUTES.setStopNotes, { stop: s.stop, text: to });
      expect(stopNotes(t.doc, s.stop).toString()).toBe(to);
    }
  });

  it("gives a visit a stop of its own without doubling it, also when two users do it at once", () => {
    const a = setup();
    const first = a.must<AddedStop>(ROUTES.addStopFromView);
    a.editor.services.camera.set({ space: null, cx: 900, cy: 400, zoom: 1 });
    const second = a.must<AddedStop>(ROUTES.addStopFromView);
    const two = a.must<string>(ROUTES.addRoute);
    a.must(ROUTES.addVisit, { stop: first.stop, route: two });
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.doc));
    const b = setup(docB);
    const sync = () => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    };
    // Both make a stop of their own for the same visit.
    const mine = a.must<AddedStop>(ROUTES.copyStopForRoute, {
      route: first.route,
      entry: first.entry,
    });
    expect(mine.entry).toBe(first.entry);
    b.must(ROUTES.copyStopForRoute, { route: first.route, entry: first.entry });
    sync();
    for (const t of [a, b]) expect(t.steps(first.route)).toHaveLength(2);
    expect(a.steps(first.route)).toEqual(b.steps(first.route));
    // One makes a stop of its own while the other moves the visit.
    a.must(ROUTES.copyStopForRoute, { route: first.route, entry: first.entry });
    b.must(ROUTES.moveVisit, { route: first.route, entry: first.entry, index: 1 });
    sync();
    for (const t of [a, b]) {
      expect(t.steps(first.route)).toHaveLength(2);
      expect(t.steps(first.route)).toContain(second.stop);
    }
    expect(a.steps(first.route)).toEqual(b.steps(first.route));
    // The other route keeps the shared stop.
    expect(a.steps(two)).toEqual([first.stop]);
  });

  it("copies a stop's ext, refuses to jump to a deleted stop, and moves past the end without a step", () => {
    const t = setup();
    const a = t.must<AddedStop>(ROUTES.addStopFromView);
    const b = t.must<AddedStop>(ROUTES.addStopFromView);
    t.doc.transact(() => {
      const record = t.doc.getMap("stops").get(a.stop) as Y.Map<unknown>;
      (record.get("ext") as Y.Map<unknown>).set("x.hint", "kept");
    });
    const own = t.must<AddedStop>(ROUTES.copyStopForRoute, {
      route: a.route,
      entry: a.entry,
    });
    expect(readRoutes(t.doc).stops[own.stop]!.ext).toEqual({ "x.hint": "kept" });
    const depth = t.editor.undo.undoStack.length;
    t.must(ROUTES.moveVisit, { route: b.route, entry: b.entry, index: 5 });
    expect(t.editor.undo.undoStack.length).toBe(depth);
    t.must(ROUTES.deleteStop, { stop: b.stop });
    expect(t.editor.isEnabled(ROUTES.goToStop, { stop: b.stop })).toBe(false);
  });

  it("saves a name and notes typed while the stop was deleted, in the removed stop", () => {
    const t = setup();
    const a = t.must<AddedStop>(ROUTES.addStopFromView);
    t.must(ROUTES.deleteStop, { stop: a.stop });
    t.must(ROUTES.renameStop, { stop: a.stop, name: "Typed" });
    t.must(ROUTES.setStopNotes, { stop: a.stop, text: "Also typed" });
    expect(readRoutes(t.doc).stops[a.stop]!.name).toBe("Typed");
    expect(stopNotes(t.doc, a.stop).toString()).toBe("Also typed");
  });

  it("opens and closes the panel with Shift+R", () => {
    const t = setup();
    const key = {
      code: "KeyR",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      altGraph: false,
    };
    t.editor.keyDown({ ...key, key: "R", shiftKey: true });
    expect(t.editor.services.panels.isOpen(ROUTES_PANEL)).toBe(true);
    t.editor.keyDown({ ...key, key: "R", shiftKey: true });
    expect(t.editor.services.panels.isOpen(ROUTES_PANEL)).toBe(false);
  });
});

describe("the speed into a stop", () => {
  it("is stored in the stop's transition, each choice one undo step", () => {
    const t = setup();
    const added = t.must<AddedStop>(ROUTES.addStopFromView);
    const transition = () => readRoutes(t.doc).stops[added.stop]!.transition;
    expect(transition()).toBe(null);
    expect(speedOfTransition(transition())).toBe("default");
    for (const speed of ["calm", "fast", "normal", "fade", "default"] as const) {
      if (speed !== "default" || transition() !== null)
        oneStep(t, ROUTES.setStopSpeed, { stop: added.stop, speed });
      expect(speedOfTransition(transition())).toBe(speed);
    }
    expect(transitionForSpeed("calm")).toEqual({
      type: "galatsa.transitions/fly",
      options: { speed: "calm" },
    });
    expect(transitionForSpeed("fade")).toEqual({
      type: "galatsa.transitions/fade",
      options: null,
    });
    // The same choice again changes nothing and makes no undo step.
    const depth = t.editor.undo.undoStack.length;
    t.must(ROUTES.setStopSpeed, { stop: added.stop, speed: "default" });
    expect(t.editor.undo.undoStack.length).toBe(depth);
    // A choice the panel does not offer, or a stop that is not there, is refused.
    expect(
      t.editor.isEnabled(ROUTES.setStopSpeed, { stop: added.stop, speed: "warp" }),
    ).toBe(false);
    expect(t.editor.isEnabled(ROUTES.setStopSpeed, { stop: "gone", speed: "calm" })).toBe(
      false,
    );
    // A transition the panel does not offer (a cut) is shown as "other".
    expect(speedOfTransition({ type: "galatsa.transitions/cut", options: null })).toBe(
      "other",
    );
  });
});

describe("presenting", () => {
  /** An editor with three stops in a route, and a page that notes what it is asked to present. */
  function presenting() {
    const t = setup();
    const stops = [0, 1, 2].map((i) => {
      t.editor.services.camera.set({ space: null, cx: 1000 * i, cy: 0, zoom: 1 });
      return t.must<AddedStop>(ROUTES.addStopFromView);
    });
    const started: { route?: string | null; step?: number }[] = [];
    let ended: () => void = () => {};
    t.editor.setPresenter((request, onEnded) => {
      started.push(request);
      ended = onEnded;
      return { exit: () => onEnded() };
    });
    return { ...t, stops, started, end: () => ended() };
  }
  const F5 = {
    key: "F5",
    code: "F5",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    altGraph: false,
    shiftKey: false,
  };

  it("presents the route shown from its first stop with F5, without an undo step", () => {
    const t = presenting();
    const route = t.stops[0]!.route;
    const depth = t.editor.undo.undoStack.length;
    expect(t.editor.keyDown(F5)).toMatchObject({
      kind: "command",
      command: ROUTES.present,
    });
    expect(t.started).toEqual([{ route, step: 0 }]);
    expect(t.editor.undo.undoStack.length).toBe(depth);
    // One presentation at a time: the command is greyed out while it runs.
    expect(t.editor.isEnabled(ROUTES.present)).toBe(false);
    expect(t.editor.isEnabled(ROUTES.presentFromHere)).toBe(false);
    t.end();
    expect(t.editor.isEnabled(ROUTES.present)).toBe(true);
  });

  it("presents from the chosen stop with Shift+F5", () => {
    const t = presenting();
    const route = t.stops[0]!.route;
    choose(t.doc, { route, entry: t.stops[1]!.entry });
    t.editor.keyDown({ ...F5, shiftKey: true });
    expect(t.started).toEqual([{ route, step: 1 }]);
    t.end();
    // With no stop chosen: from the start.
    choose(t.doc, { route, entry: null });
    t.must(ROUTES.presentFromHere);
    expect(t.started[1]).toEqual({ route, step: 0 });
  });

  it("counts the chosen stop as the player does, without stops that show nothing", () => {
    const t = presenting();
    const route = t.stops[0]!.route;
    // The first stop's frame is missing entirely: the player skips it.
    edit(t.doc, () =>
      setStopView(t.doc, t.stops[0]!.stop, {
        kind: "frame",
        frame: "missing-frame" as ElementId,
        padding: 0,
      }),
    );
    choose(t.doc, { route, entry: t.stops[2]!.entry });
    t.must(ROUTES.presentFromHere);
    expect(t.started).toEqual([{ route, step: 1 }]);
    t.end();
    // The chosen stop itself shows nothing: from the next one.
    choose(t.doc, { route, entry: t.stops[0]!.entry });
    t.must(ROUTES.presentFromHere);
    expect(t.started[1]).toEqual({ route, step: 0 });
  });

  it("presents a given route and step, and refuses a route that is not there", () => {
    const t = presenting();
    const other = t.must<string>(ROUTES.addRoute);
    t.must(ROUTES.present, { route: t.stops[0]!.route, step: 2 });
    expect(t.started).toEqual([{ route: t.stops[0]!.route, step: 2 }]);
    t.end();
    expect(t.editor.isEnabled(ROUTES.present, { route: "gone" })).toBe(false);
    expect(t.editor.isEnabled(ROUTES.present, { step: 1.5 })).toBe(false);
    // The route shown is the new, empty one: it is presented, with the camera free.
    t.must(ROUTES.present);
    expect(t.started[1]).toEqual({ route: other, step: 0 });
  });

  it("presents a document without routes, and says so when there is nowhere to present", () => {
    const t = setup();
    const started: unknown[] = [];
    t.editor.setPresenter((request, onEnded) => {
      started.push(request);
      return { exit: () => onEnded() };
    });
    t.must(ROUTES.present);
    expect(started).toEqual([{ route: null, step: 0 }]);
    const bare = setup();
    expect(bare.editor.run(ROUTES.present).ok).toBe(false);
  });
});
