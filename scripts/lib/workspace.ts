// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the workspace check (scripts/check-workspace.ts): rules for the
// project's own packages. docs/new-package.md explains them for people.
//
// - Each package's "license" field matches its location (scripts/lib/project-license.ts).
// - Each package has the files and fields its kind needs (see PACKAGE_KINDS).
// - No package except packages/server depends on packages/server, so AGPL code cannot
//   reach the shipped program.
// - A source file may import only Node built-ins, its own package, and packages
//   declared in its own package.json (any dependency field). A package must not rely
//   on another package's dependencies being reachable in node_modules.
// - Packages run by Node from source (NODE_RUN_PATHS) must not depend, directly or
//   through other workspace packages, on a package with .tsx or .jsx files: Node's
//   type stripping cannot load them.

import { isBuiltin } from "node:module";
import ts from "typescript";
import { licenseForPath, SERVER_PATH } from "./project-license.ts";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Workspace packages that Node runs directly from source (the root runs scripts/). */
export const NODE_RUN_PATHS: readonly string[] = [".", "bench"];

/** Source file extensions whose imports are checked. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export interface Manifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly license?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  /** Folder relative to the repository root, "/" separators, "." for the root. */
  readonly path: string;
  readonly manifest: Manifest;
  /** Files of the package (not of nested packages), relative to the package folder. */
  readonly files: readonly string[];
  /** Reads a file of the package, path relative to the package folder. */
  readonly read: (file: string) => string;
}

export type PackageKind = "root" | "library" | "app" | "tooling";

/** The kind of a package, from its location; undefined if it is in an unexpected place. */
export function kindOf(path: string): PackageKind | undefined {
  if (path === ".") return "root";
  if (/^packages\/[^/]+$/.test(path) || /^packages\/extensions\/[^/]+$/.test(path)) {
    return "library";
  }
  if (/^apps\/[^/]+$/.test(path)) return "app";
  if (path === "bench" || path === "tests/e2e") return "tooling";
  return undefined;
}

/** What each kind of package must have. */
const PACKAGE_KINDS: Record<
  PackageKind,
  { files: readonly string[]; scripts: readonly string[]; sourceExports: boolean }
> = {
  root: { files: [], scripts: [], sourceExports: false },
  library: {
    files: ["tsconfig.json", "tsconfig.build.json"],
    scripts: ["typecheck", "build"],
    sourceExports: true,
  },
  app: {
    files: ["tsconfig.json"],
    scripts: ["typecheck", "build"],
    sourceExports: false,
  },
  tooling: { files: ["tsconfig.json"], scripts: ["typecheck"], sourceExports: false },
};

function label(pkg: WorkspacePackage): string {
  const name = typeof pkg.manifest.name === "string" ? pkg.manifest.name : "(no name)";
  return `${name} (${pkg.path})`;
}

/** Checks the license field, the required files, scripts and exports of one package. */
export function checkStructure(pkg: WorkspacePackage): string[] {
  const problems: string[] = [];
  const kind = kindOf(pkg.path);
  if (kind === undefined) {
    return [
      `${label(pkg)}: workspace packages belong in packages/, packages/extensions/, apps/, bench or tests/e2e.`,
    ];
  }
  const expected = licenseForPath(pkg.path);
  if (pkg.manifest.license !== expected) {
    problems.push(
      `${label(pkg)}: "license" is ${JSON.stringify(pkg.manifest.license)}, must be "${expected}".`,
    );
  }
  if (pkg.manifest.private !== true) {
    problems.push(`${label(pkg)}: must have "private": true.`);
  }
  const rules = PACKAGE_KINDS[kind];
  for (const file of rules.files) {
    if (!pkg.files.includes(file)) problems.push(`${label(pkg)}: ${file} is missing.`);
  }
  for (const script of rules.scripts) {
    if (typeof pkg.manifest.scripts?.[script] !== "string") {
      problems.push(`${label(pkg)}: the "${script}" script is missing.`);
    }
  }
  if (rules.sourceExports) problems.push(...checkSourceExports(pkg));
  if (pkg.files.includes("tsconfig.build.json")) {
    const { config } = ts.parseConfigFileTextToJson(
      "tsconfig.build.json",
      pkg.read("tsconfig.build.json"),
    );
    if ((config as { exclude?: unknown } | undefined)?.exclude !== undefined) {
      problems.push(
        `${label(pkg)}: tsconfig.build.json must not set "exclude"; the shared one in tsconfig.build.base.json keeps tests out of dist/.`,
      );
    }
  }
  return problems;
}

function checkSourceExports(pkg: WorkspacePackage): string[] {
  const exports = pkg.manifest.exports;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(exports) || !isObject(exports["."])) {
    return [`${label(pkg)}: "exports" must have a "." entry with conditions.`];
  }
  const problems: string[] = [];
  for (const [subpath, conditions] of Object.entries(exports)) {
    const first = isObject(conditions) ? Object.entries(conditions)[0] : undefined;
    if (
      first === undefined ||
      first[0] !== "@galatsa/source" ||
      typeof first[1] !== "string" ||
      !first[1].startsWith("./src/")
    ) {
      problems.push(
        `${label(pkg)}: exports["${subpath}"] must list "@galatsa/source": "./src/..." first.`,
      );
    }
  }
  return problems;
}

/** Names of all packages a manifest declares, in any dependency field. */
export function declaredDependencies(manifest: Manifest): Set<string> {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

/** No package other than packages/server may depend on packages/server. */
export function checkServerDependency(packages: readonly WorkspacePackage[]): string[] {
  const server = packages.find((pkg) => pkg.path === SERVER_PATH);
  if (server === undefined || typeof server.manifest.name !== "string") return [];
  const serverName = server.manifest.name;
  return packages
    .filter((pkg) => pkg !== server && declaredDependencies(pkg.manifest).has(serverName))
    .map(
      (pkg) =>
        `${label(pkg)}: depends on ${serverName}. Only ${SERVER_PATH} may use the AGPL server code.`,
    );
}

/** The npm package name of a bare import specifier, or undefined if it is not one. */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":") // node:fs, virtual:..., data:..., https://...
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Import specifiers of a source file: import, export from, import(), require(). */
export function importsOf(text: string): string[] {
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles.map((ref) => ref.fileName);
}

function isSourceFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXTENSIONS.includes(file.slice(dot).toLowerCase());
}

/** Checks that every bare import of a package is declared in its own package.json. */
export function checkImports(pkg: WorkspacePackage): string[] {
  const declared = declaredDependencies(pkg.manifest);
  const ownName = typeof pkg.manifest.name === "string" ? pkg.manifest.name : undefined;
  const problems: string[] = [];
  for (const file of pkg.files.filter(isSourceFile)) {
    for (const specifier of importsOf(pkg.read(file))) {
      if (specifier.startsWith("node:") && isBuiltin(specifier)) continue;
      const name = packageNameOf(specifier);
      if (name === undefined || name === ownName || isBuiltin(name)) continue;
      if (!declared.has(name)) {
        const where = pkg.path === "." ? file : `${pkg.path}/${file}`;
        problems.push(
          `${where} imports "${name}", which ${label(pkg)} does not declare in its package.json.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Packages run by Node from source must not reach a workspace package that has .tsx
 * or .jsx files, through workspace dependencies.
 */
export function checkNodeRunnable(packages: readonly WorkspacePackage[]): string[] {
  const byName = new Map<string, WorkspacePackage>();
  for (const pkg of packages) {
    if (typeof pkg.manifest.name === "string") byName.set(pkg.manifest.name, pkg);
  }
  const hasJsx = (pkg: WorkspacePackage): boolean =>
    pkg.files.some((file) => /\.(tsx|jsx)$/i.test(file));

  const problems: string[] = [];
  for (const start of packages.filter((pkg) => NODE_RUN_PATHS.includes(pkg.path))) {
    const seen = new Set<WorkspacePackage>();
    const queue: WorkspacePackage[] = [start];
    for (let pkg = queue.pop(); pkg !== undefined; pkg = queue.pop()) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      if (hasJsx(pkg)) {
        problems.push(
          `${label(start)} is run by Node from source, but ${label(pkg)} has .tsx or .jsx files, which Node cannot load.`,
        );
      }
      for (const name of declaredDependencies(pkg.manifest)) {
        const next = byName.get(name);
        if (next !== undefined) queue.push(next);
      }
    }
  }
  return problems;
}

/** Runs every rule over all workspace packages. */
export function checkWorkspace(packages: readonly WorkspacePackage[]): string[] {
  return [
    ...packages.flatMap(checkStructure),
    ...checkServerDependency(packages),
    ...packages.flatMap(checkImports),
    ...checkNodeRunnable(packages),
  ];
}
