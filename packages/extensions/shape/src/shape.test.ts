// SPDX-License-Identifier: GPL-3.0-or-later

// The shape extension against the real document model: loading, reading data,
// inserting and changing shapes as one undo step each, fields, shapes of a
// kind from a newer version, hit testing and bounds, and the drawing tool.

import {
  FRAME_TYPE,
  type ElementId,
  type ExtensionElement,
  type Point,
} from "@galatsa/core";
import {
  createUndoManager,
  deleteElements,
  initDocument,
  setLocked,
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
  MAX_LENGTH,
  SHAPE_INSERT,
  SHAPE_KINDS,
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

/** The default values of a kind's parameters, as its model holds them. */
const paramsOf = (kind: string) =>
  Object.fromEntries(
    (SHAPE_KINDS.find((k) => k.kind === kind)?.params ?? []).map((p) => [
      p.key,
      p.default,
    ]),
  );

/** Every parameter key of the program's kinds, once, in the order of the kinds. */
const PARAM_KEYS = [
  ...new Set(SHAPE_KINDS.flatMap((k) => (k.params ?? []).map((p) => p.key))),
];

describe("loading", () => {
  it("loads without problems and offers its commands, tools and properties per mode", () => {
    const t = setup("quick");
    expect(t.problems).toEqual([]);
    expect(t.host.active()).toEqual(["galatsa.shape"]);
    expect(t.host.tools("quick").map((tool) => tool.id)).toEqual(
      SHAPE_KINDS.filter((k) => k.quick ?? true).map((k) => `galatsa.shape/${k.kind}`),
    );
    expect(t.host.tools("advanced").map((tool) => tool.id)).toEqual(
      SHAPE_KINDS.map((k) => `galatsa.shape/${k.kind}`),
    );
    expect(t.host.commands.list("quick").map((c) => c.id)).toEqual([
      SHAPE_INSERT,
      SHAPE_SET,
    ]);
    const quickParams = SHAPE_KINDS.flatMap((k) =>
      (k.params ?? []).filter((p) => p.quick === true).map((p) => p.key),
    );
    expect(t.host.properties(SHAPE_TYPE, "quick").map((f) => f.key)).toEqual([
      "fill",
      "stroke",
      "strokeWidth",
      ...new Set(quickParams),
    ]);
    expect(t.host.properties(SHAPE_TYPE, "advanced").map((f) => f.key)).toEqual([
      "fill",
      "stroke",
      "strokeWidth",
      "cornerRadius",
      "opacity",
      "kind",
      ...PARAM_KEYS,
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
      model: { kind: "rect", ...DEFAULT_STYLE, params: paramsOf("rect") },
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
        params: paramsOf("line"),
      },
      reports: [],
    });
  });

  it("reads a value of the wrong form as the default, and reports it", () => {
    const { model, reports } = read({
      kind: "Not a kind",
      fill: "red",
      stroke: "#12345",
      strokeWidth: "thick",
      cornerRadius: Number.NaN,
      opacity: null,
    });
    expect(model).toEqual({ kind: "rect", ...DEFAULT_STYLE, params: paramsOf("rect") });
    expect(reports.map((r) => r.split(":")[0])).toEqual([
      "kind",
      "fill",
      "stroke",
      "strokeWidth",
      "cornerRadius",
      "opacity",
    ]);
  });

  it("reads numbers out of range, as a newer version may write them, without a report, drawn in range", () => {
    expect(
      read({ kind: "rect", strokeWidth: 1e300, cornerRadius: -4, opacity: 2 }),
    ).toEqual({
      model: {
        kind: "rect",
        ...DEFAULT_STYLE,
        strokeWidth: MAX_LENGTH,
        cornerRadius: 0,
        opacity: 1,
        params: paramsOf("rect"),
      },
      reports: [],
    });
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
    expect(e.data).toEqual({ kind: "ellipse", ...DEFAULT_STYLE, ...paramsOf("ellipse") });
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

describe("what the commands may act on", () => {
  const frame = (t: ReturnType<typeof setup>) =>
    addElement(t.doc, { type: FRAME_TYPE, x: 0, y: 0, size: { w: 100, h: 100 } });

  it("refuses to change a locked shape, a shape in a locked frame, or a deleted one", () => {
    const t = setup();
    const locked = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
    setLocked(t.doc, locked, true);
    const f = frame(t);
    const inside = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      parent: f,
    });
    setLocked(t.doc, f, true);
    const gone = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
    deleteElements(t.doc, [gone]);
    const steps = t.undo.undoStack.length;
    const before = t.updates.length;
    for (const id of [locked, inside, gone])
      expect(
        t.run(SHAPE_SET, { ids: [id], key: "fill", value: "#000000" }),
      ).toMatchObject({
        ok: false,
        reason: "disabled",
      });
    expect(t.updates.length).toBe(before);
    expect(t.undo.undoStack.length).toBe(steps);
  });

  it("inserts only into the root or a container the user sees that is not locked", () => {
    const t = setup();
    const open = frame(t);
    const locked = frame(t);
    setLocked(t.doc, locked, true);
    const gone = frame(t);
    deleteElements(t.doc, [gone]);
    const shape = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    const at = (parent: string) => ({ kind: "rect", x: 0, y: 0, w: 1, h: 1, parent });
    expect(t.run(SHAPE_INSERT, at(open)).ok).toBe(true);
    const before = t.updates.length;
    for (const parent of [locked, gone, shape, "nothing"])
      expect(t.run(SHAPE_INSERT, at(parent))).toMatchObject({
        ok: false,
        reason: "disabled",
      });
    expect(t.updates.length).toBe(before);
  });

  it("is not offered when the shape's data would not read cleanly, rather than failing", () => {
    const t = setup();
    // Damaged data: a fill that is not a colour.
    const id = addElement(t.doc, {
      type: SHAPE_TYPE,
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 10, h: 10 },
      data: { kind: "rect", fill: { gradient: true } },
    });
    expect(t.run(SHAPE_SET, { ids: [id], key: "opacity", value: 0.5 })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
    // Repairing the damaged key itself is offered.
    expect(t.run(SHAPE_SET, { ids: [id], key: "fill", value: "#ffffff" }).ok).toBe(true);
  });

  it("stays able to change a shape with values out of this version's range", () => {
    const t = setup();
    const id = addElement(t.doc, {
      type: SHAPE_TYPE,
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 10, h: 10 },
      data: { kind: "rect", strokeWidth: 1e300, opacity: 3 },
    });
    t.must(SHAPE_SET, { ids: [id], key: "fill", value: "#ffffff" });
    expect(t.element(id).data).toEqual({
      kind: "rect",
      strokeWidth: 1e300,
      opacity: 3,
      fill: "#ffffff",
    });
  });
});

describe("values as written", () => {
  it("writes colours in lower case, from insert and from a change", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      style: { fill: "#AABBCC", stroke: "#11223344" },
    });
    expect(t.element(id).data).toMatchObject({ fill: "#aabbcc", stroke: "#11223344" });
    t.must(SHAPE_SET, { ids: [id], key: "stroke", value: "#FF00AA" });
    expect(t.element(id).data["stroke"]).toBe("#ff00aa");
  });

  it("refuses an outline width or a corner radius beyond MAX_LENGTH", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
    expect(
      t.run(SHAPE_SET, { ids: [id], key: "strokeWidth", value: MAX_LENGTH }).ok,
    ).toBe(true);
    for (const key of ["strokeWidth", "cornerRadius"])
      expect(t.run(SHAPE_SET, { ids: [id], key, value: MAX_LENGTH * 2 }).ok).toBe(false);
    expect(
      t.run(SHAPE_INSERT, {
        kind: "rect",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        style: { strokeWidth: 1e300 },
      }).ok,
    ).toBe(false);
  });
});

describe("changing the kind", () => {
  const placed = (t: ReturnType<typeof setup>, id: ElementId) => {
    const e = t.element(id);
    return { x: e.pos.x, y: e.pos.y, ...e.size, rot: e.rot };
  };

  it("makes a line a square as wide as the line, around the line's middle, keeping its turn", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "line",
      x: 10,
      y: 50,
      w: 40,
      h: 0,
      rot: 1,
    });
    const steps = t.undo.undoStack.length;
    t.must(SHAPE_SET, { ids: [id], key: "kind", value: "rect" });
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(placed(t, id)).toEqual({ x: 10, y: 30, w: 40, h: 40, rot: 1 });
    t.undo.undo();
    expect(placed(t, id)).toEqual({ x: 10, y: 50, w: 40, h: 0, rot: 1 });
    expect(t.element(id).data["kind"]).toBe("line");
  });

  it("makes a box 0 high, around its middle, when the new kind is drawn as a line", () => {
    const t = setup();
    const id = t.must<ElementId>(SHAPE_INSERT, {
      kind: "ellipse",
      x: 0,
      y: 0,
      w: 60,
      h: 20,
    });
    t.must(SHAPE_SET, { ids: [id], key: "kind", value: "line" });
    expect(placed(t, id)).toEqual({ x: 0, y: 10, w: 60, h: 0, rot: 0 });
    // Between two kinds drawn as boxes the box stays.
    t.must(SHAPE_SET, { ids: [id], key: "kind", value: "rect" });
    t.must(SHAPE_SET, { ids: [id], key: "kind", value: "ellipse" });
    expect(placed(t, id)).toEqual({ x: 0, y: -20, w: 60, h: 60, rot: 0 });
  });

  it("is refused for a shape of a kind this version does not know", () => {
    const t = setup();
    const id = addElement(t.doc, {
      type: SHAPE_TYPE,
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 10, h: 0 },
      data: { kind: "future-line", head: "big" },
    });
    expect(t.run(SHAPE_SET, { ids: [id], key: "kind", value: "rect" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
    expect(t.element(id).data).toEqual({ kind: "future-line", head: "big" });
  });
});

describe("changes that change nothing", () => {
  it("are not offered and make no undo step: the same value, or the same kind", () => {
    const t = setup();
    const a = t.must<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    const b = t.must<ElementId>(SHAPE_INSERT, {
      kind: "rect",
      x: 20,
      y: 0,
      w: 10,
      h: 10,
    });
    t.must(SHAPE_SET, { ids: [a], key: "fill", value: "#ff0000" });
    const steps = t.undo.undoStack.length;
    const before = t.updates.length;
    for (const args of [
      { ids: [a], key: "fill", value: "#ff0000" },
      { ids: [a], key: "fill", value: "#FF0000" },
      { ids: [a, b], key: "kind", value: "rect" },
      { ids: [b], key: "opacity", value: 1 },
    ])
      expect(t.run(SHAPE_SET, args), JSON.stringify(args)).toMatchObject({
        ok: false,
        reason: "disabled",
      });
    expect(t.undo.undoStack.length).toBe(steps);
    expect(t.updates.length).toBe(before);
    // With one shape that changes, only that one is written, as one step.
    t.must(SHAPE_SET, { ids: [a, b], key: "fill", value: "#ff0000" });
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(t.element(b).data["fill"]).toBe("#ff0000");
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
    // The style of a kind from a newer version can be changed, fill and corners too.
    expect(applies("fill", "star")).toBe(true);
    expect(applies("cornerRadius", "star")).toBe(true);
    expect(applies("opacity", "star")).toBe(true);
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
      ...paramsOf("ellipse"),
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
    // Its kind cannot be changed: this version cannot say what it is.
    expect(t.run(SHAPE_SET, { ids: [id], key: "kind", value: "rect" }).ok).toBe(false);
  });
});

describe("a kind from a newer version drawn as a line", () => {
  it("is a solid line along the box, at least 2 device pixels wide, with the label above it", () => {
    const ctx = createRecordingDrawContext({ scale: 2, t: (label) => label });
    const { model } = read({ kind: "future-line", stroke: "#000000", strokeWidth: 0.25 });
    shapeView.draw(model, ctx, box(120, 0));
    const stroke = ctx.calls.find((c) => c.op === "stroke");
    expect(stroke).toMatchObject({ path: ["moveTo(0,0)", "lineTo(120,0)"] });
    expect(stroke?.op === "stroke" && stroke.style.width).toBe(1);
    expect(stroke?.op === "stroke" && stroke.style.dash).toBeUndefined();
    const text = ctx.calls.find((c) => c.op === "text");
    expect(text?.op === "text" && text.y).toBeLessThan(0);
    // A thick outline keeps its width.
    const thick = createRecordingDrawContext({ scale: 2 });
    shapeView.draw(
      read({ kind: "future-line", strokeWidth: 9 }).model,
      thick,
      box(120, 0),
    );
    expect(thick.calls.find((c) => c.op === "stroke")).toMatchObject({
      style: { width: 9 },
    });
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
    isEnabled: (id, args) => t.host.commands.isEnabled(id, t.env(), args),
    extensions: t.host,
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

  it("gives a new shape an outline 2 screen pixels wide at the zoom it is drawn at", () => {
    for (const zoom of [0.01, 1, 4, 100]) {
      const t = setup();
      t.services.state.camera = { space: null, cx: 0, cy: 0, zoom };
      const { handler } = tool(t, "rect");
      handler.pointerDown!(pointer({ x: 0, y: 0 }));
      handler.pointerMove!(pointer({ x: 50, y: 50 }));
      const overlay = createRecordingDrawContext();
      handler.drawOverlay!(overlay);
      const stroke = overlay.calls.find((c) => c.op === "stroke");
      expect(stroke?.op === "stroke" && stroke.style.width).toBeCloseTo(2 / zoom, 12);
      handler.pointerUp!(pointer({ x: 50, y: 50 }));
      const e = t.element(t.services.state.selection[0]!);
      expect(e.data["strokeWidth"]).toBeCloseTo(2 / zoom, 12);
    }
  });

  it("gives a new shape its kind's own defaults, lengths the same on screen at any zoom", () => {
    for (const zoom of [0.01, 1, 4]) {
      const t = setup();
      t.services.state.camera = { space: null, cx: 0, cy: 0, zoom };
      for (const [kind, radius] of [
        ["speech-bubble", 16],
        ["rect", 0],
      ] as const) {
        const { handler } = tool(t, kind);
        handler.pointerDown!(pointer({ x: 0, y: 0 }));
        handler.pointerUp!(pointer({ x: 50, y: 50 }));
        const e = t.element(t.services.state.selection[0]!);
        expect(e.data["cornerRadius"], kind).toBeCloseTo(radius / zoom, 12);
        expect(e.data["strokeWidth"], kind).toBeCloseTo(2 / zoom, 12);
      }
    }
    // The insert command gives them too, unless the style says otherwise;
    // data without the key still means the common default.
    const t = setup();
    const insert = (style?: object) =>
      t.element(
        t.must<ElementId>(SHAPE_INSERT, {
          kind: "speech-bubble",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          ...(style !== undefined ? { style } : {}),
        }),
      ).data["cornerRadius"];
    expect(insert()).toBe(16);
    expect(insert({ cornerRadius: 3 })).toBe(3);
    expect(shapeView.read({ kind: "speech-bubble" }, 1, () => {}).cornerRadius).toBe(
      DEFAULT_STYLE.cornerRadius,
    );
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
