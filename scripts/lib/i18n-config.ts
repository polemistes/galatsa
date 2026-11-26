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
// uiFiles        Globs (relative to the package) of user interface code; a glob
//                starting with "!" leaves files out ("!src/model/**"). [] turns
//                the hard-coded text check off for the package. Default: see
//                defaultUiFiles below.
// messages       Folder with the message files. Default: src/messages. The message
//                files are exactly <messages>/<language>.ts for each interface
//                language (LOCALES in @galatsa/i18n); other files in the folder,
//                such as index.ts or helpers, are not catalogs.
// textAttributes More JSX attribute names whose value is shown to users.
// textCalls      More function names whose first argument is shown to users.
//
// Default user interface code:
//   - In a user interface package, every script under src/, every .tsx and .jsx
//     file and every HTML page. A package is a user interface package if it has a
//     .tsx or .jsx file (other than tests) or declares @galatsa/i18n as a
//     dependency: code that shows translated text is code that shows text.
//   - In any other package, every .tsx and .jsx file and every HTML page.
//
// Test files (*.test.*, *.spec.*), declaration files (*.d.ts) and the message files
// themselves are never treated as user interface code.

import { posix } from "node:path";

export interface I18nConfig {
  /** Globs of user interface code; "!" globs leave files out. */
  readonly uiFiles: readonly string[];
  readonly messages: string;
  /** True if the package set "messages" itself, so the folder must exist. */
  readonly messagesExplicit: boolean;
  readonly textAttributes: readonly string[];
  readonly textCalls: readonly string[];
}

/** Default user interface code in a package that is not a user interface package. */
export const DEFAULT_UI_FILES: readonly string[] = [
  "**/*.tsx",
  "**/*.jsx",
  "**/*.html",
  "**/*.htm",
];

/** Default user interface code in a user interface package. */
export const UI_PACKAGE_UI_FILES: readonly string[] = ["src/**", ...DEFAULT_UI_FILES];

/** The package whose dependents count as user interface packages. */
export const I18N_PACKAGE = "@galatsa/i18n";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
export const DEFAULT_MESSAGES = "src/messages";

const KNOWN_KEYS = ["uiFiles", "messages", "textAttributes", "textCalls"];

/** Package folders whose code may reach users: libraries, extensions and apps. */
export const UI_PACKAGE_PATTERN =
  /^(?:packages\/extensions\/[^/]+|packages\/[^/]+|apps\/[^/]+)$/;

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const HTML_FILE = /\.html?$/i;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const JSX_FILE = /\.[jt]sx$/;

export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

export function isHtmlFile(path: string): boolean {
  return HTML_FILE.test(path);
}

/**
 * True if a package shows text: it has a .tsx or .jsx file (other than tests), or
 * it declares @galatsa/i18n as a dependency. `files` are relative to the package.
 */
export function isUiPackage(manifest: unknown, files: readonly string[]): boolean {
  if (files.some((file) => JSX_FILE.test(file) && !isTestFile(file))) return true;
  const record = (manifest ?? {}) as Record<string, unknown>;
  if (record["name"] === I18N_PACKAGE) return false;
  return DEPENDENCY_FIELDS.some((field) => {
    const deps = record[field];
    return deps !== null && typeof deps === "object" && Object.hasOwn(deps, I18N_PACKAGE);
  });
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/**
 * Reads the configuration from a package.json object. `files` (relative to the
 * package) decide the default uiFiles, see isUiPackage. Problems are listed, not
 * thrown.
 */
export function readI18nConfig(
  manifest: unknown,
  files: readonly string[] = [],
): {
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
      uiFiles: list(
        "uiFiles",
        isUiPackage(manifest, files) ? UI_PACKAGE_UI_FILES : DEFAULT_UI_FILES,
      ),
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
  if (!(isSourceFile(path) || isHtmlFile(path)) || isTestFile(path)) return false;
  if (path.startsWith(`${config.messages}/`)) return false;
  const include = config.uiFiles.filter((pattern) => !pattern.startsWith("!"));
  const exclude = config.uiFiles
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    include.some((pattern) => posix.matchesGlob(path, pattern)) &&
    !exclude.some((pattern) => posix.matchesGlob(path, pattern))
  );
}

/**
 * The message files of a package, from a list of package-relative paths: language
 * to path, for each interface language whose <messages>/<language>.ts exists.
 * Nothing else counts, so a helper such as messages/ids.ts is never a catalog.
 */
export function messageFiles(
  paths: readonly string[],
  config: I18nConfig,
  locales: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const locale of locales) {
    const path = `${config.messages}/${locale}.ts`;
    if (paths.includes(path)) found.set(locale, path);
  }
  return found;
}
