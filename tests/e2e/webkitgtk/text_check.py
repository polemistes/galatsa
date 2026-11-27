# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs in-place text editing of the development page (apps/web) in WebKitGTK.

Steps of tests/e2e/text-edit.spec.ts, with real input sent to the X server
with xdotool, in the system's WebKitGTK (the engine of the Linux desktop
app): on an empty document, the text tool makes a text box and starts
editing; typed text, Space and Shift+1 go into the text and do not move the
camera; Enter makes a paragraph and the box grows; Ctrl+Z takes the typing
back and Ctrl+Shift+Z brings it again; Escape ends editing and selects the
box; Enter edits it again.

It uses the window, server and event loop of editor_check.py. Run it without
a visible window, from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/text_check.py

The port of the web app's Vite server is E2E_WEB_PORT, or 5198; a server
already running there is used.
"""

import os
import sys

# Importing editor_check would otherwise leave a __pycache__ folder here.
sys.dont_write_bytecode = True
import editor_check as base  # noqa: E402

base.PORT = int(os.environ.get("E2E_WEB_PORT", "5198"))
base.URL = f"http://localhost:{base.PORT}/?scene=empty&lang=en"
base.TITLE = "Galatsa text check"

base.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  const live = editor.live;
  const texts = [...live.ids()]
    .filter((id) => !live.isGone(id) && live.get(id).type === "galatsa.text/text")
    .map((id) => {
      const e = editor.doc.getMap("elements").get(id);
      return { id, text: e.get("data").get("text").toString(), h: e.toJSON().size.h };
    });
  const edit = document.querySelector(".galatsa-text-edit");
  const lines = edit ? [...edit.children].map((p) => p.textContent) : null;
  const canvas = document.querySelector(".galatsa-canvas canvas");
  const rect = canvas.getBoundingClientRect();
  return JSON.stringify({
    texts,
    lines,
    focused: edit !== null && document.activeElement === edit,
    editing: editor.textEdit.id,
    selection: editor.selection,
    steps: editor.undo.undoStack.length,
    camera: [editor.camera.cx, editor.camera.cy, editor.camera.zoom],
    canvas: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  });
})()
"""


def scenario():
    state = None
    while state is None:
        yield ("wait", 250)
        state = yield ("probe",)
    assert state["texts"] == [], state
    window = base.xdo("search", "--name", base.TITLE).split()[0]
    base.xdo("windowfocus", window)
    ox, oy = state["canvas"]["x"], state["canvas"]["y"]
    WIDTH, HEIGHT = state["canvas"]["w"], state["canvas"]["h"]
    camera = state["camera"]

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(ox + x)), str(round(oy + y))])

    # Focus the canvas, pick the text tool, click.
    yield at(WIDTH * 0.9, HEIGHT * 0.9)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield ("xdo", ["key", "t"])
    yield ("wait", 200)
    yield at(WIDTH * 0.2, HEIGHT * 0.3)
    yield ("xdo", ["click", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert len(state["texts"]) == 1 and state["focused"], state
    h0 = state["texts"][0]["h"]
    steps = state["steps"]
    # Typing, Space and Shift+1 stay in the text; Enter makes a paragraph.
    yield ("xdo", ["type", "--delay", "40", "Hello world"])
    yield ("xdo", ["key", "space", "shift+1", "Return"])
    yield ("xdo", ["type", "--delay", "40", "again"])
    yield ("wait", 400)
    state = yield ("probe",)
    assert state["texts"][0]["text"] == "Hello world !\nagain\n", state
    assert state["lines"] == ["Hello world !", "again"], state
    assert state["camera"] == camera, state
    assert state["texts"][0]["h"] > h0 * 1.9, state
    # Undo takes the typing back, redo brings it again.
    yield ("xdo", ["key", "ctrl+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["texts"][0]["text"] == "\n", state
    assert state["editing"] is not None, state
    yield ("xdo", ["key", "ctrl+shift+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["texts"][0]["text"] == "Hello world !\nagain\n", state
    # Escape ends editing and selects the box; Enter edits it again.
    yield ("xdo", ["key", "Escape"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["editing"] is None and state["lines"] is None, state
    assert state["selection"] == [state["texts"][0]["id"]], state
    yield ("xdo", ["key", "Return"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["focused"], state
    yield ("xdo", ["key", "Escape"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["steps"] >= steps + 1, state


base.scenario = scenario

if __name__ == "__main__":
    sys.exit(base.main())
