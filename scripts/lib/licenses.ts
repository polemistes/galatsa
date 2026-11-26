// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the dependency license check. The CLI in scripts/check-licenses.ts
// collects the data, this module decides whether it is acceptable.
//
// Two policies, chosen by how a dependency is used:
//
// - Production: the package is reachable from a `dependencies` or
//   `optionalDependencies` entry of any workspace package. It may end up in the
//   distributed program, so its license must be compatible with GPL-3.0-or-later.
//   A package that is both production and development counts as production.
// - Development: the package is reachable only from `devDependencies`. It is not
//   shipped, so any free (open-source) license is accepted. Non-free licenses are
//   still rejected: non-commercial and no-derivatives Creative Commons licenses,
//   SSPL, BUSL, Commons Clause, proprietary, and unknown or missing licenses.
//
// IMPORTANT: the license lists below were written from memory. They must be verified
// against the license texts and the SPDX license list in package F0-02 (see
// docs/adr/). Until then, treat every entry as unverified.

/** Licenses accepted for production dependencies. */
export const PRODUCTION_LICENSES: ReadonlySet<string> = new Set([
  // Permissive. Compatible with GPL-3.0-or-later.
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
  "Unicode-3.0",
  "Artistic-2.0",
  // Permissive with a patent grant. One-way compatible with GPL-3.0.
  "Apache-2.0",
  // Attribution-only Creative Commons. Accepted for data, not code.
  "CC-BY-4.0",
  // Weak copyleft. MPL-2.0 has a Secondary License clause for GPL-3.0; LGPL is
  // designed to be linked from GPL code.
  "MPL-2.0",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-2.1",
  "LGPL-2.1+",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "LGPL-3.0",
  "LGPL-3.0+",
  // GPL family. Same family as this project.
  "GPL-2.0-or-later",
  "GPL-2.0+",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "GPL-3.0",
  "GPL-3.0+",
]);

/**
 * Licenses that are free (open source) but may not be shipped in production.
 * Used only for development dependencies. Includes everything in PRODUCTION_LICENSES.
 */
export const DEVELOPMENT_FREE_LICENSES: ReadonlySet<string> = new Set([
  ...PRODUCTION_LICENSES,
  "GPL-2.0-only",
  "GPL-2.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "AGPL-3.0",
  "LGPL-2.0",
  "EPL-1.0",
  "EPL-2.0",
  "CDDL-1.0",
  "CC-BY-3.0",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "PSF-2.0",
  "WTFPL",
  "OFL-1.1",
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
    if (!/^[A-Za-z0-9.+-]+$/.test(token)) throw new Error(`invalid license id: ${token}`);
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

/**
 * Normalises a key from pnpm-lock.yaml to "name@version". Drops peer dependency
 * suffixes such as "(eslint@10.14.0)" and surrounding quotes.
 */
export function normalizeLockKey(key: string): string {
  return key.replace(/^'|'$/g, "").replace(/\(.*$/, "");
}

/**
 * Lockfile entries that are not project dependencies. They are the pnpm program itself,
 * pinned by the "packageManager" field, and its per-platform binaries. pnpm is MIT
 * licensed (checked with `npm view pnpm@12.19.0 license` and `npm view @pnpm/exe license`).
 */
export function isPackageManagerEntry(id: string): boolean {
  return id.startsWith("pnpm@") || id.startsWith("@pnpm/exe.");
}
