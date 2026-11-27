// SPDX-License-Identifier: GPL-3.0-or-later

// DOM input for the editor: pointer events (mouse, pen, touch and trackpad
// clicks are all pointer events), wheel events (mouse wheels and trackpad
// scrolling and pinching), and keys, turned into the plain input the editor
// core takes.
//
// - The primary button of the first pointer that goes down is the tool's until
//   it goes up; other pointers (a second finger) and other buttons are ignored
//   for now, and a pointer whose pointerup never came is dropped (pointers.ts).
// - The middle button drags the canvas; the wheel scrolls it, and with Ctrl or
//   Cmd (which is also what a trackpad pinch sends) zooms about the pointer.
//   The real camera controls come later; this is enough to reach an element.
// - Keys go to the editor while the canvas has focus. It takes focus when it
//   is clicked.
// - Copy, cut and paste carry the system clipboard; a right click opens the
//   context menu (context-menu.ts).

import type { I18n } from "@galatsa/i18n";
import type { Editor, PointerInput } from "./editor.ts";
import { decodeFragment, readClipboard } from "./clipboard.ts";
import { openContextMenu, type MenuClipboard } from "./context-menu.ts";
import { keyInput } from "./keymap.ts";
import { PointerTracker, type PointerAction, type PointerFacts } from "./pointers.ts";

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

  /** Which pointer the tool has, or which one drags the canvas (pointers.ts). */
  const pointers = new PointerTracker();
  const facts = (e: PointerEvent): PointerFacts => ({
    id: e.pointerId,
    type: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    x: e.clientX,
    y: e.clientY,
  });
  const perform = (e: PointerEvent, actions: readonly PointerAction[]): void => {
    for (const action of actions) {
      switch (action.kind) {
        case "capture":
          e.preventDefault();
          try {
            surface.setPointerCapture(e.pointerId);
          } catch {
            // A pointer that is already gone cannot be captured.
          }
          break;
        case "release":
          if (surface.hasPointerCapture?.(action.id))
            surface.releasePointerCapture(action.id);
          break;
        case "tool-down":
          editor.pointerDown(input(e));
          break;
        case "tool-move":
        case "hover":
          editor.pointerMove(input(e));
          break;
        case "tool-up":
          editor.pointerUp(input(e));
          break;
        case "tool-cancel":
          editor.pointerCancel();
          break;
        case "pan":
          editor.pan(action.dx, action.dy);
          break;
      }
    }
  };

  on("pointerdown", (e) => {
    surface.focus({ preventScroll: true });
    const active = pointers.active;
    const captured = active !== null && surface.hasPointerCapture?.(active) === true;
    perform(e, pointers.down(facts(e), captured));
  });
  on("pointermove", (e) => perform(e, pointers.move(facts(e))));
  on("pointerup", (e) => perform(e, pointers.up(facts(e))));
  const cancel = (e: PointerEvent): void => perform(e, pointers.cancel(facts(e)));
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
  // Copy, cut and paste: the browser's events, while the canvas has focus
  // (they are sent to the document when the focused element is not editable).
  // They carry the system clipboard (clipboard.ts).
  let clipboardHandled = false;
  const clipboard = (
    type: "copy" | "cut" | "paste",
    handle: (data: DataTransfer | null) => boolean,
  ): void => {
    const listener = (event: ClipboardEvent): void => {
      if (document.activeElement !== surface) return;
      if (handle(event.clipboardData)) {
        clipboardHandled = true;
        event.preventDefault();
      }
    };
    document.addEventListener(type, listener);
    offList.push(() => document.removeEventListener(type, listener));
  };
  clipboard("copy", (data) => editor.clipboardCopy(data ?? undefined));
  clipboard("cut", (data) => editor.clipboardCut(data ?? undefined));
  clipboard("paste", (data) =>
    data === null ? editor.clipboardPaste() : editor.clipboardPaste(readClipboard(data)),
  );

  // The context menu's clipboard entries go through the same events: the
  // browser sends a copy or cut event for `execCommand` during a click. A
  // paste event cannot be asked for that way; the asynchronous clipboard is
  // read instead, and where the browser refuses, the editor's last copy is
  // pasted.
  const menuClipboard: MenuClipboard = {
    copy: () => viaEvent("copy", () => editor.clipboardCopy()),
    cut: () => viaEvent("cut", () => editor.clipboardCut()),
    paste: () => {
      const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
      if (read === undefined) {
        editor.clipboardPaste();
        return;
      }
      read().then(
        (text) => {
          const fragment = decodeFragment(text);
          if (fragment !== undefined)
            editor.clipboardPaste({ fragment, text: null, files: [] });
        },
        () => editor.clipboardPaste(),
      );
    },
  };
  const viaEvent = (command: "copy" | "cut", fallback: () => boolean): void => {
    surface.focus({ preventScroll: true });
    clipboardHandled = false;
    let sent: boolean;
    try {
      sent = document.execCommand(command);
    } catch {
      sent = false;
    }
    // Without the event (a browser that refuses), the copy stays in memory.
    if (!sent || !clipboardHandled) fallback();
  };
  on("contextmenu", (e) => {
    e.preventDefault();
    const rect = surface.getBoundingClientRect();
    openContextMenu(
      editor,
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      menuClipboard,
    );
  });
  // The canvas takes the keys back when the menu closes.
  const stopMenu = editor.contextMenu.subscribe(() => {
    if (editor.contextMenu.state === null && surface.isConnected)
      surface.focus({ preventScroll: true });
  });
  offList.push(stopMenu);
  offList.push(() => editor.contextMenu.close());
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
