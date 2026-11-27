# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs the storage check page (bench/storage-check.html) in WebKitGTK.

Playwright's WebKit build needs libraries of a particular Ubuntu release, so on
other systems the storage layer is checked in the system's WebKitGTK instead,
which is also the engine the Linux desktop app draws in. Phase 1 runs the
backend contract, a damaged checkpoint, the checkpoint worker and the file
handle check, then edits a document and stores it. Then the web process is
killed (a real crash), and phase 2, in a new web process with the same storage,
must be offered the document and open it unchanged.

Needs python-gobject, WebKitGTK 6.0 and a display; run it without a visible
window, from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/storage_check.py

It starts the bench's Vite server on port 5199 itself, unless one is running.
Exit code 0 when both phases pass.
"""

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

PORT = 5199
BASE = f"http://localhost:{PORT}/storage-check.html"
TIMEOUT_S = 120


def port_open() -> bool:
    # Vite may listen on ::1 only; "localhost" tries both.
    try:
        socket.create_connection(("localhost", PORT), timeout=0.2).close()
        return True
    except OSError:
        return False


def start_server():
    if port_open():
        return None
    server = subprocess.Popen(
        ["pnpm", "--filter", "@galatsa/bench", "exec", "vite", "--port", str(PORT), "--strictPort"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 60
    while not port_open():
        if time.time() > deadline or server.poll() is not None:
            server.kill()
            raise SystemExit("the bench server did not start")
        time.sleep(0.2)
    return server


def main() -> int:
    server = start_server()
    data = tempfile.mkdtemp(prefix="galatsa-webkit-")
    results = []
    try:
        session = WebKit.NetworkSession.new(os.path.join(data, "data"), os.path.join(data, "cache"))
        Gtk.init()
        loop = GLib.MainLoop()
        view = WebKit.WebView(network_session=session)
        window = Gtk.Window(title="storage check")
        window.set_default_size(400, 300)
        window.set_child(view)
        window.present()
        phases = ["phase1", "phase2"]

        def run(phase: str) -> None:
            view.load_uri(f"{BASE}?auto={phase}")

        def on_title(*_args) -> None:
            title = view.get_title() or ""
            if not (title.startswith("done:") or title.startswith("failed:")):
                return
            results.append(title)
            print(title, flush=True)
            if title.startswith("failed:") or len(results) == len(phases):
                loop.quit()
                return
            # A real crash: the web process dies without closing anything.
            view.terminate_web_process()
            GLib.timeout_add(500, lambda: (run(phases[len(results)]), False)[1])

        view.connect("notify::title", on_title)
        GLib.timeout_add_seconds(TIMEOUT_S, lambda: (results.append("failed: timeout"), loop.quit())[1] or False)
        version = f"{WebKit.get_major_version()}.{WebKit.get_minor_version()}.{WebKit.get_micro_version()}"
        print(f"WebKitGTK {version}", flush=True)
        run(phases[0])
        loop.run()
    finally:
        shutil.rmtree(data, ignore_errors=True)
        if server:
            server.terminate()
    ok = len(results) == 2 and all(r.startswith("done:") for r in results)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
