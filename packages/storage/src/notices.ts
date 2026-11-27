// SPDX-License-Identifier: GPL-3.0-or-later

// What the storage layer tells the user. Every notice has a code with a message
// in both languages (messages/), and values to fill in. Section 7 of
// docs/adr/0006-storage.md.

import { FileFormatError, type FileWarning } from "@galatsa/format";
import type { I18n, MessageValues } from "@galatsa/i18n";
import { errorKind } from "./backend.ts";
import { storageMessages } from "./messages/index.ts";

export type NoticeCode =
  // A file or a stored document could not be opened.
  | "file-unreadable"
  | "file-not-galatsa"
  | "file-damaged"
  | "file-newer-version"
  | "file-too-large"
  | "file-unsupported"
  | "stored-damaged"
  | "stored-missing"
  | "storage-unavailable"
  // It opened, but something is worth knowing.
  | "restored-previous-copy"
  | "changes-lost"
  | "changes-incomplete"
  | "merge-identity-lost"
  | "file-upgraded"
  | "document-recovered"
  | "content-quarantined"
  | "assets-damaged"
  | "assets-missing"
  // While working and saving.
  | "autosave-failed"
  | "storage-full"
  | "autosave-newer-version"
  | "save-failed"
  | "save-verify-failed"
  | "save-downloaded"
  | "save-download-failed"
  | "save-too-large"
  | "save-newer-version"
  | "save-no-merge-state"
  | "save-without-previews";

export type Severity = "info" | "warning" | "error";

export interface Notice {
  code: NoticeCode;
  severity: Severity;
  /** Values for the message: `count`, `name`, `when` (a timestamp) and so on. */
  values?: MessageValues;
  /** The error behind the notice, for logs. Never shown as it is. */
  cause?: unknown;
}

const SEVERITY: Record<NoticeCode, Severity> = {
  "file-unreadable": "error",
  "file-not-galatsa": "error",
  "file-damaged": "error",
  "file-newer-version": "error",
  "file-too-large": "error",
  "file-unsupported": "error",
  "stored-damaged": "error",
  "stored-missing": "error",
  "storage-unavailable": "error",
  "restored-previous-copy": "warning",
  "changes-lost": "warning",
  "changes-incomplete": "warning",
  "merge-identity-lost": "warning",
  "file-upgraded": "info",
  "document-recovered": "warning",
  "content-quarantined": "info",
  "assets-damaged": "warning",
  "assets-missing": "warning",
  "autosave-failed": "error",
  "storage-full": "error",
  "autosave-newer-version": "error",
  "save-failed": "error",
  "save-verify-failed": "error",
  "save-downloaded": "warning",
  "save-download-failed": "error",
  "save-too-large": "error",
  "save-newer-version": "error",
  "save-no-merge-state": "warning",
  "save-without-previews": "info",
};

export function notice(
  code: NoticeCode,
  values?: MessageValues,
  cause?: unknown,
): Notice {
  const result: Notice = { code, severity: SEVERITY[code] };
  if (values !== undefined) result.values = values;
  if (cause !== undefined) result.cause = cause;
  return result;
}

/** The notice for a file that could not be opened. */
export function openProblem(error: unknown, name?: string): Notice {
  const values = { name: name ?? "" };
  if (error instanceof FileFormatError) {
    switch (error.code) {
      case "not-zip":
      case "not-galatsa":
        return notice("file-not-galatsa", values, error);
      case "damaged":
        return notice("file-damaged", values, error);
      case "newer-version":
        return notice("file-newer-version", values, error);
      case "too-large":
        return notice("file-too-large", values, error);
      case "unsupported":
        return notice("file-unsupported", values, error);
    }
  }
  return notice("file-unreadable", values, error);
}

/** The notice for a failed save to a file. */
export function saveProblem(error: unknown, name?: string, download = false): Notice {
  const values = { name: name ?? "" };
  if (error instanceof FileFormatError) {
    if (error.code === "too-large") return notice("save-too-large", values, error);
    if (error.code === "newer-version")
      return notice("save-newer-version", values, error);
  }
  return notice(download ? "save-download-failed" : "save-failed", values, error);
}

/** The notice for a failed write to the working store. */
export function autosaveProblem(error: unknown): Notice {
  if (error instanceof FileFormatError && error.code === "newer-version") {
    return notice("autosave-newer-version", undefined, error);
  }
  return notice(
    errorKind(error) === "full" ? "storage-full" : "autosave-failed",
    undefined,
    error,
  );
}

/**
 * Notices for the warnings of the file reader and writer, one per kind.
 * Warnings that say nothing a user can act on are left out.
 */
export function fileNotices(warnings: readonly FileWarning[]): Notice[] {
  const counts = new Map<string, number>();
  for (const warning of warnings)
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  const out: Notice[] = [];
  const has = (code: FileWarning["code"]) => counts.has(code);
  if (has("migrated")) out.push(notice("file-upgraded"));
  if (has("ydoc-discarded") || has("migrated")) out.push(notice("merge-identity-lost"));
  if (has("document-recovered")) out.push(notice("document-recovered"));
  if (has("content-quarantined")) out.push(notice("content-quarantined"));
  if (has("asset-damaged")) {
    out.push(notice("assets-damaged", { count: counts.get("asset-damaged")! }));
  }
  if (has("asset-missing")) {
    out.push(notice("assets-missing", { count: counts.get("asset-missing")! }));
  }
  if (has("ydoc-not-written")) out.push(notice("save-no-merge-state"));
  if (has("previews-not-written")) out.push(notice("save-without-previews"));
  return out;
}

/** The text of a notice in the current language. */
export function noticeText(i18n: I18n, item: Notice): string {
  const t = i18n.translator(storageMessages);
  const values: MessageValues = { count: 0, name: "", when: 0, ...item.values };
  return t(`notice.${item.code}`, values);
}
