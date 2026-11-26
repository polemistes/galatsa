// SPDX-License-Identifier: GPL-3.0-or-later

// Checks that every source file in the repository carries the SPDX license header:
// AGPL-3.0-or-later under packages/server, GPL-3.0-or-later everywhere else. The files are listed with git, so ignored files (node_modules, dist, and
// agent worktrees under .claude/) are skipped, and no list of exclusions is needed.
// Rules for each file type are in scripts/lib/spdx.ts.
//
// Usage: node scripts/check-spdx.ts   (or `pnpm check:spdx`)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedHeader, hasSpdxHeader, needsHeader } from "./lib/spdx.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked files plus untracked files that git does not ignore. */
function listFiles(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    console.error("SPDX check needs a git checkout, because it lists files with git.");
    console.error(result.stderr || String(result.error ?? ""));
    process.exit(1);
  }
  // git always writes forward slashes, also on Windows. Deleted tracked files are
  // still listed under --cached, so only existing files are read below.
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

function main(): void {
  const candidates = listFiles().filter(needsHeader);
  const missing: string[] = [];
  let checked = 0;

  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // tracked but deleted in the working tree
    }
    checked += 1;
    if (!hasSpdxHeader(file, content)) missing.push(file);
  }

  if (checked === 0) {
    console.error("SPDX check found no source files. Is this a git checkout?");
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `SPDX check failed: ${missing.length} file(s) do not start with the license header:`,
    );
    for (const file of missing) {
      console.error(`  - ${file}`);
      console.error(`      expected first line: ${expectedHeader(file)}`);
    }
    process.exit(1);
  }

  console.log(`SPDX check passed: ${checked} source files have the license header.`);
}

main();
