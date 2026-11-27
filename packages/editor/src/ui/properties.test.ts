// SPDX-License-Identifier: GPL-3.0-or-later

// The properties panel's model (docs/adr/0005, section 3.9; docs/adr/0016):
// fields per element type and mode, shown only where they apply to every
// selected element, a mixed state where the values differ, one undo step per
// change, and a colour drag previewed without writing and committed once.

import type { ElementId } from "@galatsa/core";
import { roots } from "@galatsa/core/ydoc";
import { SHAPE_INSERT, SHAPE_TYPE, shapeExtension } from "@galatsa/extension-shape";
import { TEXT_COMMANDS, TEXT_TYPE, textExtension } from "@galatsa/extension-text";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../extensions.ts";
import { testEditor, testI18n } from "../test-support.ts";
import { changeField, FieldGesture, propertiesModel } from "./properties.ts";

function setup(mode: "quick" | "advanced" = "quick") {
  const i18n = testI18n();
  const loaded = loadExtensions(i18n, [textExtension, shapeExtension]);
  expect(loaded.problems).toEqual([]);
  const { editor } = testEditor({ i18n, host: loaded.host, mode });
  const shape = (kind: string, fill?: string): ElementId => {
    const made = editor.run<ElementId>(SHAPE_INSERT, {
      kind,
      x: 0,
      y: 0,
      w: 40,
      h: kind === "line" ? 0 : 30,
      ...(fill !== undefined ? { style: { fill } } : {}),
    });
    if (!made.ok) throw new Error(`no ${kind}`);
    return made.value;
  };
  const data = (id: ElementId) =>
    (
      roots(editor.doc).elements.get(id)!.get("data") as {
        toJSON(): Record<string, unknown>;
      }
    ).toJSON();
  return { editor, shape, data };
}

const keys = (fields: readonly { key: string }[]) => fields.map((f) => f.key);

describe("the properties panel", () => {
  it("shows nothing without a selection", () => {
    const { editor, shape } = setup();
    shape("rect");
    editor.services.selection.set([]);
    expect(propertiesModel(editor)).toEqual([]);
  });

  it("shows a type's fields for the mode, only where they apply to all", () => {
    const quick = setup();
    const rect = quick.shape("rect");
    quick.editor.services.selection.set([rect]);
    const [section] = propertiesModel(quick.editor);
    expect(section!.type).toBe(SHAPE_TYPE);
    expect(keys(section!.fields)).toEqual(["fill", "stroke", "strokeWidth"]);

    // Fill applies only to closed outlines: not with a line in the selection.
    const line = quick.shape("line");
    quick.editor.services.selection.set([rect, line]);
    expect(keys(propertiesModel(quick.editor)[0]!.fields)).toEqual([
      "stroke",
      "strokeWidth",
    ]);

    const advanced = setup("advanced");
    const r = advanced.shape("rect");
    const e = advanced.shape("ellipse");
    advanced.editor.services.selection.set([r]);
    expect(keys(propertiesModel(advanced.editor)[0]!.fields)).toContain("cornerRadius");
    // Corner rounding is for kinds with corners only.
    advanced.editor.services.selection.set([r, e]);
    expect(keys(propertiesModel(advanced.editor)[0]!.fields)).not.toContain(
      "cornerRadius",
    );
  });

  it("shows a mixed state when the values differ, and one section per type", () => {
    const { editor, shape } = setup();
    const a = shape("rect", "#ff0000");
    const b = shape("rect", "#00ff00");
    editor.services.selection.set([a, b]);
    const fill = propertiesModel(editor)[0]!.fields.find((f) => f.key === "fill")!;
    expect(fill).toMatchObject({ mixed: true, value: "#ff0000", ids: [a, b] });
    const stroke = propertiesModel(editor)[0]!.fields.find((f) => f.key === "stroke")!;
    expect(stroke.mixed).toBe(false);

    const text = editor.run<ElementId>(TEXT_COMMANDS.insert, { x: 100, y: 100 });
    expect(text.ok).toBe(true);
    editor.services.selection.set([a, text.ok ? text.value : "", b]);
    const sections = propertiesModel(editor);
    expect(sections.map((s) => s.type)).toEqual([SHAPE_TYPE, TEXT_TYPE]);
    expect(sections[0]!.ids).toEqual([a, b]);
  });

  it("changes a value of every selected element as one undo step", () => {
    const { editor, shape, data } = setup();
    const a = shape("rect", "#ff0000");
    const b = shape("ellipse", "#00ff00");
    editor.services.selection.set([a, b]);
    const steps = editor.undo.undoStack.length;
    const fill = propertiesModel(editor)[0]!.fields.find((f) => f.key === "fill")!;
    expect(changeField(editor, fill, "#123456").ok).toBe(true);
    expect(editor.undo.undoStack.length).toBe(steps + 1);
    expect([data(a)["fill"], data(b)["fill"]]).toEqual(["#123456", "#123456"]);
    expect(
      propertiesModel(editor)[0]!.fields.find((f) => f.key === "fill")!,
    ).toMatchObject({ mixed: false, value: "#123456" });
    editor.undo.undo();
    expect([data(a)["fill"], data(b)["fill"]]).toEqual(["#ff0000", "#00ff00"]);
  });

  it("previews a colour being dragged without writing, and commits it once", () => {
    const { editor, shape, data } = setup();
    const a = shape("rect", "#ff0000");
    editor.services.selection.set([a]);
    const steps = editor.undo.undoStack.length;
    let updates = 0;
    editor.doc.on("update", () => updates++);
    const fill = propertiesModel(editor)[0]!.fields.find((f) => f.key === "fill")!;
    const gesture = new FieldGesture(editor, fill);
    for (const value of ["#100000", "#200000", "#300000"]) gesture.preview(value);
    expect(updates).toBe(0);
    expect(data(a)["fill"]).toBe("#ff0000");
    expect(gesture.commit("#400000")?.ok).toBe(true);
    expect(data(a)["fill"]).toBe("#400000");
    expect(editor.undo.undoStack.length).toBe(steps + 1);

    // A cancelled drag writes nothing.
    const again = new FieldGesture(editor, fill);
    again.preview("#500000");
    again.cancel();
    expect(data(a)["fill"]).toBe("#400000");
    expect(editor.undo.undoStack.length).toBe(steps + 1);
  });
});
