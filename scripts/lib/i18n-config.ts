// SPDX-License-Identifier: GPL-3.0-or-later

// Which files of a workspace package the translation check treats as user interface
// code, and where the package keeps its message files. A package can change the
// defaults in its package.json:
//
//   "galatsa": {
//     "i18n": {
//       "uiFiles": ["src/**/*.tsx", "src/dom/**/*.ts"],
//       "messages": "src/messages",
//       "textAttributes": ["emptyText"],
//       "textCalls": ["showToast"]
//     }
//   }
//
// uiFiles        Globs (relative to the package) of user interface code. Default:
//                every .tsx and .jsx file. A package without React that builds its
//                interface with the DOM (the player) lists its .ts files here.
//                [] turns the hard-coded text check off for the package.
// messages       Folder with the message files <language>.ts. Default: src/messages.
// textAttributes More JSX attribute names whose value is shown to users.
// textCalls      More function names whose first argument is shown to users.
//
// Test files (*.test.*, *.spec.*) and the message files themselves are never treated
// as user interface code.

import { posix } from "node:path";

export interface I18nConfig {
  readonly uiFiles: readonly string[];
  readonly messages: string;
  /** True if the package set "messages" itself, so the folder must exist. */
  readonly messagesExplicit: boolean;
  readonly textAttributes: readonly string[];
  readonly textCalls: readonly string[];
}

export const DEFAULT_UI_FILES: readonly string[] = ["**/*.tsx", "**/*.jsx"];
export const DEFAULT_MESSAGES = "src/messages";

const KNOWN_KEYS = ["uiFiles", "messages", "textAttributes", "textCalls"];

/** Package folders whose code may reach users: libraries, extensions and apps. */
export const UI_PACKAGE_PATTERN =
  /^(?:packages\/extensions\/[^/]+|packages\/[^/]+|apps\/[^/]+)$/;

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path) && !path.endsWith(".d.ts");
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/** Reads the configuration from a package.json object. Problems are listed, not thrown. */
export function readI18nConfig(manifest: unknown): {
  config: I18nConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const galatsa = (manifest as { galatsa?: unknown } | null)?.galatsa;
  const raw = (galatsa as { i18n?: unknown } | undefined)?.i18n;
  const section: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (raw !== undefined && section !== raw)
    problems.push('"galatsa.i18n" must be an object');

  for (const key of Object.keys(section)) {
    if (!KNOWN_KEYS.includes(key)) {
      problems.push(
        `"galatsa.i18n.${key}" is not a known setting (${KNOWN_KEYS.join(", ")})`,
      );
    }
  }

  const list = (key: string, fallback: readonly string[]): readonly string[] => {
    if (section[key] === undefined) return fallback;
    const value = stringList(section[key]);
    if (value === undefined)
      problems.push(`"galatsa.i18n.${key}" must be a list of strings`);
    return value ?? fallback;
  };

  let messages = DEFAULT_MESSAGES;
  if (section["messages"] !== undefined) {
    if (typeof section["messages"] === "string" && section["messages"].length > 0) {
      messages = posix.normalize(section["messages"]).replace(/\/$/, "");
    } else {
      problems.push('"galatsa.i18n.messages" must be a folder path');
    }
  }

  return {
    config: {
      uiFiles: list("uiFiles", DEFAULT_UI_FILES),
      messages,
      messagesExplicit: section["messages"] !== undefined,
      textAttributes: list("textAttributes", []),
      textCalls: list("textCalls", []),
    },
    problems,
  };
}

/** True if a file (relative to its package) is user interface code. */
export function isUiFile(path: string, config: I18nConfig): boolean {
  if (!isSourceFile(path) || isTestFile(path)) return false;
  if (path.startsWith(`${config.messages}/`)) return false;
  return config.uiFiles.some((pattern) => posix.matchesGlob(path, pattern));
}

/**
 * Message files in the messages folder, from a list of package-relative paths:
 * language code to path. "index.ts" and files in subfolders are not message files.
 */
export function messageFiles(
  paths: readonly string[],
  config: I18nConfig,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths) {
    if (posix.dirname(path) !== config.messages) continue;
    const match = /^([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\.ts$/.exec(posix.basename(path));
    if (match?.[1] !== undefined && !isTestFile(path)) found.set(match[1], path);
  }
  return found;
}
