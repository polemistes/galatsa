// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  classifyPackages,
  isOutsideRepository,
  packageIdOf,
  parseLockfile,
  resolveTarget,
} from "./lockfile.ts";

/** A small two-document lockfile in the shape pnpm 12 writes. */
function lockfile(
  options: { coreDeps?: string; rootDevDeps?: string; configDeps?: string } = {},
): string {
  return [
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    options.configDeps ?? "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    "        specifier: 12.19.0",
    "        version: 12.19.0",
    "",
    "packages:",
    "",
    "  pnpm@12.19.0:",
    "    resolution: {integrity: sha512-x}",
    "",
    "snapshots:",
    "",
    "  pnpm@12.19.0: {}",
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
    "        version: 8.3.8(yaml@2.9.1)",
    options.rootDevDeps ?? "",
    "",
    "  packages/core:",
    options.coreDeps ?? "    {}",
    "",
    "  packages/web:",
    "    dependencies:",
    "      '@galatsa/core':",
    "        specifier: workspace:*",
    "        version: link:../core",
    "",
    "packages:",
    "",
    "  '@rolldown/binding-win32-x64-msvc@1.2.19':",
    "    resolution: {integrity: sha512-x}",
    "    cpu: [x64]",
    "    os: [win32]",
    "",
    "  rolldown@1.2.19:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  vite@8.3.8:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  yaml@2.9.1:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  blowfish-js@1.0.0:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  string-width@4.2.3:",
    "    resolution: {integrity: sha512-x}",
    "",
    "snapshots:",
    "",
    "  '@rolldown/binding-win32-x64-msvc@1.2.19':",
    "    optional: true",
    "",
    "  rolldown@1.2.19:",
    "    optionalDependencies:",
    "      '@rolldown/binding-win32-x64-msvc': 1.2.19",
    "",
    "  vite@8.3.8(yaml@2.9.1):",
    "    dependencies:",
    "      rolldown: 1.2.19",
    "    optionalDependencies:",
    "      yaml: 2.9.1",
    "",
    "  yaml@2.9.1: {}",
    "",
    "  blowfish-js@1.0.0: {}",
    "",
    "  string-width@4.2.3: {}",
    "",
  ].join("\r\n");
}

describe("parseLockfile", () => {
  it("reads the project document and ignores the boot document", () => {
    const parsed = parseLockfile(lockfile());
    expect([...parsed.packageIds].sort()).toEqual(
      [
        "@rolldown/binding-win32-x64-msvc@1.2.19",
        "blowfish-js@1.0.0",
        "rolldown@1.2.19",
        "string-width@4.2.3",
        "vite@8.3.8",
        "yaml@2.9.1",
      ].sort(),
    );
    expect(parsed.importers.map((importer) => importer.path)).toEqual([
      ".",
      "packages/core",
      "packages/web",
    ]);
    expect(parsed.hasConfigDependencies).toBe(false);
  });

  it("reads a lockfile that has only the project document", () => {
    const single = lockfile().split("---\r\n").at(-1) ?? "";
    expect(parseLockfile(single).packageIds.has("vite@8.3.8")).toBe(true);
  });

  it("detects config dependencies in the boot document", () => {
    const text = lockfile({
      configDeps: "    configDependencies:\r\n      some-plugin: 1.0.0+sha512-x",
    });
    expect(parseLockfile(text).hasConfigDependencies).toBe(true);
  });
});

describe("resolveTarget", () => {
  it("resolves links relative to the importer", () => {
    expect(resolveTarget("packages/web", "@galatsa/core", "link:../core")).toEqual({
      kind: "link",
      path: "packages/core",
    });
    expect(resolveTarget("packages/core", "x", "link:../../../plants/x")).toEqual({
      kind: "link",
      path: "../plants/x",
    });
    expect(resolveTarget("packages/core", "x", "link:/tmp/x")).toEqual({
      kind: "link",
      path: "/tmp/x",
    });
  });

  it("builds snapshot keys, keeping peer suffixes and aliases", () => {
    expect(resolveTarget(".", "vite", "8.3.8(yaml@2.9.1)")).toEqual({
      kind: "package",
      key: "vite@8.3.8(yaml@2.9.1)",
    });
    expect(resolveTarget(".", "string-width-cjs", "string-width@4.2.3")).toEqual({
      kind: "package",
      key: "string-width@4.2.3",
    });
    expect(resolveTarget(".", "x", "file:../plants/x")).toEqual({
      kind: "package",
      key: "x@file:../plants/x",
    });
  });

  it("strips peer suffixes for package ids", () => {
    expect(packageIdOf("vite@8.3.8(@types/node@26.6.6)(yaml@2.9.1)")).toBe("vite@8.3.8");
  });

  it("knows which paths leave the repository", () => {
    expect(isOutsideRepository("../plants/x")).toBe(true);
    expect(isOutsideRepository("/tmp/x")).toBe(true);
    expect(isOutsideRepository("C:/plants/x")).toBe(true);
    expect(isOutsideRepository("packages/x/../../..")).toBe(true);
    expect(isOutsideRepository("vendor/x")).toBe(false);
  });
});

describe("classifyPackages", () => {
  it("treats only the root's devDependencies as development", () => {
    const result = classifyPackages(parseLockfile(lockfile()));
    expect(result.problems).toEqual([]);
    expect([...result.production]).toEqual([]);
    expect([...result.development].sort()).toEqual(
      [
        "@rolldown/binding-win32-x64-msvc@1.2.19",
        "rolldown@1.2.19",
        "vite@8.3.8",
        "yaml@2.9.1",
      ].sort(),
    );
  });

  it.each(["dependencies", "devDependencies", "optionalDependencies"])(
    "treats %s of a workspace package as production, with their dependencies",
    (field) => {
      const coreDeps = [
        `    ${field}:`,
        "      vite:",
        "        specifier: 8.3.8",
        "        version: 8.3.8(yaml@2.9.1)",
      ].join("\r\n");
      const result = classifyPackages(parseLockfile(lockfile({ coreDeps })));
      expect(result.production.has("vite@8.3.8")).toBe(true);
      expect(result.production.has("@rolldown/binding-win32-x64-msvc@1.2.19")).toBe(true);
      expect(result.development.has("vite@8.3.8")).toBe(false);
    },
  );

  it("follows aliases", () => {
    const coreDeps = [
      "    dependencies:",
      "      string-width-cjs:",
      "        specifier: npm:string-width@4.2.3",
      "        version: string-width@4.2.3",
    ].join("\r\n");
    const result = classifyPackages(parseLockfile(lockfile({ coreDeps })));
    expect(result.production.has("string-width@4.2.3")).toBe(true);
  });

  it("rejects a link: dependency that is not a workspace package", () => {
    const coreDeps = [
      "    dependencies:",
      "      plant:",
      "        specifier: link:../../../plants/x",
      "        version: link:../../../plants/x",
    ].join("\r\n");
    const result = classifyPackages(parseLockfile(lockfile({ coreDeps })));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("not a workspace package");
  });

  it("rejects a file: dependency outside the repository", () => {
    const coreDeps = [
      "    dependencies:",
      "      blowfish-js:",
      "        specifier: file:../../../plants/x",
      "        version: file:../plants/x",
    ].join("\r\n");
    const text = lockfile({ coreDeps })
      .replace("  blowfish-js@1.0.0:\r\n", "  blowfish-js@file:../plants/x:\r\n")
      .replace("  blowfish-js@1.0.0: {}", "  blowfish-js@file:../plants/x: {}");
    const result = classifyPackages(parseLockfile(text));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("outside the repository");
  });

  it("reports a dependency that has no snapshot", () => {
    const coreDeps = [
      "    dependencies:",
      "      missing:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
    ].join("\r\n");
    const result = classifyPackages(parseLockfile(lockfile({ coreDeps })));
    expect(result.problems).toEqual([
      "pnpm-lock.yaml has no snapshot for missing@1.0.0.",
    ]);
  });
});
