// SPDX-License-Identifier: GPL-3.0-or-later

// The command registry: undo steps, nesting, gestures, modes and shortcuts.

import { FRAME_TYPE } from "@galatsa/core";
import {
  addElement,
  createUndoManager,
  initDocument,
  moveElement,
  setTitle,
  toSnapshot,
} from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { defineCommand, type CommandEnvironment } from "./command.ts";
import { ExtensionHost } from "./host.ts";
import { EXTENSION_API_VERSION, normalizeShortcut, type Mode } from "./ids.ts";

function setup(mode: Mode = "advanced") {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc);
  const host = new ExtensionHost();
  const frame = addElement(doc, { type: FRAME_TYPE, x: 0, y: 0, size: { w: 10, h: 10 } });
  undo.clear();
  const env = (): CommandEnvironment => ({ doc, undo, mode, selection: [] });
  host.load([
    {
      id: "t",
      version: "1.0.0",
      api: EXTENSION_API_VERSION,
      contributes: {
        commands: [
          defineCommand<string, void>({
            name: "title",
            label: "common:a",
            shortcuts: ["Mod+T"],
            execute: (ctx, title) => setTitle(ctx.doc, title),
          }),
          defineCommand<{ x: number }, void>({
            name: "move",
            label: "common:a",
            quick: true,
            shortcuts: ["mod+t"],
            execute: (ctx, a) => moveElement(ctx.doc, frame, a.x, 0),
          }),
          defineCommand<undefined, string>({
            name: "both",
            label: "common:a",
            quick: true,
            execute(ctx) {
              ctx.run("t/title", "Both");
              ctx.run("t/move", { x: 5 });
              return "done";
            },
          }),
          defineCommand<undefined, void>({
            name: "nested-disabled",
            label: "common:a",
            quick: true,
            execute: (ctx) => ctx.run("t/never"),
          }),
          defineCommand<undefined, void>({
            name: "never",
            label: "common:a",
            quick: true,
            enabled: () => false,
            execute: () => {},
          }),
          defineCommand<undefined, void>({
            name: "view",
            label: "common:a",
            quick: true,
            undoable: false,
            execute: () => {},
          }),
        ],
      },
    },
  ]);
  const title = () => toSnapshot(doc).title;
  const x = () => toSnapshot(doc).elements[frame]!.pos.x;
  return { doc, undo, host, env, title, x };
}

describe("command registry", () => {
  it("makes one undo step of a command that runs other commands", () => {
    const t = setup();
    const outcome = t.host.commands.execute("t/both", t.env());
    expect(outcome).toEqual({ ok: true, value: "done" });
    expect(t.undo.undoStack.length).toBe(1);
    expect([t.title(), t.x()]).toEqual(["Both", 5]);
    t.undo.undo();
    expect([t.title(), t.x()]).toEqual(["", 0]);
  });

  it("makes separate steps of separate commands, however fast they follow", () => {
    const t = setup();
    t.host.commands.execute("t/title", t.env(), "One");
    t.host.commands.execute("t/title", t.env(), "Two");
    expect(t.undo.undoStack.length).toBe(2);
    t.undo.undo();
    expect(t.title()).toBe("One");
  });

  it("does nothing for unknown and disabled commands", () => {
    const t = setup();
    expect(t.host.commands.execute("t/missing", t.env())).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(t.host.commands.execute("t/never", t.env())).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(t.host.commands.isEnabled("t/never", t.env())).toBe(false);
    const nested = t.host.commands.execute("t/nested-disabled", t.env());
    expect(nested).toMatchObject({ ok: false, reason: "failed" });
    expect(t.undo.undoStack.length).toBe(0);
  });

  it("offers advanced commands only in advanced mode", () => {
    const t = setup("quick");
    expect(t.host.commands.execute("t/title", t.env(), "X")).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(t.host.commands.isVisible("t/title", t.env())).toBe(false);
    expect(t.host.commands.list("quick").map((c) => c.id)).not.toContain("t/title");
  });

  it("runs commands that are not undoable without an undo step", () => {
    const t = setup();
    expect(t.host.commands.execute("t/view", t.env())).toEqual({
      ok: true,
      value: undefined,
    });
    expect(t.undo.undoStack.length).toBe(0);
  });

  it("builds the keyboard map per mode and reports conflicts", () => {
    const t = setup();
    const advanced = t.host.commands.shortcuts("advanced");
    expect(advanced.map.get("Mod+t")).toBe("t/title");
    expect(advanced.conflicts).toEqual([
      { shortcut: "Mod+t", kept: "t/title", ignored: "t/move" },
    ]);
    // In quick mode the advanced command is absent, so there is no conflict.
    const quick = t.host.commands.shortcuts("quick");
    expect(quick.map.get("Mod+t")).toBe("t/move");
    expect(quick.conflicts).toEqual([]);
  });
});

describe("gestures", () => {
  it("make one undo step of many commands, applied as they run", () => {
    const t = setup();
    const gesture = t.host.commands.beginGesture(t.env);
    for (const x of [1, 2, 3, 4]) {
      expect(gesture.run("t/move", { x }).ok).toBe(true);
      expect(t.x()).toBe(x);
    }
    gesture.commit();
    expect(t.undo.undoStack.length).toBe(1);
    expect(gesture.run("t/move", { x: 9 }).ok).toBe(false);
    t.undo.undo();
    expect(t.x()).toBe(0);
    // A command after the gesture is a step of its own.
    t.host.commands.execute("t/move", t.env(), { x: 7 });
    t.host.commands.execute("t/move", t.env(), { x: 8 });
    expect(t.undo.undoStack.length).toBe(2);
  });

  it("take everything back when cancelled, without a redo step", () => {
    const t = setup();
    t.host.commands.execute("t/title", t.env(), "Before");
    const gesture = t.host.commands.beginGesture(t.env);
    gesture.run("t/move", { x: 3 });
    gesture.run("t/move", { x: 6 });
    gesture.cancel();
    expect(t.x()).toBe(0);
    expect(t.title()).toBe("Before");
    expect(t.undo.undoStack.length).toBe(1);
    expect(t.undo.redoStack.length).toBe(0);
  });
});

describe("shortcuts", () => {
  it("are normalized: modifiers in a fixed order, letters in lower case", () => {
    expect(normalizeShortcut("Shift+Mod+Z")).toBe("Mod+Shift+z");
    expect(normalizeShortcut("Delete")).toBe("Delete");
    expect(normalizeShortcut("Mod++")).toBe("Mod++");
    expect(normalizeShortcut("Hyper+A")).toBeUndefined();
    expect(normalizeShortcut("Shift+Shift+A")).toBeUndefined();
    expect(normalizeShortcut("")).toBeUndefined();
  });
});
