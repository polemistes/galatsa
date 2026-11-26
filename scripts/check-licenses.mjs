// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the license of every installed dependency (production and development,
// including their transitive dependencies) against an allowlist of licenses that
// can be combined with code licensed under GPL-3.0-or-later.
//
// Usage: node scripts/check-licenses.mjs
// Exits with 1 if any dependency has a license that is not on the allowlist,
// or has no license at all.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";

// The package is CommonJS, so it is loaded with require.
const checker = createRequire(import.meta.url)("license-checker-rseidelsohn");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Licenses that are accepted. Reasoning for each group:
//
// Permissive (compatible with GPL-3.0-or-later in both directions for combined works):
//   MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0
// Permissive with patent grant, one-way compatible with GPL-3.0 (Apache-2.0 is
//   explicitly listed by the FSF as compatible with GPLv3):
//   Apache-2.0
// Weak copyleft, file-level or library-level (MPL-2.0 has a Secondary License clause
//   that allows combination with GPL-3.0; LGPL is designed to be linked by GPL code):
//   MPL-2.0, LGPL-2.0/2.1/3.0 (only and or-later variants)
// GPL-3.0 family, same license as this project:
//   GPL-3.0-only, GPL-3.0-or-later
// Creative Commons attribution licenses. Only used by data-only packages (such as the
// SPDX exception list), never for code. Attribution-only, so they do not restrict use:
//   CC-BY-4.0, CC-BY-3.0
//
// Deliberately NOT accepted, and reviewed by hand before they are added here:
//   GPL-2.0-only (incompatible with GPL-3.0), GPL-2.0-or-later (usable only if we choose
//   GPL-3.0 for it, so it needs a manual decision), AGPL-*, SSPL-*, BUSL-*, any
//   CC-BY-NC-* or other non-commercial license, proprietary licenses, "SEE LICENSE IN",
//   UNLICENSED, UNKNOWN, and missing licenses.
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Apache-2.0",
  "MPL-2.0",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "CC-BY-4.0",
  "CC-BY-3.0",
]);

// Workspace packages (the root and packages under packages/ and apps/) are our own
// code and carry the project license. They live outside node_modules.
const isWorkspacePackage = (name, path) =>
  name.startsWith("@galatsa/") ||
  name.startsWith("galatsa@") ||
  !path.includes(`${sep}node_modules${sep}`);

/**
 * Evaluates an SPDX-like license expression against the allowlist.
 * Supports parentheses, AND and OR, and "X WITH Y" (the exception is ignored,
 * the base license is checked). OR is satisfied if one side is allowed,
 * AND needs both sides. Anything that cannot be parsed is not allowed.
 */
export function isAllowedExpression(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let result = parseAnd();
    while (peek() === "OR") {
      next();
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }

  function parseAnd() {
    let result = parseAtom();
    while (peek() === "AND") {
      next();
      const right = parseAtom();
      result = result && right;
    }
    return result;
  }

  function parseAtom() {
    const token = next();
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new Error("missing )");
      return inner;
    }
    if (token === "WITH") throw new Error("unexpected WITH");
    if (peek() === "WITH") {
      next();
      next(); // exception identifier, ignored
    }
    return ALLOWED.has(token);
  }

  try {
    const result = parseOr();
    if (pos !== tokens.length) return false;
    return result;
  } catch {
    return false;
  }
}

function licenseOf(info) {
  const value = info.licenses;
  if (Array.isArray(value)) {
    // Several licenses listed without a choice between them: all of them must be allowed.
    return {
      text: value.join(" AND "),
      allowed: value.length > 0 && value.every(isAllowedExpression),
    };
  }
  const text = String(value ?? "UNKNOWN");
  return { text, allowed: isAllowedExpression(text) };
}

function collect(start) {
  return new Promise((resolve, reject) => {
    checker.init({ start, json: true }, (error, packages) => {
      if (error) reject(error);
      else resolve(packages);
    });
  });
}

async function main() {
  const packages = await collect(root);
  const violations = [];
  let checked = 0;

  for (const [id, info] of Object.entries(packages)) {
    if (isWorkspacePackage(id, info.path ?? "")) continue;
    checked += 1;
    const { text, allowed } = licenseOf(info);
    if (!allowed) violations.push({ id, text });
  }

  if (violations.length > 0) {
    console.error(
      `License check failed: ${violations.length} dependenc${violations.length === 1 ? "y has" : "ies have"} a license that is not on the allowlist.`,
    );
    for (const { id, text } of violations) {
      console.error(`  - ${id}: ${text}`);
    }
    console.error("");
    console.error("Allowed licenses are listed in scripts/check-licenses.mjs.");
    console.error(
      "Remove the dependency, or review the license and add it to the allowlist with a reason.",
    );
    process.exit(1);
  }

  console.log(
    `License check passed: ${checked} third-party packages checked against GPL-3.0-or-later.`,
  );
}

// Only run the check when executed directly, so the expression evaluator can be imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("License check could not run:", error);
    process.exit(1);
  });
}
