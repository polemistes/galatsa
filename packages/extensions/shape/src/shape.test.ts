// SPDX-License-Identifier: GPL-3.0-or-later

// The shape extension against the real document model: loading, reading data,
// inserting and changing shapes as one undo step each, fields, shapes of a
// kind from a newer version, hit testing and bounds, and the drawing tool.

import type { ElementId, ExtensionElement, Point } from "@galatsa/core";
import {
  createUndoManager,
  initDocument,
  toSnapshot,
  addElement,
} from "@galatsa/core/ydoc";
import { ViewHost, type ElementBox } from "@galatsa/extension-api";
import {
  EditorHost,
  type CommandEnvironment,
  type Mode,
  type ToolPointerEvent,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import {
  createRecordingDrawContext,
  createTestServices,
} from "@galatsa/extension-api/testing";
import { createI18n, memoryLocaleStorage, type Locale } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_STYLE,
  SHAPE_INSERT,
  SHAPE_SET,
  SHAPE_TYPE,
  shapeExtension,
  shapeView,
  shapeViewExtension,
  type ShapeModel,
} from "./index.ts";

function setup(mode: Mode = "advanced", locale: Locale = "en") {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc);
  const i18n = createI18n({ dev: false, locale, storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  const problems = host.load([shapeExtension]);
  const services = createTestServices(doc, { mode });
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const run = <R = unknown>(id: string, args?: unknown) =>
    host.commands.execute<R>(id, env(), args);
  const must = <R = unknown>(id: string, args?: unknown): R => {
    const outcome = run<R>(id, args);
    if (!outcome.ok)
      throw new Error(`${id} failed: ${outcome.reason} ${String(outcome.error)}`);
    return outcome.value;
  };
  const element = (id: ElementId) => toSnapshot(doc).elements[id] as ExtensionElement;
  const count = () => Object.keys(toSnapshot(doc).elements).length;
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  return {
    doc,
    undo,
    i18n,
    host,
    problems,
    services,
    env,
    run,
    must,
    element,
    count,
    updates,
  };
}

const read = (data: Record<string, unknown>) => {
  const reports: string[] = [];
  const model = shapeView.read(data as never, 1, (path, problem) =>
    reports.push(`${path}: ${problem}`),
  );
  return { model, reports };
};

const box = (w: number, h: number): ElementBox => ({ id: "x", w, h });

describe("loading", () => {
  it("loads without problems and offers its commands, tools and properties per mode", () => {
    const t = setup("quick");
    expect(t.problems).toEqual([]);
    expect(t.host.active()).toEqual(["galatsa.shape"]);
    expect(t.host.tools("quick").map((tool) => tool.id)).toEqual([
      "galatsa.shape/rect",
      "galatsa.shape/ellipse",
      "galatsa.shape/line",
    ]);
    expect(t.host.commands.list("quick").map((c) => c.id)).toEqual([
      SHAPE_INSERT,
      SHAPE_SET,
    ]);
    expect(t.host.properties(SHAPE_TYPE, "quick").map((f) => f.key)).toEqual([
      "fill",
      "stroke",
      "strokeWidth",
    ]);
    expect(t.host.properties(SHAPE_TYPE, "advanced").map((f) => f.key)).toEqual([
      "fill",
      "stroke",
      "strokeWidth",
      "cornerRadius",
      "opacity",
      "kind",
    ]);
    const { conflicts } = t.host.commands.shortcuts("advanced");
    expect(conflicts).toEqual([]);
  });

  it("has its text in Norwegian and English", () => {
    for (const locale of ["nb", "en"] as const) {
      const t = setup("advanced", locale);
      const labels = [
        ...t.host.tools("advanced").map((tool) => tool.definition.label),
        ...t.host.commands.list("advanced").map((c) => c.definition.label),
        ...t.host.properties(SHAPE_TYPE, "advanced").map((f) => f.label),
        shapeView.label,
      ];
      for (const label of labels) expect(t.i18n.t(label)).not.toBe(label);
    }
    expect(setup("advanced", "nb").i18n.t("galatsa.shape:kind.line")).toBe("Linje");
  });

  it("loads its viewing part alone in a viewer and draws", () => {
    const host = new ViewHost();
    expect(host.load([shapeViewExtension])).toEqual([]);
    const ctx = createRecordingDrawContext();
    const element = {
      id: "s",
      type: SHAPE_TYPE,
      typeVersion: 1,
      data: {
        kind: "ellipse",
        fill: "#ff0000",
        stroke: null,
        strokeWidth: 0,
        cornerRadius: 0,
        opacity: 1,
      },
      size: { w: 10, h: 10 },
    };
    host.drawElement(ctx, element as never, "s");
    expect(ctx.calls.some((c) => c.op === "fill" && c.color === "#ff0000")).toBe(true);
  });
});

describe("reading data", () => {
  it("reads every key, with the defaults for missing keys and no reports", () => {
    expect(read({})).toEqual({
      model: { kind: "rect", ...DEFAULT_STYLE, params: {} },
      reports: [],
    });
    expect(
      read({
        kind: "line",
        fill: null,
        stroke: "#AABBCC80",
        strokeWidth: 0,
        cornerRadius: 3,
        opacity: 0,
      }),
    ).toEqual({
      model: {
        kind: "line",
        fill: null,
        stroke: "#AABBCC80",
        strokeWidth: 0,
        cornerRadius: 3,
        opacity: 0,
        params: {},
      },
      reports: [],
    });
  });

  it("reads a value that does not fit as the default, and reports it", () => {
    const { model, reports } = read({
      kind: "Not a kind",
      fill: "red",
      stroke: "#12345",
      strokeWidth: -1,
      cornerRadius: Number.NaN,
      opacity: 2,
    });
    expect(model).toEqual({ kind: "rect", ...DEFAULT_STYLE, params: {} });
    expect(reports.map((r) => r.split(":")[0])).toEqual([
      "kind",
      "fill",
      "stroke",
      "strokeWidth",
      "cornerRadius",
      "opacity",
    ]);
  });

  it("keeps a kind from a newer version, and leaves keys it does not know alone", () => {
    expect(read({ kind: "star", points: 5 })).toEqual({
      model: { kind: "star", ...DEFAULT_STYLE, params: {} },
      reports: [],
    });
  });
});

describe("commands", () => {
  it("inserts a shape with every key written, selects it, as one undo step", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "ellipse",
      x: 1,
      y: 2,
      w: 30,
      h: 40,
    });
    const e = t.element(id);
    expect(e.type).toBe(SHAPE_TYPE);
    expect(e.typeVersion).toBe(1);
    expect(e.pos).toMatchObject({ x: 1, y: 2 });
    expect(e.size).toEqual({ w: 30, h: 40 });
    expect(e.rot).toBe(0);
    expect(e.data).toEqual({ kind: "ellipse", ...DEFAULT_STYLE });
    expect(t.services.state.selection).toEqual([id]);
    expect(t.undo.undoStack).toHaveLength(1);
    t.undo.undo();
    expect(t.count()).toBe(1); // softly removed: the record stays, deleted
    expect(
      t.host.commands.execute(SHAPE_INSERT, t.env(), {
        kind: "rect",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      }).ok,
    ).toBe(true);
  });

  it("names the undo step", () => {
    const t = setup();
    t.must(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const step = t.host.commands.history(t.env()).undoStep();
    expect(step?.label).toBe("galatsa.shape:insert.step");
  });

  it("writes a rotation in [0, 2π) and a style over the defaults", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "line",
      x: 0,
      y: 0,
      w: 50,
      h: 0,
      rot: -Math.PI / 2,
      style: { stroke: "#000000", strokeWidth: 5 },
    });
    expect(t.element(id).rot).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(t.element(id).data).toMatchObject({
      kind: "line",
      stroke: "#000000",
      strokeWidth: 5,
    });
  });

  it("refuses an unknown kind, a negative size, a bad style or a missing argument, writing nothing", () => {
    const t = setup();
    const before = t.updates.length;
    for (const args of [
      undefined,
      { kind: "star", x: 0, y: 0, w: 1, h: 1 },
      { kind: "rect", x: 0, y: 0, w: -1, h: 1 },
      { kind: "rect", x: 0, y: Number.NaN, w: 1, h: 1 },
      { kind: "rect", x: 0, y: 0, w: 1, h: 1, rot: "up" },
      { kind: "rect", x: 0, y: 0, w: 1, h: 1, style: { fill: "blue" } },
      { kind: "rect", x: 0, y: 0, w: 1, h: 1, style: { kind: "ellipse" } },
    ])
      expect(t.run(SHAPE_INSERT, args)).toMatchObject({ ok: false, reason: "disabled" });
    expect(t.updates.length).toBe(before);
  });

  it("changes a key of several shapes as one undo step", () => {
    const t = setup();
    const a = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const b = t.must<ElementId>(SHAPE_INSERT, {
      kind: "ellipse",
      x: 20,
      y: 0,
      w: 10,
      h: 10,
    });
    const steps = t.undo.undoStack.length;
    t.must(SHAPE_SET, { ids: [a, b], key: "fill", value: "#ff0000" });
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(t.element(a).data["fill"]).toBe("#ff0000");
    expect(t.element(b).data["fill"]).toBe("#ff0000");
    t.must(SHAPE_SET, { ids: [a], key: "kind", value: "line" });
    expect(t.element(a).data["kind"]).toBe("line");
    t.undo.undo();
    t.undo.undo();
    expect(t.element(a).data).toMatchObject({ kind: "rect", fill: DEFAULT_STYLE.fill });
  });

  it("refuses values the data does not allow, unknown keys and things that are not shapes", () => {
    const t = setup();
    const a = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const other = addElement(t.doc, {
      type: "x.other/thing",
      x: 0,
      y: 0,
      size: { w: 1, h: 1 },
    });
    const before = t.updates.length;
    for (const args of [
      { ids: [a], key: "opacity", value: 7 },
      { ids: [a], key: "fill", value: "blue" },
      { ids: [a], key: "kind", value: "star" },
      { ids: [a], key: "colour", value: "#000000" },
      { ids: [a], key: "fill" },
      { ids: [], key: "fill", value: "#000000" },
      { ids: [a, other], key: "fill", value: "#000000" },
      { ids: ["nothing"], key: "fill", value: "#000000" },
    ])
      expect(t.run(SHAPE_SET, args)).toMatchObject({ ok: false, reason: "disabled" });
    expect(t.updates.length).toBe(before);
  });
});

describe("fields", () => {
  it("read the model, and apply only where they mean something", () => {
    const t = setup();
    const fields = new Map(
      t.host.properties(SHAPE_TYPE, "advanced").map((f) => [f.key, f]),
    );
    const model = (kind: string): ShapeModel => read({ kind }).model;
    const applies = (key: string, kind: string) =>
      fields.get(key)!.applies?.(model(kind)) ?? true;
    expect(applies("fill", "rect")).toBe(true);
    expect(applies("fill", "line")).toBe(false);
    expect(applies("cornerRadius", "rect")).toBe(true);
    expect(applies("cornerRadius", "ellipse")).toBe(false);
    expect(applies("stroke", "line")).toBe(true);
    expect(applies("kind", "star")).toBe(false);
    expect(fields.get("strokeWidth")!.get(read({ strokeWidth: 7 }).model)).toBe(7);
    for (const field of fields.values()) expect(field.command).toBe(SHAPE_SET);
  });

  it("change one shape through their command, one undo step per change", () => {
    const t = setup();
    const a = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const steps = t.undo.undoStack.length;
    for (const [key, value] of [
      ["fill", null],
      ["stroke", "#00ff00"],
      ["strokeWidth", 12],
      ["cornerRadius", 4],
      ["opacity", 0.25],
      ["kind", "ellipse"],
    ] as const) {
      const field = t.host.properties(SHAPE_TYPE, "advanced").find((f) => f.key === key)!;
      t.must(field.command, { ids: [a], key, value });
    }
    expect(t.undo.undoStack.length).toBe(steps + 6);
    expect(t.element(a).data).toEqual({
      kind: "ellipse",
      fill: null,
      stroke: "#00ff00",
      strokeWidth: 12,
      cornerRadius: 4,
      opacity: 0.25,
    });
  });

  it("preview a continuous change without writing, then commit it as one step", () => {
    const t = setup();
    const a = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const before = t.updates.length;
    const steps = t.undo.undoStack.length;
    const gesture = t.host.commands.beginGesture(t.env());
    for (let i = 0; i <= 20; i += 1)
      gesture.preview({ [a]: { data: { opacity: i / 20 } } });
    expect(t.updates.length).toBe(before);
    gesture.commit(SHAPE_SET, { ids: [a], key: "opacity", value: 0.5 });
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(t.element(a).data["opacity"]).toBe(0.5);
  });
});

describe("a kind from a newer version", () => {
  it("is drawn as a placeholder, hit by its box, and keeps its kind and keys when its style changes", () => {
    const t = setup();
    const id = addElement(t.doc, {
      type: SHAPE_TYPE,
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 40, h: 20 },
      data: { kind: "star", points: 5, fill: "#000000" },
    });
    const { model, reports } = read(t.element(id).data);
    expect(reports).toEqual([]);
    const ctx = createRecordingDrawContext();
    shapeView.draw(model, ctx, box(40, 20));
    expect(
      ctx.calls.some(
        (c) => c.op === "text" && c.text.includes("galatsa.shape/shape: star"),
      ),
    ).toBe(true);
    expect(shapeView.hitTest!(model, { x: 20, y: 10 }, box(40, 20), 0)).toBe(true);
    t.must(SHAPE_SET, { ids: [id], key: "fill", value: "#ffffff" });
    expect(t.element(id).data).toEqual({ kind: "star", points: 5, fill: "#ffffff" });
    expect(t.run(SHAPE_SET, { ids: [id], key: "kind", value: "rect" }).ok).toBe(true);
  });
});

describe("drawing", () => {
  it("fills, strokes and applies opacity, with the kind's joins", () => {
    const ctx = createRecordingDrawContext();
    const { model } = read({
      kind: "rect",
      fill: "#111111",
      stroke: "#222222",
      strokeWidth: 4,
      opacity: 0.5,
    });
    shapeView.draw(model, ctx, box(10, 20));
    expect(ctx.calls).toEqual([
      { op: "begin-opacity", alpha: 0.5 },
      { op: "fill", path: ["rect(0,0,10,20)"], color: "#111111" },
      {
        op: "stroke",
        path: ["rect(0,0,10,20)"],
        style: { color: "#222222", width: 4, join: "miter", cap: "round" },
      },
      { op: "end-opacity" },
    ]);
  });

  it("does not fill a line, and rounds corners only up to half the shorter side", () => {
    const line = createRecordingDrawContext();
    shapeView.draw(read({ kind: "line", fill: "#111111" }).model, line, box(10, 0));
    expect(line.calls.filter((c) => c.op === "fill")).toEqual([]);
    expect(line.calls.find((c) => c.op === "stroke")).toMatchObject({
      path: ["moveTo(0,0)", "lineTo(10,0)"],
    });
    const rounded = createRecordingDrawContext();
    shapeView.draw(read({ kind: "rect", cornerRadius: 50 }).model, rounded, box(40, 20));
    expect(rounded.calls.find((c) => c.op === "fill")).toMatchObject({
      path: ["roundRect(0,0,40,20,10)"],
    });
    const ellipse = createRecordingDrawContext();
    shapeView.draw(
      read({ kind: "ellipse", cornerRadius: 50 }).model,
      ellipse,
      box(40, 20),
    );
    expect(ellipse.calls.find((c) => c.op === "fill")).toMatchObject({
      path: [`ellipse(20,10,20,10,0,0,${2 * Math.PI})`],
    });
  });

  it("draws a tiny filled shape as its fill alone, and a tiny line still as a line", () => {
    const ctx = createRecordingDrawContext({ detail: "box" });
    shapeView.draw(read({ kind: "rect" }).model, ctx, box(10, 10));
    expect(ctx.calls.map((c) => c.op)).toEqual(["begin-opacity", "fill", "end-opacity"]);
    const line = createRecordingDrawContext({ detail: "box" });
    shapeView.draw(read({ kind: "line" }).model, line, box(10, 0));
    expect(line.calls.map((c) => c.op)).toEqual([
      "begin-opacity",
      "stroke",
      "end-opacity",
    ]);
  });
});

describe("hit testing and bounds", () => {
  const hit = (data: Record<string, unknown>, p: Point, w: number, h: number, tol = 0) =>
    shapeView.hitTest!(read(data).model, p, box(w, h), tol);

  it("hits a filled shape inside, and an unfilled one only on its outline", () => {
    expect(hit({ kind: "rect" }, { x: 50, y: 25 }, 100, 50)).toBe(true);
    expect(hit({ kind: "rect", fill: null }, { x: 50, y: 25 }, 100, 50)).toBe(false);
    expect(
      hit({ kind: "rect", fill: null, strokeWidth: 4 }, { x: 101.5, y: 25 }, 100, 50),
    ).toBe(true);
    expect(
      hit({ kind: "rect", fill: null, strokeWidth: 4 }, { x: 103, y: 25 }, 100, 50),
    ).toBe(false);
    expect(
      hit({ kind: "rect", fill: null, strokeWidth: 4 }, { x: 103, y: 25 }, 100, 50, 2),
    ).toBe(true);
  });

  it("follows the real outline: not an ellipse's corners, not a rounded rectangle's", () => {
    expect(hit({ kind: "ellipse", stroke: null }, { x: 50, y: 25 }, 100, 50)).toBe(true);
    expect(hit({ kind: "ellipse", stroke: null }, { x: 3, y: 3 }, 100, 50)).toBe(false);
    expect(
      hit({ kind: "rect", stroke: null, cornerRadius: 20 }, { x: 2, y: 2 }, 100, 50),
    ).toBe(false);
    expect(hit({ kind: "rect", stroke: null }, { x: 2, y: 2 }, 100, 50)).toBe(true);
  });

  it("hits a line within half its width and the tolerance", () => {
    expect(hit({ kind: "line", strokeWidth: 6 }, { x: 50, y: 2.9 }, 100, 0)).toBe(true);
    expect(hit({ kind: "line", strokeWidth: 6 }, { x: 50, y: 4 }, 100, 0)).toBe(false);
    expect(hit({ kind: "line", strokeWidth: 6 }, { x: 50, y: 4 }, 100, 0, 1.5)).toBe(
      true,
    );
    expect(hit({ kind: "line", strokeWidth: 6 }, { x: 104, y: 0 }, 100, 0)).toBe(false);
  });

  it("reach as far as the outline does", () => {
    const bounds = (data: Record<string, unknown>, w: number, h: number) =>
      shapeView.bounds!(read(data).model, box(w, h));
    const e = bounds({ kind: "ellipse", strokeWidth: 4 }, 100, 50);
    // Exact up to the flattening error, which is added: a tenth of a unit here.
    expect(e.x).toBeLessThanOrEqual(-2);
    expect(e.x).toBeGreaterThan(-2.2);
    expect(e.y).toBeLessThanOrEqual(-2);
    expect(e.y).toBeGreaterThan(-2.2);
    expect(e.w).toBeGreaterThanOrEqual(104);
    expect(e.w).toBeLessThan(104.4);
    const r = bounds({ kind: "rect", strokeWidth: 10 }, 100, 50);
    expect(r.x).toBeCloseTo(-5 * Math.SQRT2, 9);
    expect(r.w).toBeCloseTo(100 + 10 * Math.SQRT2, 9);
    expect(bounds({ kind: "line", strokeWidth: 8 }, 100, 0)).toEqual({
      x: -4,
      y: -4,
      w: 108,
      h: 8,
    });
    expect(bounds({ kind: "line", stroke: null, strokeWidth: 8 }, 100, 0)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 0,
    });
  });
});

function pointer(world: Point, extra: Partial<ToolPointerEvent> = {}): ToolPointerEvent {
  return {
    screen: world,
    world,
    pointerType: "mouse",
    button: 0,
    pressure: 0.5,
    modifiers: { shift: false, alt: false, ctrl: false, meta: false, mod: false },
    ...extra,
  };
}

const SHIFT = { shift: true, alt: false, ctrl: false, meta: false, mod: false };
const ALT = { shift: false, alt: true, ctrl: false, meta: false, mod: false };

function tool(t: ReturnType<typeof setup>, kind: string) {
  const log = { overlays: 0, done: 0 };
  const session: ToolSession = {
    environment: t.env,
    run: (id, args) => t.host.commands.execute(id, t.env(), args),
    gesture: () => t.host.commands.beginGesture(t.env()),
    scale: () => 1,
    requestOverlay: () => (log.overlays += 1),
    editText: () => {},
    setCursor: () => {},
    done: () => (log.done += 1),
  };
  const definition = t.host
    .tools()
    .find((r) => r.id === `galatsa.shape/${kind}`)!.definition;
  return { handler: definition.start(session), log };
}

describe("the drawing tool", () => {
  it("previews the shape in its style without writing, and makes it with one command", () => {
    const t = setup();
    const { handler, log } = tool(t, "rect");
    const before = t.updates.length;
    handler.pointerDown!(pointer({ x: 10, y: 20 }));
    handler.pointerMove!(pointer({ x: 60, y: 50 }));
    handler.pointerMove!(pointer({ x: 110, y: 70 }));
    expect(t.updates.length).toBe(before);
    expect(log.overlays).toBeGreaterThan(0);
    const overlay = createRecordingDrawContext();
    handler.drawOverlay!(overlay);
    const fill = overlay.calls.find((c) => c.op === "fill");
    expect(fill).toMatchObject({ color: DEFAULT_STYLE.fill });
    // The box from (10, 20) to (110, 70), drawn in root space.
    expect(fill).toMatchObject({
      path: [
        "moveTo(10,20)",
        "lineTo(110,20)",
        "lineTo(110,70)",
        "lineTo(10,70)",
        "closePath()",
        "moveTo(10,20)",
      ],
    });
    handler.pointerUp!(pointer({ x: 110, y: 70 }));
    expect(t.undo.undoStack).toHaveLength(1);
    expect(log.done).toBe(1);
    const id = t.services.state.selection[0]!;
    expect(t.element(id)).toMatchObject({
      pos: { x: 10, y: 20 },
      size: { w: 100, h: 50 },
      rot: 0,
    });
    const after = createRecordingDrawContext();
    handler.drawOverlay!(after);
    expect(after.calls).toEqual([]);
  });

  it("draws a square with Shift and from the centre with Alt", () => {
    const t = setup();
    const a = tool(t, "ellipse").handler;
    a.pointerDown!(pointer({ x: 0, y: 0 }));
    a.pointerUp!(pointer({ x: -40, y: 10 }, { modifiers: SHIFT }));
    expect(t.element(t.services.state.selection[0]!)).toMatchObject({
      pos: { x: -40, y: 0 },
      size: { w: 40, h: 40 },
    });
    const b = tool(t, "rect").handler;
    b.pointerDown!(pointer({ x: 100, y: 100 }));
    b.pointerUp!(pointer({ x: 130, y: 110 }, { modifiers: ALT }));
    expect(t.element(t.services.state.selection[0]!)).toMatchObject({
      pos: { x: 70, y: 90 },
      size: { w: 60, h: 20 },
    });
  });

  it("makes a shape of a fixed size on screen for a click", () => {
    const t = setup();
    t.services.state.camera = { space: null, cx: 0, cy: 0, zoom: 4 };
    const { handler } = tool(t, "rect");
    handler.pointerDown!(pointer({ x: 50, y: 50 }));
    handler.pointerUp!(pointer({ x: 50, y: 50 }));
    expect(t.element(t.services.state.selection[0]!)).toMatchObject({
      pos: { x: 37.5, y: 37.5 },
      size: { w: 25, h: 25 },
    });
  });

  it("draws a line from where the drag starts to where it ends, turned in its direction", () => {
    const t = setup();
    const { handler } = tool(t, "line");
    handler.pointerDown!(pointer({ x: 100, y: 100 }));
    handler.pointerMove!(pointer({ x: 70, y: 140 }));
    const overlay = createRecordingDrawContext();
    handler.drawOverlay!(overlay);
    const stroke = overlay.calls.find((c) => c.op === "stroke");
    // The preview runs from where the drag started to where the pointer is.
    const points = (stroke?.op === "stroke" ? stroke.path : []).map((op) =>
      op
        .replace(/^\w+\(|\)$/g, "")
        .split(",")
        .map(Number),
    );
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBeCloseTo(100, 9);
    expect(points[0]![1]).toBeCloseTo(100, 9);
    expect(points[1]![0]).toBeCloseTo(70, 9);
    expect(points[1]![1]).toBeCloseTo(140, 9);
    handler.pointerUp!(pointer({ x: 70, y: 140 }));
    const e = t.element(t.services.state.selection[0]!);
    expect(e.size).toEqual({ w: 50, h: 0 });
    expect(e.rot).toBeCloseTo(Math.atan2(40, -30), 12);
    // The box's centre is halfway along the drag.
    expect(e.pos.x + 25).toBeCloseTo(85, 9);
    expect(e.pos.y).toBeCloseTo(120, 9);
  });

  it("keeps a line's angle to steps of 15 degrees with Shift", () => {
    const t = setup();
    const { handler } = tool(t, "line");
    handler.pointerDown!(pointer({ x: 0, y: 0 }));
    handler.pointerUp!(pointer({ x: 100, y: 3 }, { modifiers: SHIFT }));
    const e = t.element(t.services.state.selection[0]!);
    expect(e.rot).toBe(0);
    expect(e.size.w).toBeCloseTo(Math.hypot(100, 3), 9);
  });

  it("cancels with Escape and with a cancelled pointer, writing nothing", () => {
    const t = setup();
    const { handler, log } = tool(t, "rect");
    const before = t.updates.length;
    handler.pointerDown!(pointer({ x: 0, y: 0 }));
    handler.pointerMove!(pointer({ x: 50, y: 50 }));
    expect(handler.keyDown!({ key: "Escape", modifiers: SHIFT, repeat: false })).toBe(
      true,
    );
    handler.pointerUp!(pointer({ x: 50, y: 50 }));
    handler.pointerDown!(pointer({ x: 0, y: 0 }));
    handler.pointerCancel!();
    handler.pointerUp!(pointer({ x: 50, y: 50 }));
    expect(t.updates.length).toBe(before);
    expect(log.done).toBe(0);
    expect(handler.keyDown!({ key: "Escape", modifiers: SHIFT, repeat: false })).toBe(
      false,
    );
  });

  it("ignores buttons other than the primary one", () => {
    const t = setup();
    const { handler } = tool(t, "rect");
    handler.pointerDown!(pointer({ x: 0, y: 0 }, { button: 2 }));
    handler.pointerUp!(pointer({ x: 50, y: 50 }, { button: 2 }));
    expect(t.undo.undoStack).toHaveLength(0);
  });
});
