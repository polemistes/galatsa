# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs frames and the stacking order of the development page in WebKitGTK.

Steps from tests/e2e/frames.spec.ts, with real input sent to the X server with
xdotool, in the system's WebKitGTK (the engine of the Linux desktop app): on
an empty document with a large rectangle (the picture) and a small one on top
(the text), the frame tool (F) draws a frame around both, as one undo step;
Ctrl+Shift+] brings the picture to the front of the frame and Ctrl+Shift+[
sends it to the back again, each one step; the frame dragged by its name
moves with both and nothing shifts, and Ctrl+Z takes the drag back; the text
dragged out of the frame lands on the canvas. See
docs/adr/0014-stacking-and-frames.md.

It uses the window, server and event loop of editor_check.py. Run it without
a visible window, from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/frames_check.py

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
base.TITLE = "Galatsa frames check"

# The first probe puts root space one to one on the canvas and makes the two
# rectangles; every probe reports the frames, the order in them and where
# things are.
base.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  if (!window.framesCheck) {
    const { width, height } = editor.screen;
    editor.services.camera.set({ space: null, cx: width / 2, cy: height / 2, zoom: 1 });
    const insert = (x, y, w, h) =>
      editor.run("galatsa.shape/insert", { kind: "rect", x, y, w, h }).value;
    window.framesCheck = { picture: insert(60, 60, 200, 150), text: insert(100, 100, 80, 30) };
    editor.services.selection.set([]);
  }
  const { picture, text } = window.framesCheck;
  const live = editor.live;
  const frames = [...live.ids()].filter(
    (id) => !live.isGone(id) && live.get(id).type === "core/frame");
  const at = (id) => {
    const p = editor.services.scene.placement(id);
    return { x: p.worldX, y: p.worldY, parent: live.logicalParentOf(id) };
  };
  const rect = document.querySelector(".galatsa-canvas").getBoundingClientRect();
  return JSON.stringify({
    picture, text, frames,
    order: frames.length === 1 ? live.logicalChildren(frames[0]) : [],
    places: { picture: at(picture), text: at(text),
              frame: frames.length === 1 ? at(frames[0]) : null },
    selection: [...editor.selection],
    steps: editor.undo.undoStack.length,
    tool: editor.tools.current,
    canvas: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  });
})()
"""


def scenario():
    state = None
    while state is None:
        yield ("wait", 250)
        state = yield ("probe",)
    picture, text = state["picture"], state["text"]
    start = state["steps"]
    window = base.xdo("search", "--name", base.TITLE).split()[0]
    base.xdo("windowfocus", window)
    ox, oy = state["canvas"]["x"], state["canvas"]["y"]
    # Empty canvas, outside the frame drawn below (40..360 by 40..300).
    free = (state["canvas"]["w"] - 30, state["canvas"]["h"] - 30)
    assert free[0] > 380 and free[1] > 320, state

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(ox + x)), str(round(oy + y))])

    def drag(frm, to):
        yield at(*frm)
        yield ("xdo", ["mousedown", "1"])
        for i in range(1, 9):
            t = i / 8
            yield at(frm[0] + (to[0] - frm[0]) * t, frm[1] + (to[1] - frm[1]) * t)
            yield ("wait", 30)
        yield ("xdo", ["mouseup", "1"])
        yield ("wait", 300)

    # Focus the canvas with a click on empty canvas; F picks the frame tool.
    yield at(*free)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield ("xdo", ["key", "f"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["tool"] == "galatsa.select/frame", state
    yield from drag((40, 40), (360, 300))
    state = yield ("probe",)
    assert len(state["frames"]) == 1 and state["steps"] == start + 1, state
    frame = state["frames"][0]
    assert state["order"] == [picture, text], state
    assert state["selection"] == [frame] and state["tool"] == "galatsa.select/select", state

    # The picture to the front of the frame and back again, each one step.
    yield at(230, 190)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["selection"] == [picture], state
    for keys, order, steps in [
        ("ctrl+shift+bracketright", [text, picture], start + 2),
        ("ctrl+shift+bracketleft", [picture, text], start + 3),
    ]:
        yield ("xdo", ["key", keys])
        yield ("wait", 300)
        state = yield ("probe",)
        assert state["order"] == order and state["steps"] == steps, (keys, state)

    # The frame dragged by its name: everything in it moves by as much.
    before = state["places"]
    yield from drag((60, 40 - 9), (160, 100 - 9))
    state = yield ("probe",)
    for name in ("frame", "picture", "text"):
        was, now = before[name], state["places"][name]
        assert (now["x"], now["y"]) == (was["x"] + 100, was["y"] + 60), (name, state)
    assert state["order"] == [picture, text], state
    assert state["places"]["text"]["parent"] == frame, state
    yield ("xdo", ["key", "ctrl+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["places"] == before, state

    # The text dragged out of the frame lands on the canvas.
    yield at(140, 115)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield from drag((140, 115), free)
    state = yield ("probe",)
    assert state["places"]["text"]["parent"] is None, state
    assert state["order"] == [picture], state


base.scenario = scenario

if __name__ == "__main__":
    sys.exit(base.main())
