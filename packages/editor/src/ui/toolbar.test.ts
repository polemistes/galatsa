// SPDX-License-Identifier: GPL-3.0-or-later

// The toolbar's model (docs/adr/0016): tools by group with the current one
// pressed, undo and redo following the history, commands with a `toolbar`
// group (a panel's toggle, pressed while the panel is open), and
// shortcuts as the keys are marked.

import { BASICS } from "@galatsa/extension-basics";
import { EXTENSION_API_VERSION } from "@galatsa/extension-api";
import { defineCommand, type EditExtension } from "@galatsa/extension-api/editing";
import { SHAPE_INSERT, shapeExtension } from "@galatsa/extension-shape";
import { textExtension } from "@galatsa/extension-text";
import { createI18n, memoryLocaleStorage } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../extensions.ts";
import { testEditor, testI18n } from "../test-support.ts";
import {
  pressButton,
  shortcutText,
  toolbarModel,
  type ToolbarButton,
} from "./toolbar.ts";

const PANEL = "test.toggle/panel";

/** A command with a toolbar button that opens and closes a panel (as the routes panel's does). */
const toggleExtension: EditExtension = {
  view: { id: "test.toggle", version: "0.0.0", api: EXTENSION_API_VERSION },
  contributes: {
    commands: [
      defineCommand<undefined, void>({
        name: "toggle",
        label: "common:action.ok",
        shortcuts: ["Shift+P"],
        quick: true,
        undoable: false,
        toolbar: "panels",
        active: (ctx) => ctx.services.panels.isOpen(PANEL),
        execute(ctx) {
          if (ctx.services.panels.isOpen(PANEL)) ctx.services.panels.close(PANEL);
          else ctx.services.panels.open(PANEL);
        },
      }),
    ],
  },
};

function setup() {
  const i18n = testI18n();
  const loaded = loadExtensions(i18n, [textExtension, shapeExtension, toggleExtension]);
  expect(loaded.problems).toEqual([]);
  return testEditor({ i18n, host: loaded.host }).editor;
}

const ids = (buttons: readonly ToolbarButton[]) => buttons.map((b) => b.id);

describe("the toolbar", () => {
  it("shows the tools by group, with the current one pressed, and picks them", () => {
    const editor = setup();
    const model = toolbarModel(editor);
    expect(ids(model.tools[0]!.buttons)).toEqual(["galatsa.select/select"]);
    expect(model.tools[0]!.buttons[0]!.pressed).toBe(true);
    const shapes = model.tools.find((g) => g.key === "tools:shapes")!;
    expect(ids(shapes.buttons)).toContain("galatsa.shape/rect");
    const rect = shapes.buttons.find((b) => b.id === "galatsa.shape/rect")!;
    expect(rect).toMatchObject({ pressed: false, shortcut: "r", enabled: true });
    expect(rect.icon).not.toBe("");

    pressButton(editor, rect);
    expect(editor.tools.current).toBe("galatsa.shape/rect");
    const after = toolbarModel(editor).tools.flatMap((g) => g.buttons);
    expect(after.filter((b) => b.pressed).map((b) => b.id)).toEqual([
      "galatsa.shape/rect",
    ]);
  });

  it("offers undo and redo as the history allows, and runs them", () => {
    const editor = setup();
    const history = () => toolbarModel(editor).history!.buttons;
    expect(ids(history())).toEqual([BASICS.undo, BASICS.redo]);
    expect(history().map((b) => b.enabled)).toEqual([false, false]);
    expect(history()[0]!.shortcut).toBe("Mod+z");

    const made = editor.run(SHAPE_INSERT, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
    expect(made.ok).toBe(true);
    expect(history().map((b) => b.enabled)).toEqual([true, false]);
    pressButton(editor, history()[0]!);
    expect(editor.undo.undoStack.length).toBe(0);
    expect(history().map((b) => b.enabled)).toEqual([false, true]);
    pressButton(editor, history()[1]!);
    expect(editor.undo.undoStack.length).toBe(1);
  });

  it("shows commands that ask for a button, by group, with their state", () => {
    const editor = setup();
    const toggle = () =>
      toolbarModel(editor)
        .commands.flatMap((g) => g.buttons)
        .find((b) => b.id === "test.toggle/toggle")!;
    expect(toolbarModel(editor).commands.map((g) => g.key)).toContain("commands:panels");
    expect(toggle()).toMatchObject({
      pressed: false,
      enabled: true,
      shortcut: "Shift+p",
    });
    pressButton(editor, toggle());
    expect(editor.services.panels.isOpen(PANEL)).toBe(true);
    expect(toggle().pressed).toBe(true);
    pressButton(editor, toggle());
    expect(toggle().pressed).toBe(false);
  });
});

describe("shortcuts in tooltips", () => {
  const i18n = createI18n({ locale: "nb", dev: false, storage: memoryLocaleStorage() });
  const setupNb = () => {
    loadExtensions(i18n, []);
    return (key: string) => i18n.t(key);
  };

  it("are written as the keys are marked", () => {
    const t = setupNb();
    const pc = { mac: false };
    expect(shortcutText("Mod+Shift+z", pc, t)).toBe("Ctrl+Skift+Z");
    expect(shortcutText("Shift+r", pc, t)).toBe("Skift+R");
    expect(shortcutText("Delete", pc, t)).toBe("Delete");
    expect(shortcutText("Mod++", pc, t)).toBe("Ctrl++");
    expect(shortcutText("Mod+[", pc, t)).toBe("Ctrl+[");
    const mac = { mac: true };
    expect(shortcutText("Mod+Shift+z", mac, t)).toBe("⇧⌘Z");
    expect(shortcutText("Ctrl+Alt+x", mac, t)).toBe("⌃⌥X");
    i18n.setLocale("en");
    expect(shortcutText("Mod+Shift+z", pc, t)).toBe("Ctrl+Shift+Z");
    expect(shortcutText(" ", pc, t)).toBe("Space");
  });
});
