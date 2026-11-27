// SPDX-License-Identifier: GPL-3.0-or-later

// The example extensions against the real document model: registration, one
// command = one undo step, tools, import and export, data upgrades, elements
// whose extension is missing, and the editing services.

import {
  Resolver,
  type AssetId,
  type AssetInfo,
  type ElementId,
  type ExtensionElement,
  type Point,
} from "@galatsa/core";
import { GROUP_TYPE } from "@galatsa/core";
import {
  addElement,
  createUndoManager,
  dataMap,
  edit,
  group,
  deleteElements,
  forkDoc,
  initDocument,
  moveElement,
  resizeElement,
  syncDocs,
  toSnapshot,
  yLookup,
} from "@galatsa/core/ydoc";
import { ViewHost } from "@galatsa/extension-api";
import {
  EditorHost,
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  pasteImport,
  prepareExport,
  type AssetStore,
  type CommandEnvironment,
  type ImportResult,
  type Mode,
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
import {
  DEFAULT_SIZE_SETTING,
  IMAGE_INSERT,
  IMAGE_TYPE,
  SHAPE_INSERT,
  SHAPE_SET_STYLE,
  SHAPE_TYPE,
  TEXT_INSERT,
  TEXT_SET_DEFAULT,
  SELECT_ALL,
  SELECT_SCALE,
  TEXT_SET_STYLE,
  TEXT_TOGGLE_BOLD,
  TEXT_TYPE,
  exampleExtensions,
  shapeView,
} from "./index.ts";
import { exampleViewExtensions } from "./view.ts";

// A small stand-in for the editor's own commands (move, resize, paste an
// import), which the editor will provide; the examples do not define them.
const EDITOR = "test.editor";
const editorExtension = defineEditExtension({
  view: { id: EDITOR, version: "0.0.0", api: { major: 1, minor: 0 } },
  contributes: {
    commands: [
      defineCommand<{ id: ElementId; x: number; y: number }, void>({
        name: "move",
        label: "common:action.ok",
        quick: true,
        execute: (ctx, a) => moveElement(ctx.doc, a.id, a.x, a.y),
      }),
      defineCommand<{ id: ElementId; w: number; h: number }, void>({
        name: "resize",
        label: "common:action.ok",
        quick: true,
        enabled: (ctx, a) => a !== undefined && capabilitiesOf(ctx, a.id).resize,
        execute: (ctx, a) => resizeElement(ctx.doc, a.id, a.w, a.h),
      }),
      defineCommand<ImportResult, ElementId[]>({
        name: "paste-import",
        label: "common:action.ok",
        quick: true,
        execute: (ctx, result) => [...pasteImport(ctx, result).ids.values()],
      }),
      defineCommand<undefined, void>({
        name: "insert-then-fail",
        label: "common:action.ok",
        quick: true,
        execute(ctx) {
          ctx.run(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
          throw new Error("fails after inserting");
        },
      }),
    ],
  },
});

/** The origin of the editor's text binding in these tests. */
const BINDING = "test:text-binding";

function setup(mode: Mode = "quick", doc: Y.Doc = new Y.Doc()) {
  if (roots0(doc)) initDocument(doc);
  const undo = createUndoManager(doc, { origins: [BINDING] });
  const i18n = createI18n({ dev: false, locale: "en", storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  const problems = host.load([...exampleExtensions, editorExtension]);
  const services = createTestServices(doc, { mode });
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const run = <R = unknown>(id: string, args?: unknown) =>
    host.commands.execute<R>(id, env(), args);
  const gone = (id: ElementId) => new Resolver(yLookup(doc)).isGone(id);
  const element = (id: ElementId) => toSnapshot(doc).elements[id] as ExtensionElement;
  return { doc, undo, i18n, host, problems, services, env, run, gone, element };
}

/** True if the document has not been initialized yet. */
function roots0(doc: Y.Doc): boolean {
  return doc.getMap("meta").size === 0;
}

function created<R>(outcome: { ok: boolean; value?: R; error?: unknown }): R {
  if (!outcome.ok) throw new Error(`command failed: ${String(outcome.error)}`);
  return outcome.value as R;
}

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

/** A tool session as the editor would give it, recording what the tool asks for. */
function session(t: ReturnType<typeof setup>) {
  const log = { overlays: 0, edited: [] as ElementId[], done: 0 };
  const s: ToolSession = {
    environment: t.env,
    run: (id, args) => t.host.commands.execute(id, t.env(), args),
    gesture: () => t.host.commands.beginGesture(t.env()),
    scale: () => 1,
    requestOverlay: () => (log.overlays += 1),
    editText: (id) => log.edited.push(id),
    setCursor: () => {},
    done: () => (log.done += 1),
  };
  return { s, log };
}

const PNG_ASSET_BYTES = (() => {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 640);
  view.setUint32(20, 480);
  return bytes;
})();

/** An asset store with a stand-in hash (the real one is SHA-256). */
function fakeStore(): AssetStore & { bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    async put(data, facts) {
      let h = 2166136261;
      for (const b of data) h = Math.imul(h ^ b, 16777619) >>> 0;
      const id = `sha256-${h.toString(16).padStart(8, "0").repeat(8)}` as AssetId;
      bytes.set(id, data);
      const info: AssetInfo = { ...facts, byteLength: data.length };
      return { id, info };
    },
    async get(id) {
      return bytes.get(id);
    },
  };
}

describe("registration", () => {
  it("loads the three examples without problems and offers their contributions", () => {
    const t = setup();
    expect(t.problems).toEqual([]);
    expect(t.host.active()).toEqual([
      "examples.text",
      "examples.shape",
      "examples.image",
      "examples.select",
      EDITOR,
    ]);
    expect(t.host.elementViews().map((r) => r.id)).toEqual([
      TEXT_TYPE,
      SHAPE_TYPE,
      IMAGE_TYPE,
    ]);
    expect(t.host.tools("quick").map((r) => r.id)).toEqual([
      "examples.text/text",
      "examples.shape/rect",
      "examples.shape/ellipse",
      "examples.shape/triangle",
      "examples.select/select",
    ]);
    expect(t.host.importersFor({ name: "photo.PNG" }).map((r) => r.id)).toEqual([
      "examples.image/files",
    ]);
    expect(t.host.exporters().map((r) => r.id)).toEqual(["examples.text/outline"]);
    expect(t.host.panels("advanced").map((r) => r.id)).toEqual([
      "examples.text/defaults",
    ]);
    // The example text is registered with the program's translations.
    expect(t.i18n.t("examples:shape.kind.triangle")).toBe("Triangle");
  });

  it("marks which commands, panels and properties quick mode offers", () => {
    const t = setup();
    const quick = t.host.commands.list("quick").map((c) => c.id);
    const advanced = t.host.commands.list("advanced").map((c) => c.id);
    expect(quick).toContain(TEXT_INSERT);
    expect(quick).not.toContain(TEXT_SET_DEFAULT);
    expect(advanced).toContain(TEXT_SET_DEFAULT);
    expect(t.host.panels("quick")).toEqual([]);
    expect(t.host.properties(TEXT_TYPE, "quick").map((f) => f.key)).toEqual([
      "fontSize",
      "color",
      "align",
    ]);
    expect(t.host.properties(TEXT_TYPE, "advanced").map((f) => f.key)).toEqual([
      "fontSize",
      "color",
      "align",
      "fontFamily",
    ]);
    // An advanced command does not run in quick mode.
    expect(
      t.run(TEXT_SET_DEFAULT, { ids: [], key: "defaultFontSize", value: 30 }),
    ).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(t.host.commands.shortcuts("quick").map.get("t")).toBeUndefined();
  });
});

describe("one command is one undo step", () => {
  it("inserts a text box and undoes and redoes it in one step", () => {
    const t = setup();
    const before = t.undo.undoStack.length;
    const id = created(t.run<ElementId>(TEXT_INSERT, { text: "Hello" }));
    expect(t.undo.undoStack.length).toBe(before + 1);
    const text = t.element(id);
    expect(text.type).toBe(TEXT_TYPE);
    expect(text.typeVersion).toBe(2);
    expect(text.data["text"]).toEqual({ $y: "text", delta: [{ insert: "Hello" }] });
    // Placed in the middle of the view.
    expect(text.pos.x + text.size.w / 2).toBeCloseTo(500);

    t.undo.undo();
    expect(t.gone(id)).toBe(true);
    t.undo.redo();
    expect(t.gone(id)).toBe(false);
  });

  it("changes the style of several shapes in one step", () => {
    const t = setup();
    const a = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 }),
    );
    const b = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "ellipse", x: 20, y: 0, w: 10, h: 10 }),
    );
    const before = t.undo.undoStack.length;
    expect(
      created(t.run(SHAPE_SET_STYLE, { ids: [a, b], key: "fill", value: "#ff0000" })),
    ).toBe(undefined);
    expect(t.undo.undoStack.length).toBe(before + 1);
    expect(t.element(a).data["fill"]).toBe("#ff0000");
    expect(t.element(b).data["fill"]).toBe("#ff0000");
    t.undo.undo();
    expect(t.element(a).data["fill"]).toBe("#93c5fd");
    expect(t.element(b).data["fill"]).toBe("#93c5fd");
  });

  it("refuses data the type's reader does not accept, before writing anything", () => {
    const t = setup();
    const a = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 }),
    );
    const before = t.undo.undoStack.length;
    const outcome = t.run(SHAPE_SET_STYLE, { ids: [a], key: "opacity", value: 7 });
    expect(outcome.ok).toBe(false);
    expect(t.undo.undoStack.length).toBe(before);
    expect(t.element(a).data["opacity"]).toBe(1);
  });

  it("leaves no trace of a command that fails after changing the document", () => {
    const t = setup();
    const count = Object.keys(toSnapshot(t.doc).elements).length;
    const before = t.undo.undoStack.length;
    const outcome = t.run(`${EDITOR}/insert-then-fail`);
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(t.undo.undoStack.length).toBe(before);
    expect(t.undo.redoStack.length).toBe(0);
    const snapshot = toSnapshot(t.doc);
    const resolver = new Resolver(yLookup(t.doc));
    const visible = Object.keys(snapshot.elements).filter((id) => !resolver.isGone(id));
    expect(visible.length).toBe(count);
  });
});

describe("text", () => {
  it("reads version 1 data, and upgrades it before an edit, keeping the upgrade on undo", () => {
    const t = setup();
    // An element written by version 1 of the extension.
    const id = addElement(t.doc, {
      type: TEXT_TYPE,
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 200, h: 30 },
      data: {
        text: { $y: "text", delta: [{ insert: "Old" }] },
        fontSize: 18,
        color: "#000",
      },
    });
    const read = t.host.read(t.element(id))!;
    expect(read.problems).toEqual([]);
    expect(read.model).toMatchObject({ fontSize: 18, fontFamily: "sans", align: "left" });
    const before = toSnapshot(t.doc).elements[id]!;

    const steps = t.undo.undoStack.length;
    created(t.run(TEXT_SET_STYLE, { ids: [id], key: "fontSize", value: 32 }));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    const after = t.element(id);
    expect(after.typeVersion).toBe(2);
    // Version 2's new keys are not written: their defaults mean what version 1 implied.
    expect(after.data).toEqual({ ...before.data, fontSize: 32 });

    // Undo takes back the edit, not the upgrade, which changed no meaning.
    t.undo.undo();
    const undone = t.element(id);
    expect(undone.typeVersion).toBe(2);
    expect(undone.data).toEqual(before.data);
    expect(t.host.read(undone)!.model).toEqual(read.model);
  });

  it("keeps a peer's concurrent edit when both upgrade, whichever client wins, and after an undo", () => {
    for (const [ca, cb] of [
      [1000, 2000],
      [2000, 1000],
    ] as const) {
      const base = new Y.Doc();
      initDocument(base);
      const id = addElement(base, {
        type: TEXT_TYPE,
        typeVersion: 1,
        x: 0,
        y: 0,
        size: { w: 200, h: 30 },
        data: {
          text: { $y: "text", delta: [{ insert: "Old" }] },
          fontSize: 18,
          color: "#000",
        },
      });
      const a = setup("advanced", forkDoc(base, ca));
      const b = setup("advanced", forkDoc(base, cb));
      created(a.run(TEXT_SET_STYLE, { ids: [id], key: "color", value: "#f00" }));
      created(b.run(TEXT_SET_STYLE, { ids: [id], key: "align", value: "center" }));
      syncDocs(a.doc, b.doc);
      expect(b.host.read(b.element(id))!.model).toMatchObject({
        align: "center",
        color: "#f00",
      });
      a.undo.undo();
      syncDocs(a.doc, b.doc);
      const element = b.element(id);
      expect(element.typeVersion).toBe(2);
      expect(b.host.read(element)!.model).toMatchObject({
        align: "center",
        color: "#000",
      });
    }
  });

  it("draws through the renderer's text layout and offers in-place editing", () => {
    const t = setup();
    const id = created(t.run<ElementId>(TEXT_INSERT, { text: "Hi", x: 0, y: 0, w: 100 }));
    const ctx = createRecordingDrawContext();
    t.host.drawElement(ctx, t.element(id), id);
    expect(ctx.calls).toEqual([
      expect.objectContaining({ op: "text", text: "Hi", x: 0, y: 0 }),
    ]);
    const { model } = t.host.read(t.element(id))!;
    const target = t.host.elementType(TEXT_TYPE)!.editing!.textEditing!(model, {
      id,
      w: 100,
      h: 30,
    });
    expect(target).toMatchObject({ key: "text", autoHeight: true });
    // A few pixels tall: a bar instead of text.
    const tiny = createRecordingDrawContext({ detail: "box" });
    t.host.drawElement(tiny, t.element(id), id);
    expect(tiny.calls.map((c) => c.op)).toEqual(["begin-opacity", "fill", "end-opacity"]);
  });

  it("its tool inserts a box where the user clicks and starts editing it", () => {
    const t = setup();
    const { s, log } = session(t);
    const handler = t.host
      .tools()
      .find((r) => r.id === "examples.text/text")!
      .definition.start(s);
    handler.pointerDown!(pointer({ x: 40, y: 50 }));
    expect(log.edited).toHaveLength(1);
    expect(log.done).toBe(1);
    expect(t.element(log.edited[0]!).pos).toMatchObject({ x: 40, y: 50 });
  });

  it("its panel shows and changes the document's default font size", () => {
    const t = setup("advanced");
    const panel = t.host
      .panels()
      .find((r) => r.id === "examples.text/defaults")!.definition;
    if (panel.content.kind !== "fields") throw new Error("expected fields");
    const field = panel.content.fields[0]!;
    const ctx = t.host.commands.context(t.env());
    expect(field.get(ctx)).toBe(24);
    created(t.run(field.command, { ids: [], key: field.key, value: 30 }));
    expect(toSnapshot(t.doc).settings[DEFAULT_SIZE_SETTING]).toBe(30);
    expect(field.get(ctx)).toBe(30);
    t.undo.undo();
    expect(field.get(ctx)).toBe(24);
  });

  it("exports only what is left after purging for sharing", async () => {
    const t = setup();
    created(t.run<ElementId>(TEXT_INSERT, { text: "Kept" }));
    const removed = created(t.run<ElementId>(TEXT_INSERT, { text: "Secret" }));
    deleteElements(t.doc, [removed]);
    const input = prepareExport(t.doc, fakeStore());
    expect(Object.keys(input.snapshot.elements)).toHaveLength(1);
    const chunks: Uint8Array[] = [];
    const exporter = t.host.exporters().find((r) => r.id === "examples.text/outline")!;
    await exporter.definition.write(
      input,
      { write: async (chunk) => void chunks.push(chunk) },
      {
        cancellation: { cancelled: false, onCancel: () => () => {} },
        progress: () => {},
      },
    );
    const text = String.fromCharCode(...chunks.flatMap((c) => [...c]));
    expect(text).toBe("Kept");
  });
});

describe("shape", () => {
  it("its tool shows a preview while dragging and makes the shape with one command", () => {
    const t = setup();
    const { s, log } = session(t);
    const tool = t.host
      .tools()
      .find((r) => r.id === "examples.shape/ellipse")!.definition;
    const handler = tool.start(s);
    const steps = t.undo.undoStack.length;
    handler.pointerDown!(pointer({ x: 10, y: 10 }));
    handler.pointerMove!(pointer({ x: 60, y: 40 }));
    expect(log.overlays).toBe(1);
    const overlay = createRecordingDrawContext();
    handler.drawOverlay!(overlay);
    expect(overlay.calls[0]).toEqual({ op: "begin-offset", x: 10, y: 10 });
    expect(overlay.calls[1]).toMatchObject({
      op: "stroke",
      path: ["ellipse(25,15,25,15,0,0,6.283185307179586)"],
    });
    // Nothing is written while dragging.
    expect(t.undo.undoStack.length).toBe(steps);

    handler.pointerUp!(pointer({ x: 60, y: 40 }));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(log.done).toBe(1);
    const shapes = Object.entries(toSnapshot(t.doc).elements).filter(
      ([, e]) => e.type === SHAPE_TYPE,
    );
    expect(shapes).toHaveLength(1);
    const [, shape] = shapes[0]!;
    expect(shape.pos).toMatchObject({ x: 10, y: 10 });
    expect((shape as ExtensionElement).size).toEqual({ w: 50, h: 30 });
    expect(shape.data["kind"]).toBe("ellipse");
  });

  it("Escape cancels a drag without writing anything", () => {
    const t = setup();
    const { s } = session(t);
    const handler = t.host
      .tools()
      .find((r) => r.id === "examples.shape/rect")!
      .definition.start(s);
    handler.pointerDown!(pointer({ x: 0, y: 0 }));
    handler.pointerMove!(pointer({ x: 30, y: 30 }));
    expect(
      handler.keyDown!({
        key: "Escape",
        modifiers: pointer({ x: 0, y: 0 }).modifiers,
        repeat: false,
      }),
    ).toBe(true);
    handler.pointerUp!(pointer({ x: 30, y: 30 }));
    expect(Object.keys(toSnapshot(t.doc).elements)).toHaveLength(0);
  });

  it("hit-tests its outline and reports bounds that include the stroke", () => {
    const model = shapeView.read({ kind: "ellipse", strokeWidth: 4 }, 1, () => {});
    const box = { id: "e", w: 100, h: 50 };
    expect(shapeView.hitTest!(model, { x: 50, y: 25 }, box, 0)).toBe(true);
    expect(shapeView.hitTest!(model, { x: 2, y: 2 }, box, 0)).toBe(false);
    expect(shapeView.bounds!(model, box)).toEqual({ x: -2, y: -2, w: 104, h: 54 });
  });
});

describe("image", () => {
  it("inserts an image and registers its asset in the same command", () => {
    const t = setup();
    const asset = `sha256-${"a".repeat(64)}` as AssetId;
    const info: AssetInfo = {
      mediaType: "image/png",
      byteLength: 10,
      width: 800,
      height: 600,
    };
    const steps = t.undo.undoStack.length;
    const id = created(t.run<ElementId>(IMAGE_INSERT, { asset, info }));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    const snapshot = toSnapshot(t.doc);
    expect(snapshot.assets[asset]).toEqual(info);
    // Scaled to fit half the view (1000 x 800).
    expect((snapshot.elements[id] as ExtensionElement).size).toEqual({ w: 500, h: 375 });

    const ctx = createRecordingDrawContext();
    t.host.drawElement(ctx, snapshot.elements[id]!, id);
    expect(ctx.calls).toContainEqual({
      op: "image",
      asset,
      dest: { x: 0, y: 0, w: 500, h: 375 },
    });
    // Bytes not available: a stand-in that says so.
    const missing = createRecordingDrawContext({
      missing: [asset],
      t: (l) => t.i18n.t(l),
    });
    t.host.drawElement(missing, snapshot.elements[id]!, id);
    expect(missing.calls).toContainEqual(
      expect.objectContaining({ op: "text", text: "Image missing" }),
    );
  });

  it("imports an image file as a fragment that is pasted in one step", async () => {
    const t = setup();
    const store = fakeStore();
    const importer = t.host.importersFor({
      name: "photo.png",
      mediaType: "image/png",
    })[0]!;
    expect(importer.definition.sniff!(PNG_ASSET_BYTES.subarray(0, 16))).toBe(true);
    const progress: Array<number | undefined> = [];
    const result = await importer.definition.read(
      {
        name: "photo.png",
        mediaType: "image/png",
        size: PNG_ASSET_BYTES.length,
        bytes: async () => PNG_ASSET_BYTES,
        chunks: async function* () {
          yield PNG_ASSET_BYTES;
        },
      },
      {
        cancellation: { cancelled: false, onCancel: () => () => {} },
        progress: (f) => progress.push(f),
        assets: store,
      },
    );
    expect(result.notices).toEqual([]);
    expect(progress).toEqual([undefined, 1]);
    expect(store.bytes.size).toBe(1);

    const steps = t.undo.undoStack.length;
    const [id] = created(t.run<ElementId[]>(`${EDITOR}/paste-import`, result));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    const pasted = t.element(id!);
    expect(pasted.type).toBe(IMAGE_TYPE);
    expect(pasted.size).toEqual({ w: 640, h: 480 });
    const [asset] = store.bytes.keys();
    expect(toSnapshot(t.doc).assets[asset as AssetId]).toMatchObject({
      width: 640,
      height: 480,
    });
    t.undo.undo();
    expect(t.gone(id!)).toBe(true);
  });

  it("stops when cancelled", async () => {
    const t = setup();
    const importer = t.host.importers()[0]!.definition;
    await expect(
      importer.read(
        {
          name: "x.png",
          mediaType: undefined,
          size: undefined,
          bytes: async () => PNG_ASSET_BYTES,
          chunks: async function* () {},
        },
        {
          cancellation: { cancelled: true, onCancel: () => () => {} },
          progress: () => {},
          assets: fakeStore(),
        },
      ),
    ).rejects.toMatchObject({ name: "CancelledError" });
  });
});

describe("elements whose extension is missing", () => {
  it("are drawn as placeholders, can be moved, and cannot be resized or edited", () => {
    const t = setup();
    // A chart from an extension this program does not have, and a text box from a
    // newer version of the text extension.
    const chart = addElement(t.doc, {
      type: "examples.chart/chart",
      typeVersion: 1,
      x: 0,
      y: 0,
      size: { w: 300, h: 200 },
      data: { series: { $y: "map", entries: {} }, kind: "bar" },
    });
    const newer = addElement(t.doc, {
      type: TEXT_TYPE,
      typeVersion: 3,
      x: 0,
      y: 300,
      size: { w: 300, h: 40 },
      data: { body: "written by version 3" },
    });
    const chartBefore = t.element(chart);

    expect(t.host.resolve(chartBefore)).toEqual({
      status: "placeholder",
      reason: "missing",
    });
    expect(t.host.resolve(t.element(newer))).toEqual({
      status: "placeholder",
      reason: "newer",
    });
    expect(t.host.capabilities(chartBefore)).toEqual({
      resize: false,
      rotate: false,
      editContent: false,
    });

    const ctx = createRecordingDrawContext({ t: (l, v) => t.i18n.t(l, v) });
    t.host.drawElement(ctx, chartBefore, chart);
    expect(ctx.calls[0]).toMatchObject({ op: "fill", path: ["rect(0,0,300,200)"] });
    expect(ctx.calls[1]).toMatchObject({ op: "stroke" });
    expect(ctx.calls).toContainEqual(
      expect.objectContaining({
        op: "text",
        text: "Missing extension: examples.chart/chart",
      }),
    );
    const newerCtx = createRecordingDrawContext({ t: (l, v) => t.i18n.t(l, v) });
    t.host.drawElement(newerCtx, t.element(newer), newer);
    expect(newerCtx.calls).toContainEqual(
      expect.objectContaining({
        op: "text",
        text: "Needs a newer version of the extension: examples.text/text",
      }),
    );

    // Moving is an envelope change: allowed, data untouched.
    created(t.run(`${EDITOR}/move`, { id: chart, x: 50, y: 60 }));
    const moved = t.element(chart);
    expect(moved.pos).toMatchObject({ x: 50, y: 60 });
    expect(moved.data).toEqual(chartBefore.data);
    // Resizing and content edits are not.
    expect(t.run(`${EDITOR}/resize`, { id: chart, w: 10, h: 10 })).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(t.run(TEXT_SET_STYLE, { ids: [newer], key: "fontSize", value: 40 })).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(t.element(newer).data).toEqual({ body: "written by version 3" });
    expect(t.element(newer).typeVersion).toBe(3);
  });

  it("become placeholders when their extension is unloaded, with their data kept", () => {
    const t = setup();
    const id = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "triangle", x: 0, y: 0, w: 10, h: 10 }),
    );
    const data = t.element(id).data;
    expect(t.host.unload("examples.shape")).toEqual(["examples.shape"]);
    expect(t.host.resolve(t.element(id))).toEqual({
      status: "placeholder",
      reason: "missing",
    });
    expect(t.host.commands.get(SHAPE_INSERT)).toBeUndefined();
    expect(t.element(id).data).toEqual(data);
    // Loading it again brings the type back.
    expect(t.host.load([exampleExtensions[1]!])).toEqual([]);
    expect(t.host.resolve(t.element(id)).status).toBe("known");
  });
});

describe("viewing parts alone", () => {
  it("load in the viewing host and draw, without the editing parts", () => {
    const t = setup();
    const id = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 }),
    );
    const viewer = new ViewHost();
    expect(viewer.load(exampleViewExtensions)).toEqual([]);
    const ctx = createRecordingDrawContext();
    viewer.drawElement(ctx, t.element(id), id);
    expect(ctx.calls.map((c) => c.op)).toEqual([
      "begin-opacity",
      "fill",
      "stroke",
      "end-opacity",
    ]);
  });
});

describe("text editing", () => {
  function typing(
    t: ReturnType<typeof setup>,
    id: ElementId,
    at: number,
    text: string,
  ): void {
    const shared = dataMap(t.doc, id).get("text") as Y.Text;
    edit(t.doc, () => shared.insert(at, text), { origin: BINDING });
  }

  it("makes typing and the box growing with it one undo step, and a command a step of its own", () => {
    const t = setup();
    const id = created(t.run<ElementId>(TEXT_INSERT, { text: "", x: 0, y: 0, w: 100 }));
    const steps = t.undo.undoStack.length;
    const height = t.element(id).size.h;
    // What the editor does on each keystroke: the binding's transaction, then,
    // when the laid-out height changed, the resize with the binding's origin.
    typing(t, id, 0, "Hello");
    typing(t, id, 5, "\nworld");
    resizeElement(t.doc, id, 100, height * 2, { origin: BINDING });
    expect(t.undo.undoStack.length).toBe(steps + 1);

    // Bold for the selected word, through the text service: its own step.
    t.services.state.text = { id, key: "text", index: 6, length: 5 };
    created(t.run(TEXT_TOGGLE_BOLD));
    expect(t.undo.undoStack.length).toBe(steps + 2);
    expect(t.element(id).data["text"]).toEqual({
      $y: "text",
      delta: [{ insert: "Hello\n" }, { insert: "world", attributes: { bold: true } }],
    });
    // Again: everything selected is bold, so bold comes off.
    created(t.run(TEXT_TOGGLE_BOLD));
    expect(t.element(id).data["text"]).toEqual({
      $y: "text",
      delta: [{ insert: "Hello\nworld" }],
    });

    t.undo.undo();
    t.undo.undo();
    t.undo.undo();
    expect(t.element(id).data["text"]).toEqual({ $y: "text", delta: [] });
    expect(t.element(id).size.h).toBe(height);
  });

  it("offers bold only while text is selected in a text box", () => {
    const t = setup();
    const id = created(t.run<ElementId>(TEXT_INSERT, { text: "Hi" }));
    expect(t.host.commands.isEnabled(TEXT_TOGGLE_BOLD, t.env())).toBe(false);
    t.services.state.text = { id, key: "text", index: 0, length: 0 };
    expect(t.host.commands.isEnabled(TEXT_TOGGLE_BOLD, t.env())).toBe(false);
    t.services.state.text = { id, key: "text", index: 0, length: 2 };
    expect(t.host.commands.isEnabled(TEXT_TOGGLE_BOLD, t.env())).toBe(true);
  });
});

describe("continuous field controls", () => {
  it("preview while dragging and write one step at the end", () => {
    const t = setup("advanced");
    const id = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 }),
    );
    const field = t.host
      .properties(SHAPE_TYPE, "advanced")
      .find((f) => f.key === "opacity")!;
    const steps = t.undo.undoStack.length;
    let updates = 0;
    t.doc.on("update", () => updates++);
    const gesture = t.host.commands.beginGesture(t.env());
    for (const value of [0.9, 0.7, 0.5, 0.3])
      gesture.preview({ [id]: { data: { opacity: value } } });
    expect(updates).toBe(0);
    expect(t.services.state.preview).toEqual({ [id]: { data: { opacity: 0.3 } } });
    created(gesture.commit(field.command, { ids: [id], key: field.key, value: 0.3 }));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(t.element(id).data["opacity"]).toBe(0.3);
  });
});

describe("selection tool, written against the editor services", () => {
  function shapes(t: ReturnType<typeof setup>) {
    const a = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 50, h: 50 }),
    );
    const b = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 200, y: 100, w: 50, h: 50 }),
    );
    return { a, b };
  }
  const tool = (t: ReturnType<typeof setup>) => {
    const { s } = session(t);
    return t.host
      .tools()
      .find((r) => r.id === "examples.select/select")!
      .definition.start(s);
  };

  it("selects by clicking, with Shift to add, and with a rubber band", () => {
    const t = setup();
    const { a, b } = shapes(t);
    const handler = tool(t);
    handler.pointerDown!(pointer({ x: 10, y: 10 }));
    handler.pointerUp!(pointer({ x: 10, y: 10 }));
    expect(t.services.state.selection).toEqual([a]);
    const shift = { ...pointer({ x: 0, y: 0 }).modifiers, shift: true };
    handler.pointerDown!(pointer({ x: 210, y: 110 }, { modifiers: shift }));
    handler.pointerUp!(pointer({ x: 210, y: 110 }, { modifiers: shift }));
    expect(t.services.state.selection).toEqual([a, b]);
    // A rubber band from empty canvas.
    handler.pointerDown!(pointer({ x: 190, y: 90 }));
    expect(t.services.state.selection).toEqual([]);
    handler.pointerMove!(pointer({ x: 300, y: 300 }));
    handler.pointerUp!(pointer({ x: 300, y: 300 }));
    expect(t.services.state.selection).toEqual([b]);
    expect(t.undo.undoStack.length).toBe(2);
  });

  it("moves the selection with a preview, snapping to another element, in one step and one transaction", () => {
    const t = setup();
    const { a, b } = shapes(t);
    const handler = tool(t);
    const steps = t.undo.undoStack.length;
    let updates = 0;
    t.doc.on("update", () => updates++);
    handler.pointerDown!(pointer({ x: 10, y: 10 }));
    for (let i = 1; i <= 30; i++)
      handler.pointerMove!(pointer({ x: 10 + i * 6, y: 10 + i }));
    // 196 is 4 world units from b's left edge (200): it snaps there.
    handler.pointerMove!(pointer({ x: 206, y: 40 }));
    expect(updates).toBe(0);
    expect(t.services.state.preview).toEqual({ [a]: { x: 200, y: 30 } });
    handler.pointerUp!(pointer({ x: 206, y: 40 }));
    expect(t.services.state.preview).toBeNull();
    expect(updates).toBeLessThanOrEqual(2);
    expect(t.undo.undoStack.length).toBe(steps + 1);
    expect(t.element(a).pos).toMatchObject({ x: 200, y: 30 });
    expect(t.element(b).pos).toMatchObject({ x: 200, y: 100 });
    t.undo.undo();
    expect(t.element(a).pos).toMatchObject({ x: 0, y: 0 });
  });

  it("cancels a move with Escape, writing nothing", () => {
    const t = setup();
    const { a } = shapes(t);
    const handler = tool(t);
    let updates = 0;
    t.doc.on("update", () => updates++);
    handler.pointerDown!(pointer({ x: 10, y: 10 }));
    handler.pointerMove!(pointer({ x: 80, y: 80 }));
    expect(
      handler.keyDown!({
        key: "Escape",
        modifiers: pointer({ x: 0, y: 0 }).modifiers,
        repeat: false,
      }),
    ).toBe(true);
    handler.pointerUp!(pointer({ x: 80, y: 80 }));
    expect(updates).toBe(0);
    expect(t.element(a).pos).toMatchObject({ x: 0, y: 0 });
    expect(t.services.state.preview).toBeNull();
  });

  it("selects all through the selection service, without an undo step", () => {
    const t = setup();
    const { a, b } = shapes(t);
    const steps = t.undo.undoStack.length;
    created(t.run(SELECT_ALL));
    expect(t.services.state.selection).toEqual([a, b]);
    expect(t.undo.undoStack.length).toBe(steps);
  });
});

describe("scaling groups and selections", () => {
  it("keeps proportions, and moves elements of a missing extension without resizing them", () => {
    const t = setup();
    const shape = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "rect", x: 10, y: 10, w: 20, h: 20 }),
    );
    const chart = addElement(t.doc, {
      type: "examples.chart/chart",
      x: 50,
      y: 10,
      size: { w: 40, h: 20 },
      data: { kind: "bar" },
    });
    const g = group(t.doc, [shape, chart]);
    const loose = created(
      t.run<ElementId>(SHAPE_INSERT, { kind: "ellipse", x: 100, y: 0, w: 10, h: 10 }),
    );
    expect(t.host.capabilities({ type: GROUP_TYPE, typeVersion: 1 }).resize).toBe(true);

    const steps = t.undo.undoStack.length;
    created(t.run(SELECT_SCALE, { ids: [g, loose], anchor: { x: 0, y: 0 }, factor: 2 }));
    expect(t.undo.undoStack.length).toBe(steps + 1);
    const r = new Resolver(yLookup(t.doc));
    const world = (id: ElementId) => r.worldOrigin(id);
    expect(world(shape)).toEqual({ x: 20, y: 20 });
    expect(t.element(shape).size).toEqual({ w: 40, h: 40 });
    // The chart's centre (70, 20) goes to (140, 40); its size stays 40 x 20.
    expect(t.element(chart).size).toEqual({ w: 40, h: 20 });
    expect(world(chart)).toEqual({ x: 120, y: 30 });
    expect(world(loose)).toEqual({ x: 200, y: 0 });
    expect(t.element(loose).size).toEqual({ w: 20, h: 20 });

    t.undo.undo();
    expect(new Resolver(yLookup(t.doc)).worldOrigin(chart)).toEqual({ x: 50, y: 10 });
    expect(t.element(shape).size).toEqual({ w: 20, h: 20 });
  });
});
