# SPDX-License-Identifier: GPL-3.0-or-later
"""Checks presentation mode in WebKitGTK, with real input.

The steps of tests/e2e/presentation.spec.ts that real keys and a real mouse
can take in the system's WebKitGTK (the engine of the Linux desktop app): F5
starts the player on the open document; PageDown, the arrows and PageUp go
through the route; keys pressed in the middle of a transition are obeyed and
the camera ends exactly at the stop; a drag takes the camera, which pauses the
route, and Backspace returns to the stop; the wheel does the same, and "next"
goes on; reduced motion; the notes, shown over the presentation, since this
window opens no other; Escape ends the presentation and the canvas has the
keys again. Mouse and keys are sent to the X server with xdotool (XTEST).
Touch cannot be sent that way and is left to the browser tests.

Runs with the window and helpers of editor_check.py; see there for what it
needs. From the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/presentation_check.py

The port of the web app's Vite server is E2E_WEB_PORT, or 5198; a server
already listening there is used as it is.
"""

import os
import sys
import time

# Importing editor_check would leave a bytecode cache in the repository.
sys.dont_write_bytecode = True

import editor_check as check  # noqa: E402

check.PORT = int(os.environ.get("E2E_WEB_PORT", "5198"))
check.URL = f"http://localhost:{check.PORT}/?lang=en&fresh&scene=empty"
check.TITLE = "Galatsa presentation check"

# Makes three frames with a stop each, once, and tells where the editor and
# the player are.
check.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  if (!window.__galatsaMade) {
    const frame = (x, y, fill, order) => ({
      type: "core/frame", typeVersion: 1, parent: null, order,
      pos: { x, y, space: null }, rebase: null, size: { w: 800, h: 450 }, name: "",
      locked: false, rev: {}, deleted: {}, dissolved: false, purged: false, refs: [],
      ext: {}, data: { fill },
    });
    const pasted = editor.run("galatsa.basics/paste", { fragment: {
      elements: {
        a: frame(0, 0, "#ff0000", "a0"),
        b: frame(1000, 0, "#00ff00", "a1"),
        c: frame(0, 800, "#0000ff", "a2"),
      },
      roots: ["a", "b", "c"], stops: {}, routes: {}, fallbackViews: {}, assets: {},
    } });
    const added = editor.run("galatsa.routes/add-stops-from-frames", { ids: pasted.value.ids });
    editor.run("galatsa.routes/set-stop-notes", { stop: added.value[1].stop, text: "Notes for green." });
    editor.services.selection.set([]);
    window.__galatsaMade = added.ok;
  }
  const rect = document.querySelector(".galatsa-canvas").getBoundingClientRect();
  const root = document.querySelector(".galatsa-player");
  const player = editor.presenting;
  let view = null;
  if (player) {
    const picture = player.presentation.picture();
    view = picture.kind === "view" ? picture.view : null;
  }
  const notes = document.querySelector(".gp-notes");
  return JSON.stringify({
    made: window.__galatsaMade,
    width: rect.width,
    height: rect.height,
    presenting: root !== null,
    phase: root ? root.dataset.phase : null,
    position: root ? Number(root.dataset.position) : null,
    moving: player ? player.presentation.moving : false,
    reduced: player ? player.presentation.state.reducedMotion : null,
    screen: player ? player.stage.screen : null,
    view,
    fullscreen: document.fullscreenElement !== null,
    notes: notes && !notes.hidden ? notes.textContent : null,
    focused: document.activeElement && document.activeElement.className,
  });
})()
"""

FRAMES = [(0, 0), (1000, 0), (0, 800)]


def fitted(state, index):
    """The camera that shows frame `index` filling the stage."""
    x, y = FRAMES[index]
    screen = state["screen"]
    return {
        "space": None,
        "cx": x + 400,
        "cy": y + 225,
        "zoom": min(screen["width"] / 800, screen["height"] / 450),
    }


def scenario():
    state = None
    deadline = time.time() + 90
    while state is None:
        if time.time() > deadline:
            raise AssertionError("the editor did not start")
        yield ("wait", 250)
        state = yield ("probe",)
    assert state["made"], state
    window = check.xdo("search", "--name", check.TITLE).split()[0]
    check.xdo("windowfocus", window)
    W, H = state["width"], state["height"]

    def at(x: float, y: float):
        return ("xdo", ["mousemove", "--window", window, str(round(x)), str(round(y))])

    def key(keys: str):
        return ("xdo", ["key", keys])

    def settled(position: int, what: str):
        """Waits until the presentation shows step `position` at rest."""
        deadline = time.time() + 20
        while True:
            yield ("wait", 150)
            now = yield ("probe",)
            if now["phase"] == "stop" and now["position"] == position and not now["moving"]:
                assert now["view"] == fitted(now, position), (what, now)
                return now
            if time.time() > deadline:
                raise AssertionError((what, "did not come to the stop", now))

    # The canvas gets the keys; F5 starts the presentation at the first stop.
    yield at(W * 0.9, H * 0.9)
    yield ("xdo", ["click", "1"])
    yield ("wait", 200)
    yield key("Escape")
    yield key("F5")
    yield ("wait", 500)
    state = yield ("probe",)
    assert state["presenting"], ("F5", state)
    state = yield from settled(0, "start")
    print(f"full screen: {state['fullscreen']}", flush=True)

    # What clickers send, and the arrows.
    yield key("Next")
    state = yield from settled(1, "PageDown")
    yield key("Right")
    state = yield from settled(2, "right arrow")
    yield key("Prior")
    state = yield from settled(1, "PageUp")

    # Keys in the middle of transitions: each is obeyed, and the camera ends
    # exactly at the stop.
    yield key("Home")
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["phase"] == "moving", ("in the middle", state)
    yield key("Right")
    yield ("wait", 150)
    yield key("Right")
    yield ("wait", 150)
    yield key("Left")
    state = yield from settled(1, "keys in the middle of a transition")

    # A drag in the middle of a flight takes the camera: the route is paused.
    yield key("Left")
    yield ("wait", 250)
    yield at(W * 0.5, H * 0.4)
    yield ("xdo", ["mousedown", "1"])
    for i in range(1, 6):
        yield at(W * 0.5 + 12 * i, H * 0.4 + 6 * i)
        yield ("wait", 30)
    yield ("xdo", ["mouseup", "1"])
    yield ("wait", 1200)
    state = yield ("probe",)
    assert state["phase"] == "roaming", ("drag", state)
    assert state["position"] == 1, ("the stop shown last", state)
    assert not state["moving"], ("at rest after the drag", state)
    # One key back to the stop.
    yield key("BackSpace")
    state = yield from settled(1, "Backspace")

    # The wheel moves the canvas; "next" goes on with the route.
    before = state["view"]
    yield ("xdo", ["click", "5"])
    yield ("wait", 300)
    state = yield ("probe",)
    assert state["phase"] == "roaming", ("wheel", state)
    assert state["view"]["zoom"] == before["zoom"], ("wheel", before, state)
    yield key("Next")
    state = yield from settled(2, "next after roaming")

    # A click goes on (here: nothing after the last stop), reduced motion fades.
    yield key("m")
    yield ("wait", 200)
    state = yield ("probe",)
    assert state["reduced"] is True, ("M", state)
    yield key("Home")
    state = yield from settled(0, "reduced motion")
    yield at(W * 0.5, H * 0.4)
    yield ("xdo", ["click", "1"])
    state = yield from settled(1, "a click")

    # The notes: this window opens no other, so they are shown over the presentation.
    yield key("s")
    yield ("wait", 500)
    state = yield ("probe",)
    assert state["notes"] is not None and "Notes for green." in state["notes"], ("notes", state)
    assert state["presenting"], ("notes", state)

    # Escape ends it; the canvas has the keys again.
    yield key("Escape")
    yield ("wait", 800)
    state = yield ("probe",)
    if state["presenting"]:
        # Escape only took the window out of full screen within a second of the notes.
        yield key("Escape")
        yield ("wait", 800)
        state = yield ("probe",)
    assert not state["presenting"], ("Escape", state)
    assert state["focused"] == "galatsa-canvas", ("focus", state)
    assert not state["fullscreen"], ("full screen", state)


check.scenario = scenario

if __name__ == "__main__":
    sys.exit(check.main())
