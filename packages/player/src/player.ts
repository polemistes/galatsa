// SPDX-License-Identifier: GPL-3.0-or-later

// The player in a page: the stage, the keyboard, clickers, the mouse and
// touch, full screen, the laser pointer, the black screen, the list of stops
// and routes, and the presenter's notes, around a presentation
// (presentation.ts). The editor presents the open document with this, and a
// player of its own is the same code over a document read from a file. Plain
// DOM: no framework, and only the viewing parts of the extensions. See
// docs/adr/0015-presentation.md.

import type { CameraView, ElementId, RouteId } from "@galatsa/core";
import type { ViewHost } from "@galatsa/extension-api";
import {
  watchSystemReducedMotion,
  type ComfortPreferences,
} from "@galatsa/extension-transitions";
import type { I18n } from "@galatsa/i18n";
import type { ImageSource, SceneAssets, SceneSource } from "@galatsa/renderer";
import { isReloadKey, keyAction, type KeyAction } from "./keys.ts";
import { playerMessages } from "./messages/index.ts";
import type { PresentationSource } from "./model.ts";
import { openNotes, positionText, stepName, type NotesView } from "./notes.ts";
import { Presentation } from "./presentation.ts";
import { Stage } from "./stage.ts";

export interface PlayerOptions {
  /** The extensions: only their viewing parts are used (element types, transitions). */
  readonly host: ViewHost;
  readonly i18n: I18n;
  /** The routes and stops, and the resolved elements. */
  readonly source: PresentationSource;
  /** The resolved document as the renderer reads it. */
  readonly scene: SceneSource;
  readonly images?: ImageSource;
  readonly assets?: SceneAssets;
  /**
   * For a document that may change while it is presented: calls `changed`
   * after each change with the elements to read again (as the renderer's
   * `applyChanges` takes them; none when only stops or routes changed).
   * Returns how to stop.
   */
  readonly watch?: (changed: (ids: Iterable<ElementId>) => void) => () => void;
  /** The route to play (default the first) and the step to start at (default the first). */
  readonly route?: RouteId | null;
  readonly step?: number;
  /** What to show when there is no stop to start at. */
  readonly view?: CameraView;
  readonly preferences?: ComfortPreferences;
  /** Ask for full screen at once. Only works from a key press or a click. */
  readonly fullscreen?: boolean;
  /** CSS colour behind the canvas; default white. */
  readonly background?: string;
  /** Called once, when the presentation has ended. */
  readonly onExit?: () => void;
  /** Whether keys are named as on a Mac; default from the browser. */
  readonly mac?: boolean;
}

export interface MountedPlayer {
  readonly element: HTMLElement;
  readonly presentation: Presentation;
  readonly stage: Stage;
  /** Ends the presentation and removes it from the page. */
  exit(): void;
}

// i18n-ignore: a style sheet, not text
const STYLE = `
.galatsa-player{position:fixed;inset:0;z-index:2147483000;background:#000;color:#f9fafb;
font:14px/1.4 system-ui,sans-serif;outline:none;overflow:hidden;touch-action:none;
user-select:none;-webkit-user-select:none}
.galatsa-player.gp-idle,.galatsa-player.gp-pointing .gp-stage{cursor:none}
.gp-stage,.gp-blank{position:absolute;inset:0}
.gp-fade{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.gp-blank{background:#000}
.gp-laser{position:absolute;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;
border-radius:50%;background:#ff2a2a;pointer-events:none;
box-shadow:0 0 6px 3px rgba(255,42,42,.7),0 0 18px 8px rgba(255,42,42,.35)}
.gp-status{position:absolute;left:16px;top:16px;max-width:60%;padding:6px 10px;border-radius:6px;
background:rgba(17,24,39,.85);pointer-events:none}
.gp-bar{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:4px;
max-width:calc(100% - 16px);flex-wrap:wrap;justify-content:center;padding:6px;border-radius:10px;
background:rgba(17,24,39,.9);transition:opacity .2s}
.gp-idle .gp-bar{opacity:0;pointer-events:none}
.gp-bar button,.gp-list button,.gp-list select{font:inherit;color:inherit;
background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:6px;
padding:6px 10px;cursor:pointer}
.gp-bar button:disabled{opacity:.45;cursor:default}
.gp-bar button[aria-pressed=true]{background:#2563eb}
.gp-full-back{position:absolute;left:50%;top:16px;transform:translateX(-50%);font:inherit;
font-size:16px;color:#fff;background:#2563eb;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;
box-shadow:0 4px 18px rgba(0,0,0,.5)}
.gp-list,.gp-notes{position:absolute;top:16px;bottom:72px;overflow:auto;border-radius:10px;
background:rgba(17,24,39,.96)}
.gp-list{right:16px;width:min(320px,80%);padding:12px}
.gp-notes{left:16px;width:min(420px,80%)}
.gp-list select{width:100%;margin-top:4px}
.gp-list option{color:#111827}
.gp-list ol{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}
.gp-list li button{width:100%;text-align:left}
.gp-list li button[aria-current]{background:#2563eb}
@media (prefers-reduced-motion:reduce){.gp-bar{transition:none}}
`;

/** A pointer may move this far (CSS pixels) and still be a tap or a click. */
const TAP_SLOP = 6;
/** The controls go away after this long without the mouse moving. */
const IDLE_MS = 2500;
/** How long a message stays. */
const STATUS_MS = 2500;
/** A stop's number typed on the keyboard is forgotten after this long. */
const DIGITS_MS = 3000;
/** Zoom per pixel of wheel movement with Ctrl or Cmd, and the most per event (as in the editor). */
const ZOOM_PER_PIXEL = 0.01;
const MAX_ZOOM_PIXELS = 25;
const KEY_ZOOM = 1.5;

/** Whether the browser runs on a Mac (or an iPhone or iPad), where keys have other names. */
function onMac(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } })
    .navigator;
  return /Mac|iPhone|iPad|iPod/i.test(nav?.platform ?? nav?.userAgent ?? "");
}

/**
 * Starts a presentation in `parent`, over everything else in it. Everything
 * else in `parent` is inert while it runs, so the keyboard stays with the
 * presentation. If it cannot start, nothing of it stays in the page and the
 * error is thrown.
 */
export function mountPlayer(parent: HTMLElement, options: PlayerOptions): MountedPlayer {
  const doc = parent.ownerDocument;
  const root = doc.createElement("div");
  root.className = "galatsa-player";
  parent.append(root);
  // What has to be undone when the presentation ends, or fails to start.
  const undo: Array<() => void> = [];
  try {
    return start(parent, root, options, undo);
  } catch (error) {
    for (const step of undo.splice(0).reverse()) {
      try {
        step();
      } catch {
        // The rest is still undone.
      }
    }
    root.remove();
    throw error;
  }
}

function start(
  parent: HTMLElement,
  root: HTMLElement,
  options: PlayerOptions,
  undo: Array<() => void>,
): MountedPlayer {
  const doc = parent.ownerDocument;
  const win = doc.defaultView ?? window;
  const { i18n } = options;
  const t = i18n.translator(playerMessages);
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    into: HTMLElement,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = className;
    into.append(node);
    return node;
  };
  const listen = <T extends EventTarget>(
    target: T,
    type: string,
    listener: (event: never) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, listener as EventListener, opts);
    undo.push(() => target.removeEventListener(type, listener as EventListener, opts));
  };

  root.tabIndex = 0;
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", t("label"));
  el("style", "", root).textContent = STYLE;

  // Whatever else is in the page (the editor) is inert while presenting: it
  // takes no keys, no focus and no clicks, so nothing can be changed there
  // unseen, and Tab cannot take the keyboard away from the presentation.
  for (const other of [...parent.children]) {
    if (other === root || !(other instanceof HTMLElement) || other.inert) continue;
    other.inert = true;
    undo.push(() => {
      other.inert = false;
    });
  }

  let disposed = false;
  let frame = 0;
  const kick = (): void => {
    if (!disposed && frame === 0) frame = win.requestAnimationFrame(tick);
  };

  const stage = new Stage(root, {
    host: options.host,
    scene: options.scene,
    ...(options.images ? { images: options.images } : {}),
    ...(options.assets ? { assets: options.assets } : {}),
    t: (label, values) => i18n.t(label, values),
    ...(options.background !== undefined ? { background: options.background } : {}),
    onInvalidate: () => kick(),
  });
  undo.push(() => stage.dispose());
  const surface = stage.element;

  const motion = watchSystemReducedMotion(
    typeof win.matchMedia === "function" ? (query) => win.matchMedia(query) : undefined,
    (reduced) => presentation.setSystemReducedMotion(reduced),
  );
  undo.push(() => motion.dispose());
  const presentation = new Presentation({
    source: options.source,
    screen: stage.screen,
    transitions: (id) => options.host.transition(id),
    systemReducedMotion: motion.reduced(),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(options.route !== undefined ? { route: options.route } : {}),
    ...(options.step !== undefined ? { step: options.step } : {}),
    ...(options.view ? { view: options.view } : {}),
  });

  function tick(): void {
    frame = 0;
    if (disposed) return;
    presentation.resize(stage.screen);
    // Asked before the picture is taken: a motion that ends between the two
    // still gets the frame that shows where it ended (and tells that it did).
    const moving = presentation.moving;
    stage.draw(presentation.picture());
    if (moving) kick();
  }

  // ---------------------------------------------------------------------------
  // What lies over the stage
  // ---------------------------------------------------------------------------

  const blank = el("div", "gp-blank", root);
  blank.hidden = true;
  // A click or a tap lifts the black screen, and does nothing else.
  blank.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    blank.hidden = true;
    root.focus({ preventScroll: true });
  });
  const dot = el("div", "gp-laser", root);
  dot.hidden = true;
  const status = el("div", "gp-status", root);
  status.setAttribute("role", "status");
  status.hidden = true;
  const notesPanel = el("div", "gp-notes", root);
  notesPanel.hidden = true;
  const list = el("div", "gp-list", root);
  list.setAttribute("role", "dialog");
  list.setAttribute("aria-label", t("stops"));
  list.hidden = true;
  const bar = el("div", "gp-bar", root);
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("label"));

  let statusTimer = 0;
  const say = (message: string, stay = false): void => {
    win.clearTimeout(statusTimer);
    status.textContent = message;
    status.hidden = false;
    if (!stay)
      statusTimer = win.setTimeout(() => {
        status.hidden = true;
      }, STATUS_MS);
  };

  const withKey = (label: string, key: string): string => t("with-key", { label, key });
  const backKey = t((options.mac ?? onMac()) ? "key.backspace.mac" : "key.backspace");
  const button = (
    className: string,
    face: string,
    hint: string,
    action: KeyAction,
  ): HTMLButtonElement => {
    const b = el("button", className, bar);
    b.type = "button";
    b.textContent = face;
    b.title = hint;
    b.setAttribute("aria-label", hint);
    b.addEventListener("click", () => {
      act(action);
      // The keys stay the presentation's after a click on a control.
      if (list.hidden) root.focus({ preventScroll: true });
    });
    return b;
  };
  const previousButton = button(
    "gp-previous",
    "‹",
    withKey(t("previous"), "←"),
    "previous",
  );
  const positionButton = button("gp-position", "", withKey(t("stops"), "G"), "list");
  const nextButton = button("gp-next", "›", withKey(t("next"), "→"), "next");
  const backButton = button("gp-back", t("back"), withKey(t("back"), backKey), "back");
  const laserButton = button(
    "gp-laser-toggle",
    t("laser"),
    withKey(t("laser"), "L"),
    "laser",
  );
  const motionButton = button(
    "gp-motion",
    t("motion"),
    withKey(t("motion"), "M"),
    "motion",
  );
  const notesButton = button(
    "gp-notes-toggle",
    t("notes"),
    withKey(t("notes"), "S"),
    "notes",
  );
  const fullButton = button(
    "gp-fullscreen",
    t("fullscreen"),
    withKey(t("fullscreen"), "F"),
    "fullscreen",
  );
  button("gp-exit", t("exit"), withKey(t("exit"), t("key.escape")), "exit");

  // Shown when the browser left full screen without the presenter asking the
  // presentation to (a cable, a change of screens, Escape): the presentation
  // goes on in the window, and this takes it back.
  const fullBack = el("button", "gp-full-back", root);
  fullBack.type = "button";
  fullBack.textContent = withKey(t("fullscreen.back"), "F");
  fullBack.hidden = true;
  fullBack.addEventListener("click", () => {
    enterFullscreen();
    root.focus({ preventScroll: true });
  });

  // The controls show while the mouse moves, and go away when it rests.
  let idleTimer = 0;
  const wake = (): void => {
    root.classList.remove("gp-idle");
    win.clearTimeout(idleTimer);
    idleTimer = win.setTimeout(() => {
      if (!list.hidden || bar.matches(":hover") || bar.contains(doc.activeElement))
        return;
      root.classList.add("gp-idle");
    }, IDLE_MS);
  };

  // ---------------------------------------------------------------------------
  // State on screen
  // ---------------------------------------------------------------------------

  let laser = false;
  let notes: NotesView | null = null;
  let started = win.performance.now();
  let wasRoaming = presentation.state.phase === "roaming";

  // The list keeps its parts while it is open, so the control that has the
  // keyboard stays: the routes are drawn again only when they change, and a
  // stop that had the keyboard has it again after the stops are drawn.
  const routesBox = el("label", "", list);
  const stepsBox = el("ol", "", list);
  let routesDrawn = "";
  const renderList = (): void => {
    const state = presentation.state;
    const routes = JSON.stringify(state.routes);
    if (routes !== routesDrawn) {
      routesDrawn = routes;
      routesBox.replaceChildren();
      routesBox.hidden = state.routes.length < 2;
      routesBox.append(t("route"));
      const select = el("select", "gp-routes", routesBox);
      state.routes.forEach((route, i) => {
        const option = el("option", "", select);
        option.value = route.id;
        option.textContent =
          route.name !== "" ? route.name : t("route.numbered", { number: i + 1 });
      });
      select.addEventListener("change", () => {
        presentation.setRoute(select.value);
        kick();
      });
    }
    const select = routesBox.querySelector("select");
    if (select !== null && state.route !== null) select.value = state.route;
    // The stop that had the keyboard keeps it, wherever it is in the list now.
    const active = doc.activeElement;
    const focused =
      active instanceof HTMLElement && stepsBox.contains(active)
        ? (active.dataset["entry"] ?? null)
        : null;
    stepsBox.replaceChildren();
    state.steps.forEach((step, i) => {
      const b = el("button", "gp-step", el("li", "", stepsBox));
      b.type = "button";
      b.dataset["entry"] = step.entry;
      b.textContent = `${i + 1}. ${stepName(t, step, i)}`;
      if (i === state.position) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => {
        presentation.goTo(i);
        closeList();
        kick();
      });
    });
    if (focused !== null)
      (
        [...stepsBox.querySelectorAll<HTMLElement>(".gp-step")].find(
          (b) => b.dataset["entry"] === focused,
        ) ??
        stepsBox.querySelector<HTMLElement>("[aria-current]") ??
        root
      ).focus({ preventScroll: true });
  };
  const openList = (): void => {
    list.hidden = false;
    renderList();
    wake();
    (
      list.querySelector<HTMLElement>("[aria-current]") ??
      list.querySelector<HTMLElement>("button, select")
    )?.focus({ preventScroll: true });
  };
  const closeList = (): void => {
    list.hidden = true;
    root.focus({ preventScroll: true });
  };

  const update = (): void => {
    const state = presentation.state;
    const { steps, position, phase } = state;
    const roaming = phase === "roaming";
    root.dataset["phase"] = phase;
    root.dataset["position"] = String(position);
    root.dataset["route"] = state.route ?? "";
    positionButton.textContent = positionText(t, position, steps.length);
    previousButton.disabled = !roaming && position <= 0;
    nextButton.disabled = roaming ? position < 0 : position + 1 >= steps.length;
    backButton.disabled = !roaming || position < 0;
    motionButton.setAttribute("aria-pressed", String(state.reducedMotion));
    laserButton.setAttribute("aria-pressed", String(laser));
    notesButton.setAttribute("aria-pressed", String(notes !== null));
    const full = doc.fullscreenElement === root;
    fullButton.setAttribute("aria-pressed", String(full));
    if (full) fullBack.hidden = true;
    if (roaming && !wasRoaming && position >= 0)
      say(t("status.paused", { key: backKey }));
    wasRoaming = roaming;
    if (!list.hidden) renderList();
    notes?.update();
  };

  // ---------------------------------------------------------------------------
  // Full screen, the notes, the end
  // ---------------------------------------------------------------------------

  /**
   * Leaving full screen does not end the presentation: it goes on in the
   * window. When the presentation did not ask for it (the F key, or a notes
   * window that the browser leaves full screen for), a button to go back to
   * full screen is shown. Escape in full screen only leaves full screen;
   * Escape in a window ends the presentation.
   */
  let wasFull = false;
  /** Until when leaving full screen is the presentation's own doing. */
  let leaving = -Infinity;
  const enterFullscreen = (): void => {
    try {
      void root.requestFullscreen?.()?.catch(() => {});
    } catch {
      // Full screen is refused: the presentation fills the page instead.
    }
  };
  const expectLeaving = (): void => {
    leaving = win.performance.now() + 1500;
  };
  const toggleFullscreen = (): void => {
    if (doc.fullscreenElement === root) {
      expectLeaving();
      void doc.exitFullscreen?.().catch(() => {});
    } else enterFullscreen();
  };
  const onFullscreen = (): void => {
    const full = doc.fullscreenElement === root;
    const left = wasFull && !full;
    wasFull = full;
    if (left && win.performance.now() > leaving) {
      fullBack.hidden = false;
    }
    if (left && win.performance.now() <= leaving) {
      // The leaving that was expected; a later one is not.
      leaving = -Infinity;
      fullBack.hidden = true;
    }
    update();
    kick();
  };
  listen(doc, "fullscreenchange", onFullscreen);

  const closeNotes = (): void => {
    notes?.close();
    notes = null;
    update();
  };
  const toggleNotes = (): void => {
    if (notes !== null) {
      closeNotes();
      return;
    }
    // A new window takes the browser out of full screen; that is not the end.
    expectLeaving();
    notes = openNotes(
      notesPanel,
      {
        i18n,
        t,
        presentation,
        started: () => started,
        resetTime: () => {
          started = win.performance.now();
        },
        onKey,
        act,
        onClose: () => {
          if (notes !== null) closeNotes();
        },
      },
      () => win.open("", "galatsa-notes", "popup,width=560,height=680"),
    );
    update();
  };
  const clock = win.setInterval(() => notes?.update(), 500);
  undo.push(() => win.clearInterval(clock));
  // The notes window goes when the page that draws it goes (reloaded, closed).
  listen(win, "pagehide", () => {
    notes?.close();
    notes = null;
  });

  // The screen stays on while presenting, where the browser can keep it on.
  type Lock = { release(): Promise<void> };
  let lock: Lock | null = null;
  const keepAwake = (): void => {
    const wakeLock = (
      win.navigator as { wakeLock?: { request(type: "screen"): Promise<Lock> } }
    ).wakeLock;
    if (disposed || doc.visibilityState !== "visible" || !wakeLock) return;
    wakeLock.request("screen").then(
      (taken) => {
        if (disposed) void taken.release().catch(() => {});
        else lock = taken;
      },
      () => {},
    );
  };
  listen(doc, "visibilitychange", keepAwake);
  undo.push(() => void lock?.release().catch(() => {}));
  keepAwake();

  undo.push(() => {
    disposed = true;
    win.cancelAnimationFrame(frame);
    win.clearTimeout(idleTimer);
    win.clearTimeout(statusTimer);
    win.clearTimeout(digitsTimer);
    notes?.close();
    notes = null;
    if (doc.fullscreenElement === root) void doc.exitFullscreen?.().catch(() => {});
  });

  function exit(): void {
    if (disposed) return;
    disposed = true;
    for (const step of undo.splice(0).reverse()) {
      try {
        step();
      } catch (error) {
        console.error(error);
      }
    }
    root.remove();
    options.onExit?.();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  let digits = "";
  let digitsTimer = 0;
  const forgetDigits = (): void => {
    win.clearTimeout(digitsTimer);
    if (digits !== "") status.hidden = true;
    digits = "";
  };

  function act(action: KeyAction): void {
    if (typeof action === "object") {
      digits = (digits + String(action.digit)).slice(-4);
      win.clearTimeout(digitsTimer);
      digitsTimer = win.setTimeout(forgetDigits, DIGITS_MS);
      say(t("status.goto", { number: Number(digits) }), true);
      return;
    }
    forgetDigits();
    // A black screen is lifted by the key that made it, or by any key that
    // would move on; nothing moves behind it. (A stop's number and Enter
    // lifts it and goes there.)
    if (
      !blank.hidden &&
      action !== "exit" &&
      action !== "fullscreen" &&
      action !== "notes"
    ) {
      blank.hidden = true;
      return;
    }
    switch (action) {
      case "next":
        presentation.next();
        break;
      case "previous":
        presentation.previous();
        break;
      case "back":
        presentation.back();
        break;
      case "first":
        presentation.goTo(0);
        break;
      case "last":
        presentation.goTo(presentation.state.steps.length - 1);
        break;
      case "blank":
        blank.hidden = false;
        break;
      case "list":
        if (list.hidden) openList();
        else closeList();
        break;
      case "laser":
        laser = !laser;
        root.classList.toggle("gp-pointing", laser);
        if (!laser) dot.hidden = true;
        say(t(laser ? "status.laser.on" : "status.laser.off"));
        update();
        break;
      case "motion": {
        const on = !presentation.state.reducedMotion;
        presentation.setReducedMotion(on);
        say(t(on ? "status.motion.on" : "status.motion.off"));
        break;
      }
      case "notes":
        toggleNotes();
        break;
      case "fullscreen":
        toggleFullscreen();
        break;
      case "zoom-in":
      case "zoom-out": {
        const { width, height } = stage.screen;
        presentation.zoomAt(
          { x: width / 2, y: height / 2 },
          action === "zoom-in" ? KEY_ZOOM : 1 / KEY_ZOOM,
        );
        break;
      }
      case "exit":
        // Escape in full screen leaves full screen (the browser does that
        // whatever the page does); only in a window does it end. (Chromium
        // tells the page about that Escape while still in full screen;
        // Firefox and WebKitGTK do not tell it at all.)
        if (doc.fullscreenElement === root) {
          void doc.exitFullscreen?.().catch(() => {});
          return;
        }
        exit();
        return;
    }
    kick();
  }

  /** The clicker's keys: always the presentation's, whatever has the keyboard. */
  const CLICKER = new Set([
    "PageDown",
    "PageUp",
    "ArrowRight",
    "ArrowLeft",
    "ArrowDown",
    "ArrowUp",
    " ",
    "Home",
    "End",
  ]);

  /** Tab and Shift+Tab go round the presentation's own controls. */
  const moveFocus = (back: boolean): void => {
    const order = [
      root,
      ...root.querySelectorAll<HTMLElement>("button, select, [tabindex]"),
    ].filter(
      (node) =>
        !(node as HTMLButtonElement).disabled &&
        (node === root || node.getClientRects().length > 0),
    );
    const at = order.indexOf(doc.activeElement as HTMLElement);
    const next =
      at < 0 ? 0 : (at + (back ? order.length - 1 : 1)) % Math.max(order.length, 1);
    order[next]?.focus({ preventScroll: true });
  };

  function onKey(event: KeyboardEvent): void {
    if (disposed || event.isComposing) return;
    // Nothing reloads the page in the middle of a presentation: not F5 out of
    // habit, nor a clicker whose start button sends it.
    if (isReloadKey(event)) {
      event.preventDefault();
      return;
    }
    const target = event.target as Element | null;
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      (target === null || target.ownerDocument === doc)
    ) {
      event.preventDefault();
      moveFocus(event.shiftKey);
      return;
    }
    const action = keyAction(event);
    if (action === null) return;
    // The presentation has the page: its own keys, and keys that nothing has
    // (the keyboard is on the page itself). Not keys of another view.
    if (
      target !== null &&
      target.ownerDocument === doc &&
      !root.contains(target) &&
      target !== doc.body &&
      target !== doc.documentElement
    )
      return;
    // A stop's number and Enter go to that stop, and lift a black screen.
    if (event.key === "Enter" && digits !== "") {
      event.preventDefault();
      const index = Number(digits) - 1;
      forgetDigits();
      blank.hidden = true;
      presentation.goTo(index);
      kick();
      return;
    }
    // A button that has the keyboard keeps Enter, which presses it. Every
    // other key is the presentation's: the clicker's keys (the arrows, the
    // page keys, Space) never press a button, move in the list of stops or
    // change the route, so a clicker goes on working wherever the keyboard
    // is. Escape ends the presentation (in full screen it first leaves full
    // screen, see `act`).
    const control = target?.closest?.("button, select, input, textarea") ?? null;
    if (control !== null && action !== "exit" && !CLICKER.has(event.key)) {
      const own =
        control.localName === "button"
          ? event.key === "Enter"
          : control.localName !== "select";
      if (own) return;
    }
    event.preventDefault();
    act(action);
  }
  listen(doc, "keydown", onKey);
  // The keyboard stays in the presentation: focus that lands outside it (on
  // something the page put there later) comes back.
  listen(doc, "focusin", (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Node && !root.contains(target))
      root.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------------------
  // The mouse, touch and the wheel
  // ---------------------------------------------------------------------------

  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = surface.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const pointers = new Map<number, { x: number; y: number }>();
  /** The press that may still be a tap: where it began, and whether it moved or became a pinch. */
  let press: { x: number; y: number; moved: boolean } | null = null;

  const showDot = (e: PointerEvent): void => {
    if (!laser) return;
    const box = root.getBoundingClientRect();
    dot.style.transform = `translate(${e.clientX - box.left}px,${e.clientY - box.top}px)`;
    dot.hidden = false;
  };

  surface.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    root.focus({ preventScroll: true });
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured.
    }
    const at = point(e);
    pointers.set(e.pointerId, at);
    // A press outside the open list only closes it.
    press = pointers.size === 1 && list.hidden ? { ...at, moved: false } : null;
    list.hidden = true;
    showDot(e);
  });
  surface.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") wake();
    showDot(e);
    const last = pointers.get(e.pointerId);
    if (last === undefined) return;
    const at = point(e);
    if (pointers.size === 1) {
      if (press !== null && !press.moved) {
        // Not a drag yet: the pointer stays where the press began.
        if (Math.hypot(at.x - press.x, at.y - press.y) <= TAP_SLOP) return;
        press.moved = true;
      }
      // With the laser pointer out, a drag points; it does not move the canvas.
      if (!laser) presentation.pan(at.x - last.x, at.y - last.y);
    } else if (pointers.size === 2) {
      // Two fingers: the point between them stays between them.
      const [a, b] = [...pointers.entries()];
      const other = a![0] === e.pointerId ? b![1] : a![1];
      const spread = Math.hypot(last.x - other.x, last.y - other.y);
      const spreadNow = Math.hypot(at.x - other.x, at.y - other.y);
      presentation.pinch(
        { x: (last.x + other.x) / 2, y: (last.y + other.y) / 2 },
        { x: (at.x + other.x) / 2, y: (at.y + other.y) / 2 },
        spread > 0 && spreadNow > 0 ? spreadNow / spread : 1,
      );
    }
    pointers.set(e.pointerId, at);
    kick();
  });
  const lift = (e: PointerEvent, tap: boolean): void => {
    if (!pointers.delete(e.pointerId)) return;
    if (e.pointerType !== "mouse") dot.hidden = true;
    const pressed = press;
    if (pointers.size === 0) press = null;
    if (!tap || pressed === null || pressed.moved || pointers.size > 0) return;
    const { width, height } = stage.screen;
    if (e.pointerType === "touch") {
      // The lower edge brings the controls; the left quarter goes back.
      if (pressed.y > height * 0.85) wake();
      else act(pressed.x < width * 0.25 ? "previous" : "next");
    } else act("next");
  };
  surface.addEventListener("pointerup", (e) => lift(e, true));
  surface.addEventListener("pointercancel", (e) => lift(e, false));
  surface.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && pointers.size === 0) dot.hidden = true;
  });
  surface.addEventListener("contextmenu", (e) => e.preventDefault());
  surface.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.screen.height : 1;
      let dx = e.deltaX * scale;
      let dy = e.deltaY * scale;
      if (e.ctrlKey || e.metaKey) {
        const capped = Math.max(-MAX_ZOOM_PIXELS, Math.min(MAX_ZOOM_PIXELS, dy));
        presentation.zoomAt(point(e), Math.exp(-capped * ZOOM_PER_PIXEL));
      } else {
        if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
        presentation.pan(-dx, -dy);
      }
      kick();
    },
    { passive: false },
  );
  bar.addEventListener("pointermove", wake);
  bar.addEventListener("focusin", wake);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  undo.push(
    presentation.subscribe(() => {
      update();
      kick();
    }),
  );
  const stopWatching = options.watch?.((ids) => {
    if (disposed) return;
    stage.changed(ids);
    presentation.documentChanged();
    kick();
  });
  if (stopWatching) undo.push(stopWatching);
  if (options.fullscreen) enterFullscreen();
  update();
  wake();
  root.focus({ preventScroll: true });
  kick();

  return { element: root, presentation, stage, exit };
}
