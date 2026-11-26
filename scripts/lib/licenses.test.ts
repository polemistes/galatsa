// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  evaluateLicense,
  findViolations,
  flattenReport,
  isAcceptable,
  findWorkspaceViolations,
  hasConfigDependencies,
  lockfilePackageIds,
  normalizeLockKey,
  type PackageLicense,
} from "./licenses.ts";

const onlyMit = (id: string): boolean => id === "MIT";

describe("evaluateLicense", () => {
  it("accepts a single allowed id and rejects others", () => {
    expect(evaluateLicense("MIT", onlyMit)).toBe(true);
    expect(evaluateLicense("GPL-2.0-only", onlyMit)).toBe(false);
  });

  it("applies OR: one allowed side is enough", () => {
    expect(evaluateLicense("MIT OR GPL-2.0-only", onlyMit)).toBe(true);
    expect(evaluateLicense("GPL-2.0-only OR MIT", onlyMit)).toBe(true);
    expect(evaluateLicense("GPL-2.0-only OR Apache-2.0", onlyMit)).toBe(false);
  });

  it("applies AND: both sides must be allowed", () => {
    expect(evaluateLicense("MIT AND MIT", onlyMit)).toBe(true);
    expect(evaluateLicense("MIT AND GPL-2.0-only", onlyMit)).toBe(false);
  });

  it("gives AND a higher precedence than OR", () => {
    // Reads as "GPL-2.0-only OR (MIT AND MIT)", which is acceptable.
    expect(evaluateLicense("GPL-2.0-only OR MIT AND MIT", onlyMit)).toBe(true);
    // Reads as "(GPL-2.0-only OR MIT) AND GPL-2.0-only" would be false, so it must not be parsed that way.
    expect(evaluateLicense("MIT AND GPL-2.0-only OR GPL-2.0-only", onlyMit)).toBe(false);
  });

  it("handles parentheses", () => {
    expect(evaluateLicense("(MIT OR GPL-2.0-only) AND MIT", onlyMit)).toBe(true);
    expect(evaluateLicense("(MIT AND GPL-2.0-only) OR GPL-2.0-only", onlyMit)).toBe(
      false,
    );
    expect(evaluateLicense("((MIT))", onlyMit)).toBe(true);
  });

  it("rejects unbalanced parentheses and dangling operators", () => {
    expect(evaluateLicense("(MIT", onlyMit)).toBe(false);
    expect(evaluateLicense("MIT)", onlyMit)).toBe(false);
    expect(evaluateLicense("MIT OR", onlyMit)).toBe(false);
    expect(evaluateLicense("", onlyMit)).toBe(false);
  });

  it("accepts WITH only for an accepted exception and checks the base id", () => {
    expect(evaluateLicense("MIT WITH LLVM-exception", onlyMit)).toBe(true);
    expect(evaluateLicense("GPL-2.0-only WITH Classpath-exception-2.0", onlyMit)).toBe(
      false,
    );
    expect(evaluateLicense("MIT WITH Some-made-up-exception", onlyMit)).toBe(false);
  });

  it("rejects operator words used as license or exception ids", () => {
    const all = (): boolean => true;
    expect(evaluateLicense("MIT OR OR", all)).toBe(false);
    expect(evaluateLicense("MIT AND AND", all)).toBe(false);
    expect(evaluateLicense("OR", all)).toBe(false);
    expect(evaluateLicense("WITH", all)).toBe(false);
    expect(evaluateLicense("MIT OR WITH", all)).toBe(false);
    expect(evaluateLicense("()", all)).toBe(false);
  });

  it("rejects a doubled WITH", () => {
    expect(evaluateLicense("MIT WITH WITH", onlyMit)).toBe(false);
    expect(evaluateLicense("MIT WITH LLVM-exception WITH LLVM-exception", onlyMit)).toBe(
      false,
    );
  });

  it("rejects free-text license strings and non-free markers", () => {
    expect(evaluateLicense("SEE LICENSE IN LICENSE.md", () => true)).toBe(false);
    expect(evaluateLicense("Custom", () => true)).toBe(false);
    expect(evaluateLicense("UNLICENSED", () => true)).toBe(false);
    expect(evaluateLicense("UNKNOWN", () => true)).toBe(false);
    expect(evaluateLicense("CC-BY-NC-4.0", () => true)).toBe(false);
    expect(evaluateLicense("SSPL-1.0", () => true)).toBe(false);
  });
});

describe("license policies", () => {
  it("accepts GPL-3.0-or-later compatible production licenses", () => {
    for (const license of [
      "MIT",
      "Apache-2.0",
      "ISC",
      "MPL-2.0",
      "LGPL-3.0-or-later",
      "Zlib",
      "MIT-0",
      "Unicode-3.0",
      "Artistic-2.0",
      "CC-BY-4.0",
    ]) {
      expect(isAcceptable(license, "production"), license).toBe(true);
    }
  });

  it("accepts the deprecated and + aliases in production", () => {
    for (const license of [
      "GPL-3.0",
      "GPL-3.0+",
      "GPL-2.0+",
      "LGPL-2.0",
      "LGPL-2.1",
      "LGPL-2.1+",
      "LGPL-3.0",
      "LGPL-3.0+",
    ]) {
      expect(isAcceptable(license, "production"), license).toBe(true);
    }
  });

  it("rejects GPL-2.0-only and bare GPL-2.0 in production", () => {
    expect(isAcceptable("GPL-2.0-only", "production")).toBe(false);
    expect(isAcceptable("GPL-2.0", "production")).toBe(false);
  });

  it("rejects CC-BY-3.0 in production, but accepts it in development", () => {
    expect(isAcceptable("CC-BY-3.0", "production")).toBe(false);
    expect(isAcceptable("CC-BY-3.0", "development")).toBe(true);
  });

  it("accepts a dual license in production when one side is compatible", () => {
    expect(isAcceptable("MIT OR GPL-2.0-only", "production")).toBe(true);
    expect(isAcceptable("(MIT AND CC-BY-3.0)", "production")).toBe(false);
    expect(isAcceptable("(MIT AND CC-BY-3.0)", "development")).toBe(true);
  });

  it("accepts GPL-2.0-only, AGPL and EPL in development", () => {
    for (const license of ["GPL-2.0-only", "AGPL-3.0-only", "EPL-2.0"]) {
      expect(isAcceptable(license, "development"), license).toBe(true);
      expect(isAcceptable(license, "production"), license).toBe(false);
    }
  });

  it.each([
    "CC-BY-NC-4.0",
    "CC-BY-NC-SA-4.0",
    "CC-BY-ND-4.0",
    "SSPL-1.0",
    "BUSL-1.1",
    "Commons-Clause",
    "Proprietary",
    "UNKNOWN",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.md",
    "Custom",
  ])("rejects non-free %s under both policies", (license) => {
    expect(isAcceptable(license, "production")).toBe(false);
    expect(isAcceptable(license, "development")).toBe(false);
  });
});

describe("findViolations", () => {
  const pkg = (id: string, license: string, production: boolean): PackageLicense => ({
    id,
    license,
    production,
  });

  it("returns nothing when every package is acceptable", () => {
    expect(
      findViolations([
        pkg("a@1.0.0", "MIT", true),
        pkg("b@1.0.0", "GPL-2.0-only", false),
      ]),
    ).toEqual([]);
  });

  it("names the failed policy for each violation", () => {
    const violations = findViolations([
      pkg("prod-gpl2@1.0.0", "GPL-2.0-only", true),
      pkg("dev-gpl2@1.0.0", "GPL-2.0-only", false),
      pkg("dev-nc@1.0.0", "CC-BY-NC-4.0", false),
    ]);
    expect(violations).toEqual([
      { id: "prod-gpl2@1.0.0", license: "GPL-2.0-only", policy: "production" },
      { id: "dev-nc@1.0.0", license: "CC-BY-NC-4.0", policy: "development" },
    ]);
  });

  it("applies the production policy to a package that is both production and development", () => {
    // The flag marks it as production, so the stricter policy applies.
    expect(findViolations([pkg("both@1.0.0", "CC-BY-3.0", true)])).toHaveLength(1);
  });
});

describe("report helpers", () => {
  it("flattens a pnpm license report, one id per version", () => {
    const flat = flattenReport({
      MIT: [{ name: "a", versions: ["1.0.0", "2.0.0"] }],
      "(MIT AND CC-BY-3.0)": [{ name: "b", versions: ["3.0.0"] }],
    });
    expect(flat).toEqual([
      { id: "a@1.0.0", license: "MIT" },
      { id: "a@2.0.0", license: "MIT" },
      { id: "b@3.0.0", license: "(MIT AND CC-BY-3.0)" },
    ]);
  });

  it("normalises lockfile keys with peer suffixes and quotes", () => {
    expect(normalizeLockKey("'@rolldown/binding-linux-x64-gnu@1.2.19'")).toBe(
      "@rolldown/binding-linux-x64-gnu@1.2.19",
    );
    expect(normalizeLockKey("eslint@10.14.0(supports-color@7.2.0)")).toBe(
      "eslint@10.14.0",
    );
  });

  const twoDocumentLockfile = [
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    "        specifier: 12.19.0",
    "        version: 12.19.0",
    "",
    "packages:",
    "",
    "  '@pnpm/exe.linux-x64@12.19.0':",
    "    resolution: {integrity: sha512-x}",
    "",
    "  pnpm@12.19.0:",
    "    resolution: {integrity: sha512-x}",
    "",
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      vite:",
    "        specifier: 8.3.8",
    "        version: 8.3.8",
    "",
    "packages:",
    "",
    "  '@rolldown/binding-win32-x64-msvc@1.2.19':",
    "    resolution: {integrity: sha512-x}",
    "    cpu: [x64]",
    "    os: [win32]",
    "",
    "  vite@8.3.8:",
    "    resolution: {integrity: sha512-x}",
    "",
    "snapshots:",
    "",
    "  not-a-package@1.0.0: {}",
    "",
  ].join("\r\n");

  it("reads lockfile ids from the project document and skips the boot document", () => {
    expect([...lockfilePackageIds(twoDocumentLockfile)]).toEqual([
      "@rolldown/binding-win32-x64-msvc@1.2.19",
      "vite@8.3.8",
    ]);
  });

  it("reads a lockfile that has only the project document", () => {
    const single = twoDocumentLockfile.split("---\r\n").at(-1) ?? "";
    expect(lockfilePackageIds(single).has("vite@8.3.8")).toBe(true);
  });

  it("detects config dependencies in the boot document", () => {
    expect(hasConfigDependencies(twoDocumentLockfile)).toBe(false);
    const withConfig = twoDocumentLockfile.replace(
      "    configDependencies: {}",
      "    configDependencies:\r\n      some-plugin: 1.0.0+sha512-x",
    );
    expect(hasConfigDependencies(withConfig)).toBe(true);
  });
});

describe("workspace packages", () => {
  it("accepts GPL-3.0-or-later and AGPL-3.0-or-later, and nothing else", () => {
    const violations = findWorkspaceViolations([
      { name: "galatsa", path: ".", license: "GPL-3.0-or-later" },
      { name: "@galatsa/server", path: "packages/server", license: "AGPL-3.0-or-later" },
      { name: "@galatsa/a", path: "packages/a", license: "GPL-2.0-only" },
      { name: "@galatsa/b", path: "packages/b", license: "MIT" },
      { name: "@galatsa/c", path: "packages/c", license: undefined },
    ]);
    expect(violations.map((v) => v.name)).toEqual([
      "@galatsa/a",
      "@galatsa/b",
      "@galatsa/c",
    ]);
  });
});
