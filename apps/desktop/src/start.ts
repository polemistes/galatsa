// SPDX-License-Identifier: GPL-3.0-or-later

// index.html: the start screen (buttons to run all engines or one), and after a
// session the summary and where the results were saved.

import { REFERENCE_VIEWPORT } from "@galatsa/bench";
import { LOCALE_NAMES, LOCALES } from "@galatsa/i18n";
import { host, type Settings } from "./host.ts";
import { engineName, i18n, setLocale, summaryLines, t } from "./i18n.ts";
import {
  ENGINE_IDS,
  type EngineId,
  isEngineId,
  MINUTES_PER_ENGINE,
  planToQuery,
  sessionStamp,
} from "./plan.ts";
import { parseSummary, SUMMARY_FILE } from "./summary.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function windowFits(): boolean {
  return (
    document.documentElement.clientWidth >= REFERENCE_VIEWPORT.width &&
    document.documentElement.clientHeight >= REFERENCE_VIEWPORT.height
  );
}

async function start(engines: readonly EngineId[]): Promise<void> {
  const session = await host.startSession(sessionStamp(new Date()));
  location.href = `run.html${planToQuery({ session: session.id, engines, index: 0 })}`;
}

function render(root: HTMLElement, settings: Settings, done: string | null): void {
  root.replaceChildren();
  document.title = t("app.title");
  const title = el("h1");
  title.textContent = t("app.title");

  const language = el("div", "language");
  const languageLabel = el("span");
  languageLabel.textContent = `${t("app.language")}: `;
  language.append(languageLabel);
  for (const locale of LOCALES) {
    const button = el("button", "link");
    button.textContent = LOCALE_NAMES[locale];
    button.disabled = locale === i18n.locale;
    button.addEventListener("click", () => setLocale(locale));
    language.append(button);
  }
  root.append(title, language);

  const error = el("p", "error");
  error.hidden = true;
  const showError = (e: unknown) => {
    error.hidden = false;
    error.textContent = e instanceof Error ? e.message : String(e);
  };

  if (done !== null) {
    void renderDone(root, done, showError);
    root.append(error);
    return;
  }

  const intro = el("p");
  intro.textContent = t("app.intro");
  const before = el("p");
  before.textContent = t("app.before");
  const size = el("p", "size");
  const buttons: HTMLButtonElement[] = [];
  const updateSize = () => {
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const fits = windowFits();
    size.className = fits ? "size ok" : "size error";
    size.textContent = fits
      ? t("window.ok", { width, height })
      : t("window.tooSmall", {
          width,
          height,
          needWidth: REFERENCE_VIEWPORT.width,
          needHeight: REFERENCE_VIEWPORT.height,
        });
    for (const b of buttons) b.disabled = !fits;
  };

  const runAll = el("button", "primary");
  runAll.textContent = t("action.runAll");
  runAll.addEventListener("click", () => start(ENGINE_IDS).catch(showError));
  buttons.push(runAll);
  const hint = el("p", "hint");
  hint.textContent = t("action.runAllHint", {
    minutes: ENGINE_IDS.length * MINUTES_PER_ENGINE,
  });

  const single = el("div", "single");
  for (const id of ENGINE_IDS) {
    const button = el("button");
    button.textContent = t("action.runOne", { engine: engineName(id) });
    button.addEventListener("click", () => start([id]).catch(showError));
    buttons.push(button);
    single.append(button);
  }

  const where = el("p", "where");
  where.textContent = t("results.where", { path: settings.resultsRoot });
  const open = el("button");
  open.textContent = t("action.openFolder");
  open.addEventListener("click", () => host.openFolder(null).catch(showError));

  root.append(intro, before, size, runAll, hint, single, where, open, error);
  updateSize();
  window.onresize = updateSize;
}

async function renderDone(
  root: HTMLElement,
  session: string,
  showError: (e: unknown) => void,
): Promise<void> {
  const heading = el("h2");
  heading.textContent = t("results.title");
  const where = el("p", "where");
  const open = el("button", "primary");
  open.textContent = t("action.openFolder");
  open.addEventListener("click", () => host.openFolder(session).catch(showError));
  const send = el("p");
  send.textContent = t("results.sendHint");
  const summary = el("pre");
  const back = el("button");
  back.textContent = t("action.back");
  back.addEventListener("click", () => {
    location.href = "index.html";
  });
  root.append(heading, where, open, send, summary, back);
  try {
    const path = await host.sessionPath(session);
    where.textContent = t("results.savedIn", { path });
    const parsed = parseSummary(await host.readText(session, SUMMARY_FILE));
    summary.textContent =
      parsed === null ? t("results.none") : summaryLines(parsed).join("\n");
  } catch (e) {
    showError(e);
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app") ?? document.body;
  document.documentElement.lang = i18n.locale;
  const params = new URLSearchParams(location.search);
  const done = params.get("done") === "1" ? params.get("session") : null;
  const settings = await host.settings();
  render(root, settings, done);
  i18n.subscribe(() => render(root, settings, done));

  if (done === null && settings.autorun !== null) {
    const engines = settings.autorun === "all" ? ENGINE_IDS : [settings.autorun];
    if (engines.every(isEngineId) && windowFits()) await start(engines);
  } else if (done !== null && settings.exitWhenDone) {
    setTimeout(() => void host.exitApp(0), 2000);
  }
}

void main();
