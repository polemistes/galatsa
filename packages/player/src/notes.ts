// SPDX-License-Identifier: GPL-3.0-or-later

// Notes for the one who presents: the notes of the stop, which stop comes
// next, the time and the time used, in a window of its own, so that it can
// stay on the presenter's screen while the presentation fills the audience's.
// The window is opened by this page and drawn by it (no second program and no
// messages between windows). Where the browser does not open one, the same
// view is shown over the presentation. See docs/adr/0015-presentation.md.

import type { I18n, Translate } from "@galatsa/i18n";
import type { BundleKey } from "@galatsa/i18n";
import type { playerMessages } from "./messages/index.ts";
import type { Step } from "./model.ts";
import type { Presentation } from "./presentation.ts";

type T = Translate<BundleKey<typeof playerMessages>>;

/** A step's name as shown: its own, or "Stop 3". */
export function stepName(t: T, step: Step, index: number): string {
  return step.name !== "" ? step.name : t("stop.numbered", { number: index + 1 });
}

/**
 * Where the presentation is in its route: "3 of 12"; a dash for the number
 * when none of the route's stops has been shown yet.
 */
export function positionText(t: T, position: number, count: number): string {
  if (count === 0) return t("position.none");
  return t("position", { number: position < 0 ? "–" : position + 1, count });
}

/** Minutes and seconds (and hours, past the first), in digits. */
export function elapsedDigits(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  const rest = `${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

// i18n-ignore: a style sheet, not text
const STYLE = `
html,body{margin:0;height:100%;background:#111827}
.gn{box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;padding:16px;
background:#111827;color:#f9fafb;font:16px/1.45 system-ui,sans-serif;user-select:text;-webkit-user-select:text}
.gn-top{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;font-variant-numeric:tabular-nums}
.gn-time{font-size:28px;font-weight:600}
.gn-dim{color:#9ca3af;font-size:13px}
.gn-where{font-size:18px;font-weight:600}
.gn-paused{color:#fbbf24}
.gn-text{flex:1;min-height:60px;overflow:auto;white-space:pre-wrap;font-size:20px;
padding:12px;border-radius:8px;background:#1f2937}
.gn-row{display:flex;flex-wrap:wrap;gap:8px}
.gn button{font:inherit;color:inherit;background:#374151;border:1px solid #4b5563;border-radius:6px;
padding:8px 14px;cursor:pointer}
.gn button:disabled{opacity:.45;cursor:default}
`;

export interface NotesOptions {
  readonly i18n: I18n;
  readonly t: T;
  readonly presentation: Presentation;
  /** When the time used started (milliseconds, the platform's clock). */
  started(): number;
  resetTime(): void;
  /** Keys pressed in the notes window go to the presentation. */
  onKey(event: KeyboardEvent): void;
  act(action: "next" | "previous" | "back"): void;
  /** Called when the notes are closed (the window was closed, or the view's button). */
  onClose(): void;
}

export interface NotesView {
  /** The window, or null when the notes are shown over the presentation. */
  readonly window: Window | null;
  /** Shows the presentation's state as it is now, and the time. */
  update(): void;
  close(): void;
}

/** Builds the notes into `container`; returns how to update them. */
function build(
  container: HTMLElement,
  options: NotesOptions,
  inWindow: boolean,
): () => void {
  const { t, i18n, presentation } = options;
  const doc = container.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    parent: HTMLElement,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = className;
    parent.append(node);
    return node;
  };
  const style = el("style", "", container);
  style.textContent = STYLE;
  const root = el("div", "gn", container);
  if (!inWindow) el("div", "gn-dim gn-blocked", root).textContent = t("notes.blocked");
  const top = el("div", "gn-top", root);
  const clock = el("div", "", top);
  el("div", "gn-dim", clock).textContent = t("notes.clock");
  const time = el("div", "gn-time gn-clock", clock);
  const used = el("div", "", top);
  el("div", "gn-dim", used).textContent = t("notes.elapsed");
  const elapsed = el("div", "gn-time gn-elapsed", used);
  const button = (
    label: string,
    className: string,
    parent: HTMLElement,
    run: () => void,
  ) => {
    const b = el("button", className, parent);
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      run();
      b.blur();
    });
    return b;
  };
  button(t("notes.reset"), "gn-reset", top, () => {
    options.resetTime();
    update();
  });
  const where = el("div", "gn-where", root);
  const paused = el("div", "gn-paused", root);
  paused.textContent = t("notes.paused");
  const text = el("div", "gn-text", root);
  const next = el("div", "gn-next", root);
  const row = el("div", "gn-row", root);
  const previousButton = button(t("previous"), "gn-previous", row, () =>
    options.act("previous"),
  );
  const backButton = button(t("back"), "gn-back", row, () => options.act("back"));
  const nextButton = button(t("next"), "gn-go", row, () => options.act("next"));
  if (!inWindow) button(t("close"), "gn-close", row, () => options.onClose());

  const update = (): void => {
    const state = presentation.state;
    const { steps, position } = state;
    const step = steps[position];
    time.textContent = i18n.formatDate(Date.now(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    elapsed.textContent = elapsedDigits(performance.now() - options.started());
    where.textContent =
      step === undefined
        ? positionText(t, position, steps.length)
        : `${positionText(t, position, steps.length)} · ${stepName(t, step, position)}`;
    paused.hidden = state.phase !== "roaming" || step === undefined;
    const notes = step?.notes ?? "";
    text.textContent = notes !== "" ? notes : t("notes.none");
    text.classList.toggle("gn-dim", notes === "");
    const after = steps[position + 1];
    next.textContent =
      after !== undefined
        ? t("notes.next", { name: stepName(t, after, position + 1) })
        : step !== undefined
          ? t("notes.last")
          : "";
    const roaming = state.phase === "roaming";
    previousButton.disabled = !roaming && position <= 0;
    nextButton.disabled = roaming ? position < 0 : position + 1 >= steps.length;
    backButton.disabled = !roaming || position < 0;
  };
  update();
  return update;
}

/**
 * Opens the notes: in a window of their own, or, where the browser does not
 * open one (a pop-up blocker), in `fallback`, an element over the
 * presentation. Must be called from a key press or a click.
 */
export function openNotes(
  fallback: HTMLElement,
  options: NotesOptions,
  open: () => Window | null,
): NotesView {
  let other: Window | null;
  try {
    other = open();
  } catch {
    other = null;
  }
  if (other === null) {
    fallback.replaceChildren();
    fallback.hidden = false;
    return {
      window: null,
      update: build(fallback, options, false),
      close() {
        fallback.hidden = true;
        fallback.replaceChildren();
      },
    };
  }
  const win = other;
  const doc = win.document;
  doc.title = options.t("notes.title");
  doc.documentElement.lang = options.i18n.locale;
  doc.body.replaceChildren();
  const update = build(doc.body, options, true);
  const onKey = (event: KeyboardEvent): void => options.onKey(event);
  doc.addEventListener("keydown", onKey);
  // The presenter closed the window.
  const onHide = (): void => options.onClose();
  win.addEventListener("pagehide", onHide);
  return {
    window: win,
    update,
    close() {
      win.removeEventListener("pagehide", onHide);
      doc.removeEventListener("keydown", onKey);
      win.close();
    },
  };
}
