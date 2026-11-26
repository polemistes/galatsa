// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the dependency license check. The CLI in scripts/check-licenses.ts
// collects the data, this module decides whether it is acceptable.
//
// Two policies, chosen by how a dependency is used:
//
// - Production: the package is reachable from any dependency field of any workspace
//   package other than the root (see scripts/lib/lockfile.ts for the exact rule). It
//   may end up in the distributed program, so its license must be compatible with
//   GPL-3.0-or-later. A package that is both production and development counts as
//   production.
// - Development: the package is reachable only from the root's `devDependencies`
//   (repository tooling). It is not shipped, so any free (open-source) license is
//   accepted. Non-free licenses are still rejected: non-commercial and
//   no-derivatives Creative Commons licenses, SSPL, BUSL, Commons Clause,
//   proprietary, and unknown or missing licenses.
//
// Sources: every entry in PRODUCTION_LICENSES and DEVELOPMENT_FREE_LICENSES, and the
// WITH exceptions, were checked against the FSF license list, the GPL FAQ, the SPDX
// license list and Fedora's list of allowed licenses. The findings, with links, are
// in docs/adr/0002-kontroll-av-forutsetninger.md (part 2, and the corrections in
// part 7). The comments below give the short reason for each group. NON_FREE_PATTERN
// is a safety net that only rejects; it is not part of that review.
//
// Still unconfirmed: whether BlueOak-1.0.0 is compatible with GPL-3.0. Until a source
// confirms it, it is accepted for development only.

/** Licenses accepted for production dependencies. */
export const PRODUCTION_LICENSES: ReadonlySet<string> = new Set([
  // Permissive. Compatible with GPL-3.0-or-later according to the FSF license list
  // (https://www.gnu.org/licenses/license-list.html). CC0-1.0 gives no patent
  // license, and the FSF advises against it for software, but it is compatible.
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
  "Artistic-2.0",
  "X11",
  "BSL-1.0",
  "WTFPL",
  // Unicode data files license. The FSF lists both as compatible; that its older
  // entry covers exactly the 2016 version is a judgment.
  "Unicode-3.0",
  "Unicode-DFS-2016",
  // The SPDX id Python-2.0 is the overall Python license (PSF license plus the older
  // BeOpen, CNRI and CWI terms, https://spdx.org/licenses/Python-2.0.html). The FSF
  // calls the license of "Python 2.0.1, 2.1.1, and newer versions" compatible
  // (https://www.gnu.org/licenses/license-list.html#Python); the license of Python
  // 1.6b1 to 2.0 and 2.1 is not, but that is a different license despite the name.
  // PSF-2.0 alone stays on the development list on purpose: the FSF statement is
  // about the overall Python license, not about the PSF part by itself.
  "Python-2.0",
  // Permissive with a patent grant. Compatible with GPL-3.0, not with GPL-2.0-only.
  "Apache-2.0",
  // Attribution-only Creative Commons. Compatible, but accepted for data, not code:
  // the FSF advises against Creative Commons licenses for software.
  "CC-BY-4.0",
  // Compatible through the Secondary License clause (section 3.3), except for files
  // marked "Incompatible With Secondary Licenses" (Exhibit B). This check cannot see
  // that notice, so review every MPL-2.0 production package by hand. Checked:
  // lightningcss 1.33.0 (all platform packages) has no such notice.
  "MPL-2.0",
  // LGPL 2.0 can be converted to the ordinary GPL, version 2 or later, by its section 3
  // (https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html).
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.0",
  "LGPL-2.0+",
  // LGPL 2.1 allows relicensing under any version of the GPL since 2 (GPL FAQ).
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-2.1",
  "LGPL-2.1+",
  // LGPL 3.0 is compatible with GPL-3.0.
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "LGPL-3.0",
  "LGPL-3.0+",
  // GPL family. "Version 2 or later" includes version 3.
  "GPL-2.0-or-later",
  "GPL-2.0+",
  // GPL-3.0-only code can be combined with this project, but while such code is
  // included, the whole program can in practice only be distributed under GPL
  // version 3, not a later version.
  "GPL-3.0-only",
  "GPL-3.0",
  "GPL-3.0-or-later",
  "GPL-3.0+",
]);

/**
 * Licenses that are free (open source) but may not be shipped in production.
 * Used only for development dependencies. Includes everything in PRODUCTION_LICENSES.
 */
export const DEVELOPMENT_FREE_LICENSES: ReadonlySet<string> = new Set([
  ...PRODUCTION_LICENSES,
  // Free according to the SPDX list (OSI approved or FSF free), but not compatible
  // with GPL-3.0, or (AGPL) only as separate modules.
  "GPL-2.0-only",
  "GPL-2.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "AGPL-3.0",
  "EPL-1.0",
  "EPL-2.0",
  "CDDL-1.0",
  "CC-BY-SA-4.0",
  // Free (OSI, FSF); the FSF says nothing about GPL compatibility. Fonts shipped
  // with the program need their own decision.
  "OFL-1.1",
  // Free (OSI, Fedora); GPL compatibility is unconfirmed (see the note at the top).
  "BlueOak-1.0.0",
  // Free according to Fedora's list of allowed licenses
  // (https://docs.fedoraproject.org/en-US/legal/allowed-licenses/); neither OSI nor
  // FSF in the SPDX list.
  "CC-BY-3.0",
  "CC-BY-SA-3.0",
  "PSF-2.0",
]);

/** Exceptions accepted after WITH, for example "GPL-3.0-only WITH GCC-exception-3.1". */
export const ACCEPTED_EXCEPTIONS: ReadonlySet<string> = new Set([
  "Classpath-exception-2.0",
  "LLVM-exception",
  "GCC-exception-3.1",
]);

/**
 * Patterns that mark a license as non-free whatever else the expression says.
 * They are checked on the whole expression before parsing.
 */
const NON_FREE_PATTERN =
  /\b(NC|ND)\b|SSPL|BUSL|Commons-Clause|Proprietary|Custom|UNLICENSED|UNKNOWN|SEE LICENSE/i;

/** Operator words. They are never valid as a license id or exception id. */
const OPERATORS: ReadonlySet<string> = new Set(["AND", "OR", "WITH"]);

/**
 * Evaluates an SPDX-style license expression against a predicate for single license ids.
 *
 * Supports parentheses, AND and OR (AND binds tighter than OR), and "ID WITH EXCEPTION".
 * The exception must be in ACCEPTED_EXCEPTIONS. An expression that cannot be parsed,
 * or that contains a non-free marker, is never allowed.
 */
export function evaluateLicense(
  expression: string,
  isAllowedId: (id: string) => boolean,
): boolean {
  if (NON_FREE_PATTERN.test(expression)) return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  if (tokens.length === 0) return false;
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const token = tokens[pos];
    if (token === undefined) throw new Error("unexpected end of expression");
    pos += 1;
    return token;
  };

  function parseOr(): boolean {
    let result = parseAnd();
    while (peek() === "OR") {
      next();
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }

  function parseAnd(): boolean {
    let result = parseAtom();
    while (peek() === "AND") {
      next();
      const right = parseAtom();
      result = result && right;
    }
    return result;
  }

  function parseAtom(): boolean {
    const token = next();
    if (token === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new Error("missing closing parenthesis");
      return inner;
    }
    if (!/^[A-Za-z0-9.+-]+$/.test(token) || OPERATORS.has(token)) {
      throw new Error(`invalid license id: ${token}`);
    }
    const allowed = isAllowedId(token);
    if (peek() === "WITH") {
      next();
      const exception = next();
      if (!ACCEPTED_EXCEPTIONS.has(exception)) {
        throw new Error(`exception not accepted: ${exception}`);
      }
    }
    return allowed;
  }

  try {
    const result = parseOr();
    if (pos !== tokens.length) return false;
    return result;
  } catch {
    return false;
  }
}

export type Policy = "production" | "development";

/** Returns true if the expression is acceptable under the given policy. */
export function isAcceptable(expression: string, policy: Policy): boolean {
  const allowed =
    policy === "production" ? PRODUCTION_LICENSES : DEVELOPMENT_FREE_LICENSES;
  return evaluateLicense(expression, (id) => allowed.has(id));
}

/** One installed package, as reported by `pnpm licenses list`. */
export interface PackageLicense {
  /** Package name and version, for example "rolldown@1.2.19". */
  readonly id: string;
  /** The license expression as reported, for example "MIT" or "(MIT AND CC-BY-3.0)". */
  readonly license: string;
  /** True if the package is reachable from a production dependency of any workspace package. */
  readonly production: boolean;
}

export interface Violation {
  readonly id: string;
  readonly license: string;
  readonly policy: Policy;
}

/** Returns the packages whose license is not acceptable under their own policy. */
export function findViolations(packages: readonly PackageLicense[]): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of packages) {
    const policy: Policy = pkg.production ? "production" : "development";
    if (!isAcceptable(pkg.license, policy)) {
      violations.push({ id: pkg.id, license: pkg.license, policy });
    }
  }
  return violations;
}

/** Shape of the JSON from `pnpm licenses list --json`: license -> packages with that license. */
export type LicenseReport = Record<
  string,
  ReadonlyArray<{ name: string; versions: readonly string[] }>
>;

/** Flattens a pnpm license report into "name@version" ids with their license. */
export function flattenReport(
  report: LicenseReport,
): Array<{ id: string; license: string }> {
  const result: Array<{ id: string; license: string }> = [];
  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      for (const version of entry.versions) {
        result.push({ id: `${entry.name}@${version}`, license });
      }
    }
  }
  return result;
}
