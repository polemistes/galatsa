# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs the image steps of tests/e2e/images.spec.ts in WebKitGTK.

WebKit has no ImageDecoder, so decoding runs in a worker there; and a WebKit
that cannot encode WebP makes JPEG versions (PNG for images with
transparency). On an empty
document of the development page (apps/web), in the system's WebKitGTK:

- the same JPEG imported five times is one asset, with reduced versions made
  once; a PNG with transparency gets its versions too;
- an SVG is drawn (a pixel of its red square is red on the canvas);
- a crop keeps the image's place and is one undo step;
- a document of 60 images saved as a file and opened again draws every image
  from its stored versions, reading and decoding no original but the small
  SVG's, which has no versions.

The images are drawn in the page; nothing is downloaded. It uses the window,
server and event loop of editor_check.py. Run it without a visible window,
from the repository root:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a \\
        python3 tests/e2e/webkitgtk/image_check.py
"""

import os
import sys

# Importing editor_check would otherwise leave a __pycache__ folder here.
sys.dont_write_bytecode = True
import editor_check as base  # noqa: E402

base.PORT = int(os.environ.get("E2E_WEB_PORT", "5198"))
base.URL = f"http://localhost:{base.PORT}/?scene=empty&lang=en"
base.TITLE = "Galatsa image check"
base.TIMEOUT_S = 300

# Starts the steps once (they run in the page, asynchronously) and reports
# where they are: null until the editor is there, then {"done": false} until
# they finish, then their result.
base.PROBE = """
(() => {
  const dev = window.galatsaDev;
  const editor = dev && dev.editor();
  if (!editor) return JSON.stringify(null);
  if (window.__imageCheck === undefined) {
    window.__imageCheck = { done: false };
    const picture = async (w, h, seed, type, alpha) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!alpha) {
        ctx.fillStyle = `hsl(${(seed * 47) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, w, h);
      }
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = `hsl(${(seed * 31 + i * 29) % 360} 80% 60%)`;
        ctx.beginPath();
        ctx.arc(((i * 37) % 11) / 11 * w, ((i * 53) % 7) / 7 * h, w / 8, 0, 7);
        ctx.fill();
      }
      return new Promise((r) => canvas.toBlob(r, type, 0.9));
    };
    const idle = async () => {
      while (editor.importing) await new Promise((r) => setTimeout(r, 20));
    };
    const settle = async (ed) => {
      for (let i = 0; i < 1000; i++) {
        ed.renderNow();
        if (!ed.renderer.stats.imagesIncomplete && !ed.renderer.images.busy) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    (async () => {
      const out = { done: true };
      try {
        const app = await dev.ready;
        const session = () => app.state.document.session;
        editor.services.camera.set({ space: null, cx: 0, cy: 0, zoom: 1 });
        // The same JPEG five times.
        const jpeg = await picture(1600, 1200, 3, "image/jpeg", false);
        for (let i = 0; i < 5; i++) {
          await editor.importFiles([new File([jpeg], "same.jpg", { type: "image/jpeg" })]);
          await idle();
        }
        const assets = editor.doc.getMap("assets");
        out.assets = assets.size;
        const jpegAsset = [...assets.keys()][0];
        out.jpegVersions = (await session().previewFacts(jpegAsset)).map(
          (f) => `${f.width}:${f.mediaType}`);
        // A PNG with transparency.
        const png = await picture(900, 600, 4, "image/png", true);
        await editor.importFiles([new File([png], "alpha.png", { type: "image/png" })]);
        const pngAsset = editor.scene.element(editor.selection[0]).data.asset;
        out.pngVersions = (await session().previewFacts(pngAsset)).map(
          (f) => `${f.width}:${f.mediaType}`);
        // An SVG with a red square, alone in view.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
          '<rect width="200" height="100" fill="#ff0000"/></svg>';
        await editor.importFiles([new File([svg], "red.svg", { type: "image/svg+xml" })]);
        const svgId = editor.selection[0];
        editor.services.selection.set([]);
        const b = editor.services.scene.bounds(svgId);
        editor.services.camera.set({ space: null, cx: b.x + b.w / 2, cy: b.y + b.h / 2, zoom: 4 });
        out.svgSettled = await settle(editor);
        const canvas = document.querySelector(".galatsa-canvas canvas");
        const ctx = canvas.getContext("2d");
        out.svgPixel = [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3);
        // A crop: one step, the shown part stays in place.
        const steps = editor.undo.undoStack.length;
        const pngId = [...editor.live.ids()].find(
          (id) => editor.scene.element(id).data.asset === pngAsset);
        const before = editor.services.scene.bounds(pngId);
        const cropped = editor.run("galatsa.image/crop", {
          id: pngId, crop: { x: 300, y: 0, w: 600, h: 600 } });
        const after = editor.services.scene.bounds(pngId);
        out.crop = { ok: cropped.ok, steps: editor.undo.undoStack.length - steps,
          right: Math.abs(before.x + before.w - (after.x + after.w)) < 1e-6,
          narrower: after.w < before.w };
        // 60 images, saved as a file and opened again.
        const files = [];
        for (let i = 0; i < 60; i++) {
          files.push(new File([await picture(800, 600, 100 + i, "image/jpeg", false)],
            `image-${i}.jpg`, { type: "image/jpeg" }));
        }
        await editor.importFiles(files);
        await session().checkpoint();
        const bytes = await app.storage.exportFile(session().slot);
        const opened = await app.storage.importFile(bytes, { name: "sixty.galatsa" });
        const slot = opened.session.slot;
        await opened.session.close();
        await app.restore(slot);
        const reopened = dev.editor();
        out.reopenedSettled = await settle(reopened);
        out.reopened = {
          images: [...reopened.live.ids()].filter((id) => !reopened.live.isGone(id)).length,
          decoder: reopened.renderer.images.decoderKind,
          decodes: reopened.renderer.images.stats.decodes,
          originalReads: app.imageStats.originalReads,
          originalDecodes: reopened.renderer.images.stats.originalLevelDecodes,
        };
      } catch (error) {
        out.error = String(error && error.stack || error);
      }
      window.__imageCheck = out;
    })();
  }
  return JSON.stringify(window.__imageCheck);
})()
"""


def scenario():
    state = None
    while state is None or not state.get("done"):
        yield ("wait", 500)
        state = yield ("probe",)
    print(state, flush=True)
    assert "error" not in state, state
    assert state["assets"] == 1, state
    # WebKitGTK 2.54 encodes WebP; a WebKit that cannot gets JPEG versions for
    # opaque images and PNG for others.
    sizes = lambda versions: [v.split(":")[0] for v in versions]  # noqa: E731
    assert sizes(state["jpegVersions"]) == ["256", "512", "1024"], state
    assert sizes(state["pngVersions"]) == ["256", "512"], state
    assert all(v.split(":")[1] in ("image/webp", "image/jpeg") for v in state["jpegVersions"]), state
    assert all(v.split(":")[1] in ("image/webp", "image/png") for v in state["pngVersions"]), state
    assert state["svgSettled"] and state["svgPixel"] == [255, 0, 0], state
    assert state["crop"] == {"ok": True, "steps": 1, "right": True, "narrower": True}, state
    reopened = state["reopened"]
    assert state["reopenedSettled"], state
    assert reopened["images"] == 67, state
    # The SVG is too small for reduced versions: its original is the only one
    # read and decoded. Every other image is drawn from its stored versions.
    assert reopened["originalReads"] == 1 and reopened["originalDecodes"] == 1, state


base.scenario = scenario

if __name__ == "__main__":
    sys.exit(base.main())
