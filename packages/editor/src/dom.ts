// SPDX-License-Identifier: GPL-3.0-or-later

// DOM input for the editor: pointer events (mouse, pen, touch and trackpad
// clicks are all pointer events), wheel events (mouse wheels and trackpad
// scrolling and pinching), and keys, turned into the plain input the editor
// core takes.
//
// - The primary button of the first pointer that goes down is the tool's until
//   it goes up; other buttons are ignored, and a pointer whose pointerup never
//   came is dropped (pointers.ts).
// - The camera (docs/adr/0009): the middle button drags the canvas, and so
//   does the primary button while Space is held (the editor's hand). Two fingers pan
//   and pinch. The wheel and two fingers on a trackpad scroll the canvas
//   (Shift turns a mouse wheel sideways); with Ctrl or Cmd, which is also what
//   browsers send for a pinch on a trackpad, they zoom about the pointer.
//   Safari sends its own gesture events for a trackpad pinch; they zoom too.
// - Keys go to the editor while the canvas has focus. It takes focus when it
//   is clicked, and lets go of held keys (Space) when it loses it.
// - Copy, cut and paste carry the system clipboard; a right click opens the
//   context menu (context-menu.ts).
// - Files dropped on the canvas are imported where they are dropped, files
//   on the clipboard where the view is, and the context menu can pick files
//   (import.ts, docs/adr/0012).

import type { I18n } from "@galatsa/i18n";
import type { Editor, PointerInput } from "./editor.ts";
import {
  readClipboard,
  readClipboardText,
  type ClipboardFile,
  type ClipboardSource,
} from "./clipboard.ts";
import type { ImportFile } from "./import.ts";
import { openContextMenu, type MenuClipboard } from "./context-menu.ts";
import { keyInput } from "./keymap.ts";
import { PointerTracker, type PointerAction, type PointerFacts } from "./pointers.ts";

/** One wheel "line" in pixels, for wheels that report lines. */
const LINE = 16;
/** Zoom per pixel of wheel movement with Ctrl or Cmd (e^0.01 per pixel). */
const ZOOM_PER_PIXEL = 0.01;
/**
 * The most wheel movement one event zooms by, in pixels. A mouse wheel's
 * notch is 100 pixels in Chromium and 3 lines (48 pixels) in Firefox; capped,
 * a notch zooms by e^0.25 (about 1.28) in both, while the small steps of a
 * trackpad pinch (a few pixels each) pass unchanged.
 */
const MAX_ZOOM_PIXELS = 25;

/** The zoom factor for a wheel event with Ctrl or Cmd, `dy` in pixels. */
export function wheelZoomFactor(dy: number): number {
  const capped = Math.max(-MAX_ZOOM_PIXELS, Math.min(MAX_ZOOM_PIXELS, dy));
  return Math.exp(-capped * ZOOM_PER_PIXEL);
}

/**
 * A wheel event's movement in pixels. Wheels may report lines (16 pixels
 * each) or pages: a page is the width of the canvas across and its height
 * down.
 */
export function wheelPixels(
  e: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
  width: number,
  height: number,
): { dx: number; dy: number } {
  if (e.deltaMode === 2) return { dx: e.deltaX * width, dy: e.deltaY * height };
  const line = e.deltaMode === 1 ? LINE : 1;
  return { dx: e.deltaX * line, dy: e.deltaY * line };
}

/**
 * A clipboard event's data, with files that are only listed as items (some
 * browsers give a copied image as an item of kind "file" and no file).
 */
function withItemFiles(data: DataTransfer): ClipboardSource {
  const files: ClipboardFile[] = data.files ? [...data.files] : [];
  if (files.length === 0 && data.items) {
    for (const item of [...data.items]) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null) files.push(file);
    }
  }
  return { types: [...data.types], getData: (type) => data.getData(type), files };
}

/** The files of a drop. */
function filesOf(data: DataTransfer): ImportFile[] {
  const files: ImportFile[] = data.files ? [...data.files] : [];
  if (files.length > 0 || !data.items) return files;
  for (const item of [...data.items]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}

/** Image items of the asynchronous clipboard, as files to import. */
async function imageFilesOf(items: readonly ClipboardItem[]): Promise<ImportFile[]> {
  const files: ImportFile[] = [];
  for (const [i, item] of items.entries()) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type === undefined) continue;
    const blob = await item.getType(type);
    const suffix = type
      .slice("image/".length)
      .replace("svg+xml", "svg")
      .replace("jpeg", "jpg");
    files.push({
      name: `clipboard-${i + 1}.${suffix}`,
      type,
      size: blob.size,
      arrayBuffer: () => blob.arrayBuffer(),
    });
  }
  return files;
}

/** The file input's `accept`: the media types and extensions the importers read. */
function acceptFor(editor: Editor): string {
  const out = new Set<string>();
  for (const importer of editor.host.importers(editor.mode)) {
    for (const type of importer.definition.fileTypes) {
      for (const media of type.mediaTypes) out.add(media);
      for (const extension of type.extensions) out.add(`.${extension}`);
    }
  }
  return [...out].join(",");
}

/** Safari's gesture events (a pinch on a trackpad): not in the DOM's types. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

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
        case "tool-withdraw":
          editor.pointerWithdraw();
          break;
        case "pan":
          editor.pan(action.dx, action.dy);
          break;
        case "pinch": {
          const rect = surface.getBoundingClientRect();
          editor.pinch(
            { x: action.from.x - rect.left, y: action.from.y - rect.top },
            { x: action.to.x - rect.left, y: action.to.y - rect.top },
            action.factor,
          );
          break;
        }
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
      let { dx, dy } = wheelPixels(e, surface.clientWidth, surface.clientHeight);
      if (e.ctrlKey || e.metaKey) {
        const rect = surface.getBoundingClientRect();
        editor.zoomAt(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          wheelZoomFactor(dy),
        );
        return;
      }
      // Shift and a mouse wheel scroll sideways; most browsers already turn
      // the movement, some do not.
      if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      editor.pan(-dx, -dy);
    },
    { passive: false },
  );
  // Safari: a pinch on a trackpad comes as gesture events, with the scale
  // since the gesture began. On iOS a pinch also comes as two touch pointers,
  // which already zoom; the gesture events are then ignored.
  let gestureScale = 1;
  const gesture = (type: string, handle: (e: GestureEvent) => void): void => {
    const listener = (event: Event): void => {
      event.preventDefault();
      handle(event as GestureEvent);
    };
    surface.addEventListener(type, listener, { passive: false });
    offList.push(() => surface.removeEventListener(type, listener));
  };
  gesture("gesturestart", (e) => {
    gestureScale = e.scale > 0 ? e.scale : 1;
  });
  gesture("gesturechange", (e) => {
    if (!(e.scale > 0) || pointers.pinching) return;
    const rect = surface.getBoundingClientRect();
    editor.zoomAt(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      e.scale / gestureScale,
    );
    gestureScale = e.scale;
  });
  gesture("gestureend", () => {
    gestureScale = 1;
  });
  on("blur", () => editor.focusLost());
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
    data === null
      ? editor.clipboardPaste()
      : editor.clipboardPaste(readClipboard(withItemFiles(data))),
  );

  // Files dropped on the canvas: imported where they are dropped.
  const hasFiles = (e: DragEvent): boolean =>
    e.dataTransfer !== null && [...e.dataTransfer.types].includes("Files");
  on("dragover", (e) => {
    if (!hasFiles(e) || !editor.canImport || !editor.inputEnabled) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  });
  on("drop", (e) => {
    if (!hasFiles(e) || !editor.canImport) return;
    e.preventDefault();
    const files = filesOf(e.dataTransfer!);
    if (files.length === 0) return;
    surface.focus({ preventScroll: true });
    const rect = surface.getBoundingClientRect();
    void editor.importFiles(files, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  });

  // Picking files (the context menu's "Insert a file"): a file input that is
  // never shown, accepting what the importers read.
  const chooseFiles = (): void => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.accept = acceptFor(editor);
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      const files = picker.files ? [...picker.files] : [];
      picker.remove();
      surface.focus({ preventScroll: true });
      if (files.length > 0) void editor.importFiles(files);
    });
    picker.addEventListener("cancel", () => picker.remove());
    document.body.append(picker);
    picker.click();
  };

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
      const pasteText = (): void => {
        if (read === undefined) {
          editor.clipboardPaste();
          return;
        }
        read().then(
          (text) => editor.clipboardPaste(readClipboardText(text)),
          () => editor.clipboardPaste(),
        );
      };
      // An image on the clipboard (copied in another program) is imported;
      // the asynchronous clipboard gives it as a typed item. Anything else,
      // or a browser that does not let the page read items, goes the text way.
      const readItems = navigator.clipboard?.read?.bind(navigator.clipboard);
      if (readItems === undefined || !editor.canImport) {
        pasteText();
        return;
      }
      readItems().then(
        async (items) => {
          const files = await imageFilesOf(items);
          if (files.length > 0) void editor.importFiles(files);
          else pasteText();
        },
        () => pasteText(),
      );
    },
    ...(editor.canImport ? { chooseFiles } : {}),
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
