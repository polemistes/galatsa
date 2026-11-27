// SPDX-License-Identifier: GPL-3.0-or-later

// The command registry: undo steps, nesting, failures, history, gestures,
// modes and shortcuts.

import { FRAME_TYPE, purgeSnapshot, type ElementId } from "@galatsa/core";
import {
  addElement,
  createUndoManager,
  deleteElements,
  edit,
  forkDoc,
  initDocument,
  moveElement,
  setTitle,
  syncDocs,
  toSnapshot,
} from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { defineCommand, type CommandEnvironment } from "./command.ts";
import { EditorHost } from "./editor-host.ts";
import { EXTENSION_API_VERSION, normalizeShortcut, type Mode } from "./ids.ts";
import { createTestServices } from "./testing-services.ts";

function makeDoc(mode: Mode = "advanced", count = 1) {
  const doc = new Y.Doc();
  initDocument(doc);
  const undo = createUndoManager(doc);
  const frames = Array.from({ length: count }, (_, i) =>
    addElement(doc, { type: FRAME_TYPE, x: i, y: 0, size: { w: 10, h: 10 } }),
  );
  undo.clear();
  const services = createTestServices(doc, { mode });
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const title = () => toSnapshot(doc).title;
  const x = (i = 0) => toSnapshot(doc).elements[frames[i]!]!.pos.x;
  return { doc, undo, frames, services, env, title, x };
}

type TestDoc = ReturnType<typeof makeDoc>;

function makeHost(docs: TestDoc[]) {
  const framesOf = (doc: Y.Doc): ElementId[] => docs.find((d) => d.doc === doc)!.frames;
  const host = new EditorHost();
  host.load([
    {
      view: { id: "t", version: "1.0.0", api: EXTENSION_API_VERSION },
      contributes: {
        commands: [
          defineCommand<string, void>({
            name: "title",
            label: "common:a",
            undoLabel: "common:title-step",
            shortcuts: ["Mod+T"],
            execute: (ctx, title) => setTitle(ctx.doc, title),
          }),
          defineCommand<{ x: number }, void>({
            name: "move",
            label: "common:a",
            quick: true,
            shortcuts: ["mod+t"],
            // All frames, in one transaction.
            execute: (ctx, a) =>
              edit(ctx.doc, () =>
                framesOf(ctx.doc).forEach((id, i) =>
                  moveElement(ctx.doc, id, i + a.x, 0),
                ),
              ),
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
            name: "half",
            label: "common:a",
            quick: true,
            execute(ctx) {
              setTitle(ctx.doc, "half");
              throw new Error("fails after a change");
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
            name: "nothing",
            label: "common:a",
            quick: true,
            execute: () => {},
          }),
          defineCommand<undefined, void>({
            name: "view",
            label: "common:a",
            quick: true,
            undoable: false,
            execute: () => {},
          }),
          defineCommand<undefined, void>({
            name: "outer-view",
            label: "common:a",
            undoable: false,
            execute(ctx) {
              ctx.run("t/title", "x");
              ctx.run("t/half");
            },
          }),
          defineCommand<undefined, boolean>({
            name: "undo",
            label: "common:a",
            undoable: false,
            execute: (ctx) => ctx.history.undo(),
          }),
        ],
      },
    },
  ]);
  return host;
}

function setup(mode: Mode = "advanced") {
  const d = makeDoc(mode);
  return { ...d, host: makeHost([d]) };
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

  it("takes back a failed command and keeps the redo stack", () => {
    const t = setup();
    t.host.commands.execute("t/title", t.env(), "x");
    t.undo.undo();
    expect(t.undo.redoStack.length).toBe(1);
    expect(t.host.commands.execute("t/half", t.env())).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(t.title()).toBe("");
    expect(t.undo.undoStack.length).toBe(0);
    expect(t.undo.redoStack.length).toBe(1);
    t.undo.redo();
    expect(t.title()).toBe("x");
  });

  it("makes each undoable command run by a non-undoable one a step, taken back if it fails", () => {
    const t = setup();
    const outcome = t.host.commands.execute("t/outer-view", t.env());
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    // "title" was its own step; "half" changed the title and failed, and is gone.
    expect(t.title()).toBe("x");
    expect(t.undo.undoStack.length).toBe(1);
    t.undo.undo();
    expect(t.title()).toBe("");
  });

  it("names each step after its command, and keeps the name through undo and redo", () => {
    const t = setup();
    const history = t.host.commands.history(t.env());
    expect(history.undoStep()).toBeNull();
    expect(history.redoStep()).toBeNull();
    t.host.commands.execute("t/title", t.env(), "One");
    expect(history.undoStep()).toEqual({
      command: "t/title",
      label: "common:title-step",
    });
    // A command run by another is part of the outer step, which has its name.
    t.host.commands.execute("t/both", t.env());
    expect(history.undoStep()).toEqual({ command: "t/both", label: "common:a" });
    // A command that changes nothing makes no step and renames none.
    t.host.commands.execute("t/nothing", t.env());
    expect(t.undo.undoStack.length).toBe(2);
    expect(history.undoStep()).toEqual({ command: "t/both", label: "common:a" });

    expect(history.undo()).toBe(true);
    expect(history.redoStep()).toEqual({ command: "t/both", label: "common:a" });
    expect(history.undoStep()).toEqual({
      command: "t/title",
      label: "common:title-step",
    });
    expect(history.undo()).toBe(true);
    expect(history.redo()).toBe(true);
    expect(history.undoStep()).toEqual({
      command: "t/title",
      label: "common:title-step",
    });
    expect(history.redoStep()).toEqual({ command: "t/both", label: "common:a" });
    expect(history.redo()).toBe(true);
    expect(history.undoStep()).toEqual({ command: "t/both", label: "common:a" });
    // And again after a second round.
    expect(history.undo()).toBe(true);
    expect(history.redoStep()).toEqual({ command: "t/both", label: "common:a" });
  });

  it("gives steps that no command made no name", () => {
    const t = setup();
    // Changes of the local user outside commands (as an editor binding makes them).
    setTitle(t.doc, "typed");
    const history = t.host.commands.history(t.env());
    expect(history.undoStep()).toEqual({});
    // A step made by a command run by a non-undoable one has that command's name.
    t.host.commands.execute("t/outer-view", t.env());
    expect(history.undoStep()).toEqual({
      command: "t/title",
      label: "common:title-step",
    });
  });

  it("builds the keyboard map per mode and reports conflicts", () => {
    const t = setup();
    const advanced = t.host.commands.shortcuts("advanced");
    expect(advanced.map.get("Mod+t")).toBe("t/title");
    expect(advanced.conflicts).toEqual([
      { shortcut: "Mod+t", kept: "t/title", ignored: "t/move" },
    ]);
    const quick = t.host.commands.shortcuts("quick");
    expect(quick.map.get("Mod+t")).toBe("t/move");
    expect(quick.conflicts).toEqual([]);
  });
});

describe("gestures", () => {
  it("preview without writing, and commit once: one transaction, one undo step", () => {
    const t = makeDoc("advanced", 50);
    const host = makeHost([t]);
    const before = Y.encodeStateAsUpdate(t.doc).length;
    let updates = 0;
    t.doc.on("update", () => updates++);
    const gesture = host.commands.beginGesture(t.env());
    for (let step = 1; step <= 120; step++) {
      gesture.preview(Object.fromEntries(t.frames.map((id, i) => [id, { x: i + step }])));
    }
    expect(updates).toBe(0);
    expect(t.services.state.previews).toBe(120);
    expect(t.services.state.preview).not.toBeNull();
    expect(gesture.commit("t/move", { x: 120 }).ok).toBe(true);
    expect(t.services.state.preview).toBeNull();
    expect(gesture.active).toBe(false);
    // The move itself, and the work tracker's follow-up transaction.
    expect(updates).toBeLessThanOrEqual(2);
    expect(t.undo.undoStack.length).toBe(1);
    expect(t.x(49)).toBe(169);
    expect(Y.encodeStateAsUpdate(t.doc).length - before).toBeLessThan(4000);
    t.undo.undo();
    expect(t.x(49)).toBe(49);
  });

  it("cancel writes nothing, so a cancelled drag is not work", () => {
    for (const withGesture of [false, true]) {
      const t = setup();
      const peer = forkDoc(t.doc);
      deleteElements(peer, [t.frames[0]!]);
      let updates = 0;
      t.doc.on("update", () => updates++);
      if (withGesture) {
        const gesture = t.host.commands.beginGesture(t.env());
        gesture.preview({ [t.frames[0]!]: { x: 5 } });
        gesture.cancel();
      }
      expect(updates).toBe(0);
      syncDocs(t.doc, peer);
      // The concurrent delete applies either way.
      expect(t.frames[0]! in purgeSnapshot(toSnapshot(t.doc)).elements).toBe(false);
    }
  });

  it("are per document: commands on another document are their own steps", () => {
    const a = makeDoc();
    const b = makeDoc();
    const host = makeHost([a, b]);
    const gesture = host.commands.beginGesture(a.env());
    gesture.preview({ [a.frames[0]!]: { x: 1 } });
    host.commands.execute("t/title", b.env(), "one");
    host.commands.execute("t/title", b.env(), "two");
    expect(host.commands.execute("t/half", b.env()).ok).toBe(false);
    expect(b.undo.undoStack.length).toBe(2);
    expect(b.title()).toBe("two");
    expect(host.commands.gestureActive(b.env())).toBe(false);
    expect(host.commands.gestureActive(a.env())).toBe(true);
    gesture.commit("t/move", { x: 1 });
    expect(a.undo.undoStack.length).toBe(1);
  });

  it("let other commands on the same document run as their own steps, which a cancel keeps", () => {
    const t = setup();
    const gesture = t.host.commands.beginGesture(t.env());
    gesture.preview({ [t.frames[0]!]: { x: 1 } });
    t.host.commands.execute("t/title", t.env(), "panel change");
    gesture.cancel();
    expect(t.title()).toBe("panel change");
    expect(t.undo.undoStack.length).toBe(1);
  });

  it("block undo and redo while they run", () => {
    const t = setup();
    t.host.commands.execute("t/title", t.env(), "x");
    const gesture = t.host.commands.beginGesture(t.env());
    expect(t.host.commands.history(t.env()).canUndo()).toBe(false);
    expect(t.host.commands.execute("t/undo", t.env())).toEqual({
      ok: true,
      value: false,
    });
    expect(t.title()).toBe("x");
    gesture.cancel();
    expect(t.host.commands.execute("t/undo", t.env())).toEqual({ ok: true, value: true });
    expect(t.title()).toBe("");
  });

  it("cancel the running gesture of a document when another starts there", () => {
    const t = setup();
    const first = t.host.commands.beginGesture(t.env());
    const second = t.host.commands.beginGesture(t.env());
    expect(first.active).toBe(false);
    expect(first.commit("t/move", { x: 9 }).ok).toBe(false);
    expect(second.commit("t/move", { x: 3 }).ok).toBe(true);
    expect(t.x()).toBe(3);
    expect(t.undo.undoStack.length).toBe(1);
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
