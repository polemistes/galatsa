// SPDX-License-Identifier: GPL-3.0-or-later

// Translation check, run by `pnpm check`:
//
//   1. No hard-coded user-visible text in user interface code
//      (rules in scripts/lib/i18n-hardcoded.ts, which files count as user interface
//      code in scripts/lib/i18n-config.ts).
//   2. The message files of every package agree: Norwegian Bokmål and English have
//      the same keys, the same values per key, valid syntax, and the plural
//      categories of their language (checkCatalogs in @galatsa/i18n).
//   3. No catalog is written inline in defineMessages(), where (2) cannot see it.
//
// Files are listed with git, so ignored files are skipped.
//
// Usage: node --conditions=@galatsa/source scripts/check-i18n.ts   (or `pnpm check:i18n`)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCatalogs } from "@galatsa/i18n";
import {
  isSourceFile,
  isTestFile,
  isUiFile,
  messageFiles,
  readI18nConfig,
  UI_PACKAGE_PATTERN,
} from "./lib/i18n-config.ts";
import {
  findHardcodedText,
  findInlineCatalogs,
  type Finding,
} from "./lib/i18n-hardcoded.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked files plus untracked files that git does not ignore. */
function listFiles(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    console.error(
      "Translation check needs a git checkout, because it lists files with git.",
    );
    console.error(result.stderr || String(result.error ?? ""));
    process.exit(1);
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

function read(path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined; // tracked but deleted in the working tree
  }
}

async function main(): Promise<void> {
  const files = listFiles();
  const packages = files
    .filter((file) => posix.basename(file) === "package.json")
    .map((file) => posix.dirname(file))
    .filter((dir) => UI_PACKAGE_PATTERN.test(dir))
    .sort((a, b) => b.length - a.length); // nested packages first

  const filesOf = new Map<string, string[]>(packages.map((dir) => [dir, []]));
  for (const file of files) {
    const owner = packages.find((dir) => file.startsWith(`${dir}/`));
    if (owner !== undefined) filesOf.get(owner)?.push(file.slice(owner.length + 1));
  }

  const problems: string[] = [];
  const add = (path: string, finding: Finding): void => {
    problems.push(
      `${path}:${finding.line}:${finding.column}: ${finding.reason}: "${finding.text}"`,
    );
  };
  let uiFileCount = 0;
  let catalogCount = 0;

  for (const dir of [...packages].sort()) {
    const manifestText = read(`${dir}/package.json`);
    if (manifestText === undefined) continue;
    const { config, problems: configProblems } = readI18nConfig(JSON.parse(manifestText));
    for (const problem of configProblems)
      problems.push(`${dir}/package.json: ${problem}`);
    const packageFiles = filesOf.get(dir) ?? [];

    for (const file of packageFiles) {
      if (!isSourceFile(file) || isTestFile(file)) continue;
      const path = `${dir}/${file}`;
      const source = read(path);
      if (source === undefined) continue;
      if (isUiFile(file, config)) {
        uiFileCount += 1;
        const findings = findHardcodedText(path, source, config);
        for (const finding of findings) add(path, finding);
      }
      for (const finding of findInlineCatalogs(path, source)) add(path, finding);
    }

    const catalogs = messageFiles(packageFiles, config);
    if (catalogs.size === 0) {
      if (config.messagesExplicit) {
        problems.push(`${dir}: no message files (<language>.ts) in ${config.messages}`);
      }
      continue;
    }
    catalogCount += 1;
    const loaded: Record<string, unknown> = {};
    for (const [language, file] of catalogs) {
      const path = `${dir}/${file}`;
      try {
        const module = (await import(pathToFileURL(join(root, path)).href)) as {
          default?: unknown;
        };
        loaded[language] = module.default;
      } catch (error) {
        problems.push(`${path}: could not be loaded: ${String(error)}`);
      }
    }
    for (const problem of checkCatalogs(loaded)) {
      problems.push(`${dir}/${config.messages}: ${problem}`);
    }
  }

  if (problems.length > 0) {
    console.error(`Translation check failed: ${problems.length} problem(s).`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "User-visible text belongs in the message files (src/messages/nb.ts and en.ts).",
    );
    console.error(
      "Text that must not be translated can be marked with a comment: i18n-ignore: <reason>",
    );
    process.exit(1);
  }

  console.log(
    `Translation check passed: ${uiFileCount} user interface file(s) without hard-coded text, ` +
      `${catalogCount} message folder(s) with matching nb and en catalogs.`,
  );
}

await main();
