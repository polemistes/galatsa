# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs the shape tools of the development page (apps/web) in WebKitGTK.

The same steps as tests/e2e/shape-tool.spec.ts, with real input sent to the X
server with xdotool, in the system's WebKitGTK (the engine of the Linux
desktop app): on an empty document, the line tool draws with the mouse; while
dragging, the canvas shows the preview and the document is unchanged; on
release there is one line, turned the drag's way, as one undo step that
Ctrl+Z takes back whole and Ctrl+Shift+Z brings again; the rectangle tool
draws a rectangle whose fill the canvas shows; Escape cancels a drag of the
ellipse tool.

It uses the window, server and event loop of editor_check.py. Run it without
a visible window, from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/shape_check.py

The port of the web app's Vite server is E2E_WEB_PORT, or 5198; a server
already running there is used.
"""

import math
import os
import sys

# Importing editor_check would otherwise leave a __pycache__ folder here.
sys.dont_write_bytecode = True
import editor_check as base  # noqa: E402

base.PORT = int(os.environ.get("E2E_WEB_PORT", "5198"))
base.URL = f"http://localhost:{base.PORT}/?scene=empty&lang=en"
base.TITLE = "Galatsa shape check"

base.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  const live = editor.live;
  const shapes = [...live.ids()]
    .filter((id) => !live.isGone(id) && live.get(id).type === "galatsa.shape/shape")
    .map((id) => {
      const e = editor.doc.getMap("elements").get(id).toJSON();
      return { kind: e.data.kind, w: e.size.w, h: e.size.h, rot: e.rot };
    });
  const canvas = document.querySelector(".galatsa-canvas canvas");
  const ratio = canvas.width / canvas.clientWidth;
  const px = (x, y) => [...canvas.getContext("2d")
    .getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data].slice(0, 3);
  const rect = canvas.getBoundingClientRect();
  return JSON.stringify({
    shapes,
    steps: editor.undo.undoStack.length,
    tool: editor.tools.current,
    zoom: editor.camera.zoom,
    canvas: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    lineMiddle: px(0.6 * rect.width + 60, 0.7 * rect.height - 45),
    rectMiddle: px(0.4 * rect.width, 0.45 * rect.height),
  });
})()
"""


def scenario():
    state = None
    while state is None:
        yield ("wait", 250)
        state = yield ("probe",)
    assert state["shapes"] == [], state
    start = state["steps"]
    background = state["lineMiddle"]
    window = base.xdo("search", "--name", base.TITLE).split()[0]
    base.xdo("windowfocus", window)
    # Places are taken from the canvas: under Xvfb the window may be smaller
    # than asked for (the screen of xvfb-run is 640 by 480 unless told).
    ox, oy = state["canvas"]["x"], state["canvas"]["y"]
    WIDTH, HEIGHT = state["canvas"]["w"], state["canvas"]["h"]

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(ox + x)), str(round(oy + y))])

    # Focus the canvas, then pick the line tool by its key.
    yield at(WIDTH * 0.9, HEIGHT * 0.1)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield ("xdo", ["key", "l"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["tool"] == "galatsa.shape/line", state
    # Drag; the preview shows, the document does not change.
    a = (WIDTH * 0.6, HEIGHT * 0.7)
    yield at(*a)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 9):
        yield at(a[0] + 15 * i, a[1] - 11.25 * i)
        yield ("wait", 30)
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["lineMiddle"] != background, ("preview", background, state)
    assert state["shapes"] == [] and state["steps"] == start, state
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert len(state["shapes"]) == 1 and state["steps"] == start + 1, state
    line = state["shapes"][0]
    assert line["kind"] == "line" and line["h"] == 0, state
    assert abs(line["w"] * state["zoom"] - 150) < 2, state
    assert abs(line["rot"] - (math.atan2(-90, 120) + 2 * math.pi)) < 0.02, state
    # One undo step takes it back whole; redo brings it again.
    for keys, count in [("ctrl+z", 0), ("ctrl+shift+z", 1)]:
        yield ("xdo", ["key", keys])
        yield ("wait", 300)
        state = yield ("probe",)
        assert len(state["shapes"]) == count, (keys, state)
    # A rectangle, whose fill the canvas shows.
    yield ("xdo", ["key", "r"])
    yield ("wait", 200)
    yield at(WIDTH * 0.3, HEIGHT * 0.3)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 9):
        yield at(WIDTH * (0.3 + 0.025 * i), HEIGHT * (0.3 + 0.0375 * i))
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert len(state["shapes"]) == 2 and state["steps"] == start + 2, state
    assert state["rectMiddle"] == [0x93, 0xC5, 0xFD], state
    # Escape cancels a drag.
    yield ("xdo", ["key", "o"])
    yield ("wait", 200)
    yield at(WIDTH * 0.1, HEIGHT * 0.1)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 5):
        yield at(WIDTH * 0.1 + 20 * i, HEIGHT * 0.1 + 15 * i)
        yield ("wait", 30)
    yield ("xdo", ["key", "Escape"])
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert len(state["shapes"]) == 2 and state["steps"] == start + 2, state


base.scenario = scenario

if __name__ == "__main__":
    sys.exit(base.main())
