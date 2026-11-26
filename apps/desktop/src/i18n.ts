// SPDX-License-Identifier: GPL-3.0-or-later

import { browserLocaleStorage, createI18n, type Locale } from "@galatsa/i18n";
import { desktopMessages } from "./messages/index.ts";
import type { EngineId } from "./plan.ts";
import type { SessionSummary } from "./summary.ts";

export const i18n = createI18n({
  dev: import.meta.env.DEV,
  storage: browserLocaleStorage(),
});
export const t = i18n.translator(desktopMessages);

export function engineName(id: EngineId): string {
  return t(`engine.${id}`);
}

function verdict(pass: boolean | null): string {
  return pass === null
    ? t("verdict.unknown")
    : pass
      ? t("verdict.pass")
      : t("verdict.fail");
}

function megabytes(bytes: number | null): string {
  return bytes === null
    ? t("memory.unknown")
    : `${i18n.formatNumber(bytes / 2 ** 20, { maximumFractionDigits: 0 })} MiB`;
}

/** The summary as text lines in the current language (summary.txt and the screen). */
export function summaryLines(summary: SessionSummary): string[] {
  const lines = [t("summary.header", { session: summary.session })];
  const h = summary.host;
  if (h !== null) {
    lines.push(
      t("summary.machine", {
        os: h.osLongVersion ?? h.os,
        cpu: h.cpu ?? "?",
        webview: h.webview.engine,
        version: h.webview.version ?? "?",
      }),
    );
  }
  for (const e of summary.engines) {
    lines.push("", t("summary.engine", { engine: engineName(e.engine) }));
    for (const r of e.runs) {
      lines.push(
        t("summary.run", {
          run: r.run,
          kind: t(`run.kind.${r.mode}`),
          hz: i18n.formatNumber(r.refreshRateHz, { maximumFractionDigits: 0 }),
          f16: verdict(r.frames16_7.pass),
          f33: verdict(r.frames33.pass),
          stalls: verdict(r.stalls.pass),
          text: verdict(r.textSharp.pass),
          memory: megabytes(r.memory.peakBytes),
          memoryVerdict: verdict(r.memory.pass),
        }),
      );
      if (!r.valid) {
        lines.push(
          t("summary.notValid", { run: r.run, problems: r.problems.join("; ") }),
        );
      }
      for (const problem of r.memoryProblems) {
        lines.push(t("summary.memoryProblem", { problem }));
      }
    }
    if (e.runs.length > 0) {
      const agree =
        e.timingRunsAgree === null ? "other" : e.timingRunsAgree ? "yes" : "no";
      lines.push(t("summary.agree", { agree }));
    }
    if (e.error !== null) lines.push(t("summary.error", { message: e.error }));
  }
  return lines;
}

export function setLocale(locale: Locale): void {
  i18n.setLocale(locale);
  document.documentElement.lang = locale;
}
