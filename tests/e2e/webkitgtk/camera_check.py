# SPDX-License-Identifier: GPL-3.0-or-later
"""Checks the editor's camera in WebKitGTK, with real input.

The steps of tests/e2e/camera.spec.ts that real mouse and keyboard input can
take in the system's WebKitGTK (the engine of the Linux desktop app): the
wheel scrolls the canvas; Ctrl with the wheel zooms about the pointer, whose
point stays within a pixel; Ctrl and +, Ctrl and =, Ctrl and - and Ctrl+0
zoom; the middle button and Space with a drag move the canvas; Shift+1 shows
everything. Mouse and keys are sent to the X server with xdotool (XTEST).
Touch cannot be sent that way and is left to the browser tests.

Runs with the window and helpers of editor_check.py; see there for what it
needs. From the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/camera_check.py
"""

import math
import sys
import time

import editor_check as check

check.URL = f"http://localhost:{check.PORT}/?lang=en&fresh&scene=empty"
check.TITLE = "Galatsa camera check"
check.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  const rect = document.querySelector(".galatsa-canvas").getBoundingClientRect();
  return JSON.stringify({
    camera: editor.camera,
    projection: editor.projection(null),
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    selection: [...editor.selection],
    shapes: [...editor.live.ids()].filter((id) => !editor.live.isGone(id)).length,
  });
})()
"""


def scenario():
    state = None
    deadline = time.time() + 90
    while state is None:
        if time.time() > deadline:
            raise AssertionError("the editor did not start")
        yield ("wait", 250)
        state = yield ("probe",)
    window = check.xdo("search", "--name", check.TITLE).split()[0]
    check.xdo("windowfocus", window)
    # The window's real size: without a window manager it can be the size of
    # the X screen rather than the size asked for.
    W, H = state["width"], state["height"]

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(x)), str(round(y))])

    def key(keys: str):
        return ("xdo", ["key", keys])

    # Focus the canvas, and draw a rectangle to look at.
    yield at(W * 0.9, H * 0.1)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield key("r")
    yield ("wait", 200)
    yield at(W * 0.45, H * 0.45)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 6):
        yield at(W * (0.45 + 0.02 * i), H * (0.45 + 0.02 * i))
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["shapes"] == 1, state

    # The wheel scrolls the canvas down.
    before = state["camera"]
    px, py = W * 0.7, H * 0.3
    yield at(px, py)
    yield ("xdo", ["click", "5"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["camera"]["cy"] > before["cy"], ("wheel", before, state)
    assert state["camera"]["zoom"] == before["zoom"], ("wheel", before, state)

    # Ctrl and the wheel zoom about the pointer; its point stays.
    p = state["projection"]
    local = (px - state["left"], py - state["top"])
    target = ((local[0] - p["ox"]) / p["scale"], (local[1] - p["oy"]) / p["scale"])
    yield ("xdo", ["keydown", "ctrl"])
    for _ in range(12):
        yield ("xdo", ["click", "4"])
        yield ("wait", 40)
    yield ("xdo", ["keyup", "ctrl"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["camera"]["zoom"] > 4, ("ctrl+wheel", state)
    p = state["projection"]
    seen = (target[0] * p["scale"] + p["ox"], target[1] * p["scale"] + p["oy"])
    assert math.hypot(seen[0] - local[0], seen[1] - local[1]) < 1, ("pointer", local, seen)

    # The keyboard: actual size, then in and out.
    for keys, zoom in [
        ("ctrl+0", 1),
        ("ctrl+plus", 2),
        ("ctrl+equal", 4),
        ("ctrl+minus", 2),
        ("ctrl+0", 1),
    ]:
        yield key(keys)
        yield ("wait", 200)
        state = yield ("probe",)
        assert state["camera"]["zoom"] == zoom, (keys, state)

    # The middle button drags the canvas.
    before = state["camera"]
    yield at(W * 0.2, H * 0.8)
    yield ("xdo", ["mousedown", "2"])
    for i in range(1, 5):
        yield at(W * 0.2 + 10 * i, H * 0.8 - 5 * i)
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "2"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert abs(state["camera"]["cx"] - (before["cx"] - 40)) < 0.01, ("middle", before, state)
    assert abs(state["camera"]["cy"] - (before["cy"] + 20)) < 0.01, ("middle", before, state)

    # Space and a drag move the canvas instead of using the tool.
    before = state["camera"]
    selected = state["selection"]
    yield ("xdo", ["keydown", "space"])
    yield ("wait", 100)
    yield at(W * 0.5, H * 0.5)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 5):
        yield at(W * 0.5 - 15 * i, H * 0.5 + 5 * i)
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "1"])
    yield ("xdo", ["keyup", "space"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert abs(state["camera"]["cx"] - (before["cx"] + 60)) < 0.01, ("space", before, state)
    assert state["selection"] == selected, ("space", selected, state)

    # Shift+1 shows everything: the rectangle fills the view.
    yield key("shift+1")
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["camera"]["zoom"] > 3, ("shift+1", state)


check.scenario = scenario

if __name__ == "__main__":
    sys.exit(check.main())
