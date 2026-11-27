// SPDX-License-Identifier: GPL-3.0-or-later

// What every shape kind must satisfy, checked for each kind in SHAPE_KINDS, so
// a new kind is tested as soon as it is listed. And a kind written here, as a
// new kind would be written in a file of its own, with a parameter and marks,
// to show that the framework takes it without any change.

import type { ElementId, ExtensionElement } from "@galatsa/core";
import { createUndoManager, initDocument, toSnapshot } from "@galatsa/core/ydoc";
import {
  EditorHost,
  type CommandEnvironment,
  type ToolPointerEvent,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import {
  createRecordingDrawContext,
  createTestServices,
} from "@galatsa/extension-api/testing";
import { createI18n, memoryLocaleStorage } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extent, flatten, RecordingPath } from "./geometry.ts";
import {
  createShapeExtension,
  defineShapeKind,
  kindTable,
  newShapeData,
  SHAPE_INSERT,
  SHAPE_KINDS,
  SHAPE_SET,
  SHAPE_TYPE,
  shapeGallery,
  shapeLabel,
  type ShapeKind,
  type ShapeParam,
} from "./index.ts";
import { geometryOf } from "./draw.ts";

// --- A new kind, as it would be written in kinds/diamond.ts -----------------

const INSET: ShapeParam = {
  type: "number",
  key: "inset",
  // A real kind gets its own keys in messages/en.ts and nb.ts; this one
  // borrows existing ones so that the bundle stays as it is.
  label: shapeLabel("corner-radius"),
  min: 0,
  max: 0.5,
  step: 0.05,
  default: 0,
};

const diamond = defineShapeKind({
  kind: "diamond",
  label: shapeLabel("kind.rect"),
  shortcut: "d",
  closed: true,
  params: [INSET],
  outline({ body, marks }, { w, h, params, strokeWidth }) {
    const inset = (params["inset"] as number) * w;
    body.moveTo(w / 2, 0);
    body.lineTo(w - inset, h / 2);
    body.lineTo(w / 2, h);
    body.lineTo(inset, h / 2);
    body.closePath();
    // A dot at the centre, in the outline colour.
    marks.arc(w / 2, h / 2, Math.max(1, strokeWidth), 0, 2 * Math.PI);
  },
});

// ----------------------------------------------------------------------------

const ALL = [...SHAPE_KINDS, diamond];

function setup(kinds: readonly ShapeKind[]) {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc);
  const i18n = createI18n({ dev: false, locale: "en", storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  const parts = createShapeExtension(kinds);
  const problems = host.load([parts.editExtension]);
  const services = createTestServices(doc);
  const env = (): CommandEnvironment => ({ doc, undo, services });
  return { doc, undo, i18n, host, problems, services, env, parts };
}

function pointer(x: number, y: number): ToolPointerEvent {
  return {
    screen: { x, y },
    world: { x, y },
    pointerType: "mouse",
    button: 0,
    pressure: 0.5,
    modifiers: { shift: false, alt: false, ctrl: false, meta: false, mod: false },
  };
}

describe.each(ALL.map((kind) => [kind.kind, kind] as const))(
  "the %s kind",
  (_name, kind) => {
    const t = setup(ALL);
    const { table, view } = t.parts;

    it("is named well and has its text in both languages", () => {
      expect(kind.kind).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      for (const locale of ["nb", "en"] as const) {
        t.i18n.setLocale(locale);
        expect(t.i18n.t(kind.label)).not.toBe(kind.label);
        for (const param of kind.params ?? [])
          expect(t.i18n.t(param.label)).not.toBe(param.label);
      }
      t.i18n.setLocale("en");
      expect(t.problems).toEqual([]);
    });

    it("has a drawing tool, offered in quick mode unless it says otherwise", () => {
      const tool = t.host
        .tools("quick")
        .find((r) => r.id === `galatsa.shape/${kind.kind}`);
      expect(tool !== undefined).toBe(kind.quick ?? true);
      expect(t.host.commands.shortcuts("advanced").conflicts).toEqual([]);
      // No two tools share a key, nor take the keys of the text and selection
      // tools of the development page.
      if (kind.shortcut !== undefined) {
        const others = ALL.filter((k) => k !== kind).map((k) => k.shortcut);
        expect([...others, "t", "v"]).not.toContain(kind.shortcut);
      }
    });

    it("draws every gallery case from valid data, with an outline that stays in the bounds", () => {
      const cases = shapeGallery(table, kind);
      expect(cases.length).toBeGreaterThanOrEqual(5);
      for (const c of cases) {
        const reports: string[] = [];
        const model = view.read(c.data, 1, (path) => reports.push(path));
        expect(reports, c.name).toEqual([]);
        expect(model.kind).toBe(kind.kind);
        expect(c.rot).toBeGreaterThanOrEqual(0);
        expect(c.rot).toBeLessThan(2 * Math.PI);
        const box = { id: "x" as ElementId, w: c.w, h: c.h };
        const ctx = createRecordingDrawContext();
        view.draw(model, ctx, box);
        expect(
          ctx.calls.some((call) => call.op === "fill" || call.op === "stroke"),
          c.name,
        ).toBe(true);
        // Every point of the outline is inside the bounds, and is hit.
        const body = new RecordingPath();
        kind.outline({ body, marks: new RecordingPath() }, geometryOf(kind, model, box));
        const bounds = view.bounds!(model, box);
        const lines = flatten(body.ops, 0.01).lines;
        const outline = extent(lines)!;
        expect(outline.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(outline.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(outline.x + outline.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-9);
        expect(outline.y + outline.h).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-9);
        for (const line of lines)
          for (let i = 0; i < line.points.length; i += 2)
            expect(
              view.hitTest!(
                model,
                { x: line.points[i]!, y: line.points[i + 1]! },
                box,
                0.5,
              ),
              c.name,
            ).toBe(true);
        // Far outside the bounds nothing is hit.
        expect(view.hitTest!(model, { x: bounds.x - 50, y: bounds.y - 50 }, box, 1)).toBe(
          false,
        );
        expect(
          view.hitTest!(
            model,
            { x: bounds.x + bounds.w + 50, y: bounds.y + bounds.h + 50 },
            box,
            1,
          ),
        ).toBe(false);
      }
    });

    it("draws the same outline every time (a pure function of the box and the data)", () => {
      const model = view.read(newShapeData(table, kind.kind), 1, () => {});
      const once = new RecordingPath();
      const twice = new RecordingPath();
      const g = geometryOf(kind, model, { w: 70, h: 30 });
      kind.outline({ body: once, marks: new RecordingPath() }, g);
      kind.outline({ body: twice, marks: new RecordingPath() }, g);
      expect(twice.ops).toEqual(once.ops);
    });

    it("is drawn with its tool: a preview while dragging, then one undo step", () => {
      const t2 = setup(ALL);
      let overlays = 0;
      const session: ToolSession = {
        environment: t2.env,
        run: (id, args) => t2.host.commands.execute(id, t2.env(), args),
        gesture: () => t2.host.commands.beginGesture(t2.env()),
        scale: () => 1,
        requestOverlay: () => (overlays += 1),
        editText: () => {},
        setCursor: () => {},
        done: () => {},
      };
      const definition = t2.host
        .tools()
        .find((r) => r.id === `galatsa.shape/${kind.kind}`)!;
      const handler = definition.definition.start(session);
      handler.pointerDown!(pointer(10, 10));
      handler.pointerMove!(pointer(90, 60));
      const preview = createRecordingDrawContext();
      handler.drawOverlay!(preview);
      expect(preview.calls.length).toBeGreaterThan(0);
      expect(overlays).toBeGreaterThan(0);
      expect(t2.undo.undoStack).toHaveLength(0);
      handler.pointerUp!(pointer(90, 60));
      expect(t2.undo.undoStack).toHaveLength(1);
      const id = t2.services.state.selection[0]!;
      const element = toSnapshot(t2.doc).elements[id] as ExtensionElement;
      expect(element.type).toBe(SHAPE_TYPE);
      expect(element.data["kind"]).toBe(kind.kind);
    });
  },
);

describe("a new kind in a file of its own", () => {
  it("loads, with its tool, and its parameter as a field for it alone", () => {
    const t = setup(ALL);
    expect(t.problems).toEqual([]);
    expect(t.host.tools().map((r) => r.id)).toContain("galatsa.shape/diamond");
    const field = t.host
      .properties(SHAPE_TYPE, "advanced")
      .find((f) => f.key === "inset")!;
    expect(field.control).toEqual({ kind: "number", min: 0, max: 0.5, step: 0.05 });
    const model = (kind: string) => t.parts.view.read({ kind }, 1, () => {});
    expect(field.applies!(model("diamond"))).toBe(true);
    expect(field.applies!(model("rect"))).toBe(false);
    expect(t.host.properties(SHAPE_TYPE, "quick").some((f) => f.key === "inset")).toBe(
      false,
    );
  });

  it("writes and changes its parameter through the common commands, checked", () => {
    const t = setup(ALL);
    const run = (id: string, args: unknown) =>
      t.host.commands.execute<ElementId>(id, t.env(), args);
    const inserted = run(SHAPE_INSERT, { kind: "diamond", x: 0, y: 0, w: 40, h: 40 });
    expect(inserted.ok).toBe(true);
    const id = (inserted as { value: ElementId }).value;
    const data = () => (toSnapshot(t.doc).elements[id] as ExtensionElement).data;
    expect(data()["inset"]).toBe(0);
    expect(run(SHAPE_SET, { ids: [id], key: "inset", value: 0.25 }).ok).toBe(true);
    expect(data()["inset"]).toBe(0.25);
    expect(run(SHAPE_SET, { ids: [id], key: "inset", value: 0.9 }).ok).toBe(false);
    expect(
      t.parts.view.read({ kind: "diamond", inset: "wide" }, 1, () => {}).params,
    ).toEqual({
      inset: 0,
    });
  });

  it("draws its marks in the outline colour, is hit on them, and gets a gallery case for its parameter", () => {
    const t = setup(ALL);
    const model = t.parts.view.read(
      { kind: "diamond", fill: null, stroke: "#123456", strokeWidth: 4 },
      1,
      () => {},
    );
    const ctx = createRecordingDrawContext();
    t.parts.view.draw(model, ctx, { id: "d", w: 100, h: 100 });
    expect(ctx.calls.filter((c) => c.op === "fill")).toEqual([
      { op: "fill", path: [`arc(50,50,4,0,${2 * Math.PI})`], color: "#123456" },
    ]);
    expect(
      t.parts.view.hitTest!(model, { x: 50, y: 50 }, { id: "d", w: 100, h: 100 }, 0),
    ).toBe(true);
    expect(
      t.parts.view.hitTest!(model, { x: 40, y: 40 }, { id: "d", w: 100, h: 100 }, 0),
    ).toBe(false);
    expect(shapeGallery(t.parts.table, diamond).map((c) => c.name)).toContain(
      "inset changed",
    );
  });
});

describe("the table of kinds", () => {
  const kind = (name: string, params: ShapeParam[] = []): ShapeKind =>
    defineShapeKind({
      kind: name,
      label: shapeLabel("kind.rect"),
      closed: true,
      params,
      outline: ({ body }, { w, h }) => body.rect(0, 0, w, h),
    });

  it("refuses badly named and repeated kinds", () => {
    expect(() => kindTable([kind("Star")])).toThrow(/Bad shape kind name/);
    expect(() => kindTable([kind("a"), kind("a")])).toThrow(/listed twice/);
  });

  it("refuses a parameter under a common key, a key that means two things, and a default that does not fit", () => {
    const param = (key: string, def = 0): ShapeParam => ({
      type: "number",
      key,
      label: shapeLabel("opacity"),
      min: 0,
      max: 1,
      default: def,
    });
    expect(() => kindTable([kind("a", [param("fill")])])).toThrow(/common key/);
    expect(() =>
      kindTable([kind("a", [param("size")]), kind("b", [param("size")])]),
    ).toThrow(/another parameter/);
    expect(() => kindTable([kind("a", [param("size", 2)])])).toThrow(/does not fit/);
    const shared = param("size");
    expect(
      kindTable([kind("a", [shared]), kind("b", [shared])]).paramKinds.get("size"),
    ).toEqual(new Set(["a", "b"]));
  });
});
