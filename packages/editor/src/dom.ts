// SPDX-License-Identifier: GPL-3.0-or-later

// DOM input for the editor: pointer events (mouse, pen, touch and trackpad
// clicks are all pointer events), wheel events (mouse wheels and trackpad
// scrolling and pinching), and keys, turned into the plain input the editor
// core takes.
//
// - The first pointer that goes down is the tool's until it goes up; other
//   pointers (a second finger) are ignored for now.
// - The middle button drags the canvas; the wheel scrolls it, and with Ctrl or
//   Cmd (which is also what a trackpad pinch sends) zooms about the pointer.
//   The real camera controls come later; this is enough to reach an element.
// - Keys go to the editor while the canvas has focus. It takes focus when it
//   is clicked.

import type { I18n } from "@galatsa/i18n";
import type { Editor, PointerInput } from "./editor.ts";
import { keyInput } from "./keymap.ts";

/** One wheel "line" in pixels, for wheels that report lines. */
const LINE = 16;
/** Zoom per pixel of wheel movement with Ctrl or Cmd. */
const ZOOM_PER_PIXEL = 0.002;

function pointerType(type: string): PointerInput["pointerType"] {
  return type === "pen" || type === "touch" ? type : "mouse";
}

/**
 * Puts the editor's canvas into `container` and connects input. Returns a
 * function that disconnects it and removes the canvas.
 */
export function mountEditor(
  editor: Editor,
  container: HTMLElement,
  i18n: I18n,
): () => void {
  const surface = document.createElement("div");
  surface.className = "galatsa-canvas";
  surface.tabIndex = 0;
  surface.setAttribute("role", "application");
  surface.setAttribute("aria-label", i18n.t("editor:canvas.label"));
  Object.assign(surface.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    outline: "none",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
  });
  container.append(surface);
  editor.mountCanvas(surface);

  const offList: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void => {
    surface.addEventListener(type, listener as EventListener, options);
    offList.push(() =>
      surface.removeEventListener(type, listener as EventListener, options),
    );
  };

  const input = (e: PointerEvent): PointerInput => {
    const rect = surface.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pointerType: pointerType(e.pointerType),
      button: e.button,
      // Mice report 0.5 while a button is down and 0 otherwise.
      pressure: e.pointerType === "mouse" ? 0.5 : e.pressure,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    };
  };

  /** The pointer the tool has, or the one dragging the canvas. */
  let active: { id: number; pan: boolean; x: number; y: number } | null = null;
  const release = (id: number): void => {
    if (surface.hasPointerCapture?.(id)) surface.releasePointerCapture(id);
  };

  on("pointerdown", (e) => {
    surface.focus({ preventScroll: true });
    if (active !== null) return;
    const pan = e.button === 1;
    if (!pan && e.button !== 0 && e.pointerType !== "mouse") return;
    e.preventDefault();
    active = { id: e.pointerId, pan, x: e.clientX, y: e.clientY };
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured.
    }
    if (!pan) editor.pointerDown(input(e));
  });
  on("pointermove", (e) => {
    if (active === null) {
      // Hover: tools may show where they would act.
      if (e.pointerType === "mouse") editor.pointerMove(input(e));
      return;
    }
    if (e.pointerId !== active.id) return;
    if (active.pan) {
      editor.pan(e.clientX - active.x, e.clientY - active.y);
      active.x = e.clientX;
      active.y = e.clientY;
      return;
    }
    editor.pointerMove(input(e));
  });
  on("pointerup", (e) => {
    if (active === null || e.pointerId !== active.id) return;
    const was = active;
    active = null;
    release(e.pointerId);
    if (!was.pan) editor.pointerUp(input(e));
  });
  const cancel = (e: PointerEvent): void => {
    if (active === null || e.pointerId !== active.id) return;
    const was = active;
    active = null;
    if (!was.pan) editor.pointerCancel();
  };
  on("pointercancel", cancel);
  on("lostpointercapture", cancel);
  on(
    "wheel",
    (e) => {
      e.preventDefault();
      const scale =
        e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? surface.clientHeight : 1;
      const dx = e.deltaX * scale;
      const dy = e.deltaY * scale;
      if (e.ctrlKey || e.metaKey) {
        const rect = surface.getBoundingClientRect();
        editor.zoomAt(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          Math.exp(-dy * ZOOM_PER_PIXEL),
        );
      } else editor.pan(-dx, -dy);
    },
    { passive: false },
  );
  on("keydown", (e) => {
    if (e.isComposing) return;
    const result = editor.keyDown({ ...keyInput(e), repeat: e.repeat });
    if (result !== null) e.preventDefault();
  });
  on("keyup", (e) => {
    if (editor.keyUp(keyInput(e))) e.preventDefault();
  });
  // A middle click would start the browser's autoscroll.
  on("auxclick", (e) => e.preventDefault());

  const stopCursor = editor.subscribe((change) => {
    if (change === "cursor") surface.style.cursor = editor.cursor;
  });
  surface.style.cursor = editor.cursor;

  return () => {
    stopCursor();
    for (const off of offList.splice(0)) off();
    surface.remove();
  };
}
