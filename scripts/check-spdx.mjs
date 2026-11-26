// SPDX-License-Identifier: GPL-3.0-or-later

// Checks that every JavaScript and TypeScript source file in the repository starts
// with the SPDX license header for GPL-3.0-or-later. Config files are checked too:
// there is no exclusion list, so no file has to be added to one.
//
// Usage: node scripts/check-spdx.mjs
// Exits with 1 and lists the files that lack the header.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER = "// SPDX-License-Identifier: GPL-3.0-or-later";
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
// Directories that hold installed or generated files, never our sources.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "target",
  ".git",
  ".vite",
]);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name));
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

const missing = [];
let checked = 0;
for (const file of sourceFiles(root)) {
  checked += 1;
  const firstLine = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
  if (firstLine !== HEADER) missing.push(relative(root, file));
}

if (missing.length > 0) {
  console.error(`SPDX check failed: ${missing.length} file(s) do not start with:`);
  console.error(`  ${HEADER}`);
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(1);
}

console.log(`SPDX check passed: ${checked} source files have the license header.`);
