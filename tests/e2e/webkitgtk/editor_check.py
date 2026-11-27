# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs the editor's development page (apps/web) in WebKitGTK, with real input.

Playwright's WebKit build needs libraries of a particular Ubuntu release, so on
other systems the editor is checked in the system's WebKitGTK instead (the
engine of the Linux desktop app). The same steps as tests/e2e/editor.spec.ts:
the sample scene opens; the rectangle tool, picked with its key, draws a
shape with the mouse; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo it; the
selection tool drags it, and Ctrl+Z takes the move back; Ctrl+C and Ctrl+V
copy and paste it through the system clipboard. And from
tests/e2e/selection.spec.ts: a corner handle scales the selection and a
handle above it rotates it, each taken back by one Ctrl+Z, and a right click
opens the context menu. Mouse and keys are sent to the X server with xdotool
(XTEST), so they reach WebKit the way a user's input does.

Needs python-gobject, WebKitGTK 6.0, xdotool and a display; run it without a
visible window, from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/editor_check.py

It starts the web app's Vite server on port 5198 itself, unless one is running.
Exit code 0 when every step passes.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import GLib, Gtk, WebKit  # noqa: E402

PORT = 5198
URL = f"http://localhost:{PORT}/?lang=en&fresh"
TITLE = "Galatsa editor check"
WIDTH, HEIGHT = 1000, 700
TIMEOUT_S = 180

PROBE = """
(() => {
  // Where the page last saw the pointer, to find the canvas in the window.
  if (!window.__galatsaPointer) {
    window.__galatsaPointer = { x: null, y: null };
    window.addEventListener("pointermove", (e) => {
      window.__galatsaPointer = { x: e.clientX, y: e.clientY };
    }, true);
  }
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  const live = editor.live;
  const ids = [...live.ids()].filter((id) => !live.isGone(id));
  const sel = editor.selection.length === 1 ? editor.renderer.screenBounds(editor.selection[0]) : null;
  const placed = editor.selection.length === 1 ? editor.services.scene.placement(editor.selection[0]) : null;
  const canvas = document.querySelector(".galatsa-canvas").getBoundingClientRect();
  return JSON.stringify({
    elements: ids.length,
    shapes: ids.filter((id) => live.get(id).type === "examples.shape/shape").length,
    tool: editor.tools.current,
    selection: [...editor.selection],
    box: sel,
    focused: document.activeElement && document.activeElement.className,
    placed,
    canvas: { x: canvas.x, y: canvas.y },
    pointer: window.__galatsaPointer,
    menu: document.querySelector(".galatsa-context-menu") !== null,
  });
})()
"""


def port_open() -> bool:
    try:
        socket.create_connection(("localhost", PORT), timeout=0.2).close()
        return True
    except OSError:
        return False


def start_server():
    if port_open():
        return None
    server = subprocess.Popen(
        ["pnpm", "--filter", "@galatsa/web", "exec", "vite", "--port", str(PORT), "--strictPort"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 60
    while not port_open():
        if time.time() > deadline or server.poll() is not None:
            server.kill()
            raise SystemExit("the web app's server did not start")
        time.sleep(0.2)
    return server


def xdo(*args: str) -> str:
    return subprocess.run(["xdotool", *args], check=True, capture_output=True, text=True).stdout


def scenario():
    """The steps. Yields ("probe",) for the page's state, ("wait", ms) and ("xdo", args)."""
    state = None
    deadline = time.time() + 90
    while state is None:
        if time.time() > deadline:
            raise AssertionError("the editor did not start")
        yield ("wait", 250)
        state = yield ("probe",)
    assert state["elements"] == 2000, state
    assert state["shapes"] == 1200, state
    start = state["shapes"]
    window = xdo("search", "--name", TITLE).split()[0]
    # No window manager under Xvfb: give the window the keyboard focus directly.
    xdo("windowfocus", window)

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(x)), str(round(y))])

    # Click the canvas (focus), then pick the rectangle tool by its key.
    yield at(WIDTH * 0.9, HEIGHT * 0.1)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield ("xdo", ["key", "r"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["tool"] == "examples.shape/rect", state
    # Draw with the mouse.
    yield at(WIDTH * 0.3, HEIGHT * 0.3)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 9):
        t = i / 8
        yield at(WIDTH * (0.3 + 0.2 * t), HEIGHT * (0.3 + 0.3 * t))
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["shapes"] == start + 1, state
    assert state["tool"] == "galatsa.select/select", state
    # Undo and redo from the keyboard.
    for keys, expected in [
        ("ctrl+z", start),
        ("ctrl+shift+z", start + 1),
        ("ctrl+z", start),
        ("ctrl+y", start + 1),
    ]:
        yield ("xdo", ["key", keys])
        yield ("wait", 300)
        state = yield ("probe",)
        assert state["shapes"] == expected, (keys, state)
    # Select the shape and drag it.
    mid = (WIDTH * 0.4, HEIGHT * 0.45)
    yield at(*mid)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert len(state["selection"]) == 1 and state["box"] is not None, state
    before = state["box"]
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 7):
        yield at(mid[0] + 10 * i, mid[1] + 7 * i)
        yield ("wait", 30)
    state = yield ("probe",)
    assert state["box"]["x"] - before["x"] > 40, ("preview", before, state)
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["box"]["x"] - before["x"] > 40, ("moved", before, state)
    yield ("xdo", ["key", "ctrl+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert abs(state["box"]["x"] - before["x"]) < 0.01, ("undo move", before, state)
    assert state["shapes"] == start + 1, state
    # Copy and paste, through the system clipboard.
    for keys, expected in [("ctrl+c", start + 1), ("ctrl+v", start + 2), ("ctrl+z", start + 1)]:
        yield ("xdo", ["key", keys])
        yield ("wait", 300)
        state = yield ("probe",)
        assert state["shapes"] == expected, (keys, state)

    # Where the canvas is in the window: the page reports the pointer.
    yield at(WIDTH * 0.5, HEIGHT * 0.5)
    yield ("wait", 100)
    state = yield ("probe",)
    pointer = state["pointer"]
    assert pointer["x"] is not None, state
    dx = WIDTH * 0.5 - (pointer["x"] - state["canvas"]["x"])
    dy = HEIGHT * 0.5 - (pointer["y"] - state["canvas"]["y"])

    def on_canvas(x: float, y: float):
        return at(x + dx, y + dy)

    def drag(frm, to):
        yield on_canvas(*frm)
        yield ("xdo", ["mousedown", "1"])
        for i in range(1, 9):
            t = i / 8
            yield on_canvas(frm[0] + (to[0] - frm[0]) * t, frm[1] + (to[1] - frm[1]) * t)
            yield ("wait", 30)
        yield ("xdo", ["mouseup", "1"])
        yield ("wait", 300)

    # Select the shape again, and scale it from its bottom right corner handle.
    yield on_canvas(*mid)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert len(state["selection"]) == 1, state
    box = state["box"]
    w0 = state["placed"]["w"]
    corner = (box["x"] + box["w"], box["y"] + box["h"])
    yield from drag(corner, (corner[0] + 40, corner[1] + 40))
    state = yield ("probe",)
    assert state["placed"]["w"] > w0 * 1.05, ("scale", w0, state)
    assert state["shapes"] == start + 1, state
    yield ("xdo", ["key", "ctrl+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert abs(state["placed"]["w"] - w0) < 1e-6, ("undo scale", w0, state)
    # Rotate it with the handle above it, a quarter turn.
    box = state["box"]
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    yield from drag((cx, box["y"] - 24), (cx + 200, cy))
    state = yield ("probe",)
    assert abs(state["placed"]["rot"] - 1.5708) < 0.05, ("rotate", state)
    yield ("xdo", ["key", "ctrl+z"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["placed"]["rot"] == 0, ("undo rotate", state)
    # A right click opens the context menu; Escape closes it.
    yield on_canvas(cx, cy)
    yield ("xdo", ["click", "3"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["menu"], ("menu", state)
    yield ("xdo", ["key", "Escape"])
    yield ("wait", 200)
    state = yield ("probe",)
    assert not state["menu"], ("menu closed", state)


def main() -> int:
    server = start_server()
    data = tempfile.mkdtemp(prefix="galatsa-webkit-")
    outcome = {"ok": False, "error": None}
    try:
        session = WebKit.NetworkSession.new(os.path.join(data, "data"), os.path.join(data, "cache"))
        Gtk.init()
        loop = GLib.MainLoop()
        view = WebKit.WebView(network_session=session)
        window = Gtk.Window(title=TITLE)
        window.set_default_size(WIDTH, HEIGHT)
        window.set_child(view)
        window.present()
        steps = scenario()

        def advance(value=None) -> None:
            try:
                step = steps.send(value)
            except StopIteration:
                outcome["ok"] = True
                loop.quit()
                return
            except Exception as error:  # an assertion, or xdotool failing
                outcome["error"] = f"failed: {error!r}"
                loop.quit()
                return
            kind = step[0]
            if kind == "wait":
                GLib.timeout_add(step[1], lambda: (advance(), False)[1])
            elif kind == "xdo":
                try:
                    xdo(*step[1])
                except subprocess.CalledProcessError as error:
                    outcome["error"] = f"failed: xdotool {step[1]}: {error.stderr}"
                    loop.quit()
                    return
                GLib.timeout_add(20, lambda: (advance(), False)[1])
            else:

                def done(source, result) -> None:
                    try:
                        value = source.evaluate_javascript_finish(result)
                        advance(json.loads(value.to_string()))
                    except GLib.Error as error:
                        outcome["error"] = f"failed: {error.message}"
                        loop.quit()

                view.evaluate_javascript(PROBE, -1, None, None, None, done)

        def on_load(_view, event) -> None:
            if event == WebKit.LoadEvent.FINISHED and not on_load.started:
                on_load.started = True
                advance()

        on_load.started = False
        view.connect("load-changed", on_load)
        GLib.timeout_add_seconds(
            TIMEOUT_S, lambda: (outcome.update(error="failed: timeout"), loop.quit())[1] or False
        )
        version = f"{WebKit.get_major_version()}.{WebKit.get_minor_version()}.{WebKit.get_micro_version()}"
        print(f"WebKitGTK {version}", flush=True)
        view.load_uri(URL)
        loop.run()
    finally:
        shutil.rmtree(data, ignore_errors=True)
        if server:
            server.terminate()
    print("done: every step passed" if outcome["ok"] else outcome["error"], flush=True)
    return 0 if outcome["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
