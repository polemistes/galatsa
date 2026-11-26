// SPDX-License-Identifier: GPL-3.0-or-later

// Reads pnpm-lock.yaml and works out which third-party packages are production
// dependencies and which are development-only. Pure logic: the CLI in
// scripts/check-licenses.ts reads the file and passes its text in.
//
// Classification (decided 2026-11-26, during review of the tooling setup):
//
// - Production: every package reachable from any dependency field (dependencies,
//   devDependencies, optionalDependencies, and auto-installed peerDependencies) of any
//   workspace package other than the repository root, and from the root's
//   "dependencies" and "optionalDependencies". A workspace package may be shipped,
//   and a bundler can pull a package into the shipped program whatever field lists it.
// - Development: packages reachable only from the root's "devDependencies", which is
//   the repository tooling (linters, test runners, checkers). They are never shipped.
//
// Reachability follows the lockfile's "snapshots" section (each package's own
// dependencies and optionalDependencies, which include its resolved peers).
//
// Paths in the lockfile: a "link:" version of an importer is relative to that
// importer's folder; a "link:" version inside a snapshot (written there by an
// override) and every "file:" version are relative to the repository root.

import { posix } from "node:path";
import { parseAllDocuments } from "yaml";

/** Dependency fields of an importer (workspace package) in the lockfile. */
const IMPORTER_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
type ImporterField = (typeof IMPORTER_FIELDS)[number];

export interface DirectDependency {
  readonly name: string;
  readonly field: ImporterField;
  /** The resolved version as the lockfile writes it, for example "8.3.8(yaml@2.9.1)". */
  readonly version: string;
}

export interface Importer {
  /** Folder of the workspace package relative to the repository root ("." for the root). */
  readonly path: string;
  readonly dependencies: readonly DirectDependency[];
}

/**
 * Where a package in the lockfile comes from. Only "registry" packages have a
 * publish date and a name@version that `pnpm licenses list` reports unchanged.
 */
export type PackageSource =
  | { readonly kind: "registry" }
  | { readonly kind: "tarball" | "git" | "directory"; readonly location: string };

export interface Lockfile {
  readonly importers: readonly Importer[];
  /** "name@version" of every package in the "packages" section, all platforms. */
  readonly packageIds: ReadonlySet<string>;
  /**
   * "name@version" of every package in the boot document: pnpm itself, pinned by
   * "packageManager", and its platform binaries. Not part of any importer.
   */
  readonly bootPackageIds: ReadonlySet<string>;
  /** Source of every package in either document, by package id. */
  readonly sources: ReadonlyMap<string, PackageSource>;
  /** Snapshot key -> the snapshot keys or link targets it depends on, as name/version pairs. */
  readonly snapshots: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>;
  /** True if the boot document lists pnpm config dependencies. */
  readonly hasConfigDependencies: boolean;
}

type YamlMap = Record<string, unknown>;

function asMap(value: unknown): YamlMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as YamlMap)
    : {};
}

/**
 * Parses the text of pnpm-lock.yaml. pnpm 12 can write a "boot document" first, with
 * the pnpm version pinned by "packageManager" and pnpm config dependencies; the
 * project lockfile is always the last document (https://pnpm.io/lockfile).
 */
export function parseLockfile(text: string): Lockfile {
  const documents = parseAllDocuments(text);
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("pnpm-lock.yaml has no YAML documents");
  }
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new Error(`pnpm-lock.yaml is not valid YAML: ${document.errors[0]?.message}`);
    }
  }
  const project = asMap(documents.at(-1)?.toJS());
  const boot = documents.length > 1 ? asMap(documents[0]?.toJS()) : {};

  const importers: Importer[] = Object.entries(asMap(project["importers"])).map(
    ([path, value]) => {
      const entry = asMap(value);
      const dependencies: DirectDependency[] = [];
      for (const field of IMPORTER_FIELDS) {
        for (const [name, spec] of Object.entries(asMap(entry[field]))) {
          dependencies.push({ name, field, version: String(asMap(spec)["version"]) });
        }
      }
      return { path, dependencies };
    },
  );

  const packageIds = new Set(Object.keys(asMap(project["packages"])).map(packageIdOf));
  const bootPackageIds = new Set(Object.keys(asMap(boot["packages"])).map(packageIdOf));
  const sources = new Map<string, PackageSource>();
  for (const section of [boot["packages"], project["packages"]]) {
    for (const [key, value] of Object.entries(asMap(section))) {
      sources.set(packageIdOf(key), sourceOf(asMap(asMap(value)["resolution"])));
    }
  }

  const snapshots = new Map<string, Array<readonly [string, string]>>();
  for (const [key, value] of Object.entries(asMap(project["snapshots"]))) {
    const entry = asMap(value);
    const children: Array<readonly [string, string]> = [];
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(asMap(entry[field]))) {
        children.push([name, String(version)]);
      }
    }
    snapshots.set(key, children);
  }

  const hasConfigDependencies = Object.values(asMap(boot["importers"])).some(
    (importer) => Object.keys(asMap(asMap(importer)["configDependencies"])).length > 0,
  );

  return {
    importers,
    packageIds,
    bootPackageIds,
    sources,
    snapshots,
    hasConfigDependencies,
  };
}

/** The npm registry. Tarball URLs on it still count as registry packages. */
const REGISTRY_TARBALL = /^https:\/\/registry\.npmjs\.org\//;

/** Reads a "resolution" entry of the lockfile (https://pnpm.io/lockfile). */
function sourceOf(resolution: YamlMap): PackageSource {
  const type = resolution["type"];
  if (type === "git") {
    return {
      kind: "git",
      location: `${String(resolution["repo"])}#${String(resolution["commit"])}`,
    };
  }
  if (type === "directory") {
    return { kind: "directory", location: String(resolution["directory"]) };
  }
  const tarball = resolution["tarball"];
  if (typeof tarball === "string" && resolution["gitHosted"] === true) {
    // "github:owner/repo": pnpm downloads a tarball of the commit from the host.
    return { kind: "git", location: tarball };
  }
  if (typeof tarball === "string" && !REGISTRY_TARBALL.test(tarball)) {
    return { kind: "tarball", location: tarball };
  }
  if (type !== undefined || typeof resolution["integrity"] !== "string") {
    // Anything else that is not a plain registry entry: say what the lockfile has.
    return { kind: "tarball", location: JSON.stringify(resolution) };
  }
  return { kind: "registry" };
}

/** Describes a package that does not come from the registry, for error messages. */
export function describeSource(id: string, source: PackageSource): string | undefined {
  switch (source.kind) {
    case "registry":
      return undefined;
    case "git":
      return `${id} comes from a git repository (${source.location})`;
    case "directory":
      return `${id} comes from the local folder ${source.location}`;
    case "tarball":
      return source.location.startsWith("file:")
        ? `${id} comes from the local tarball ${source.location.slice("file:".length)}`
        : `${id} comes from the tarball ${source.location}`;
  }
}

/** "name@version(peer@1)(peer@2)" -> "name@version". */
export function packageIdOf(snapshotKey: string): string {
  return snapshotKey.replace(/\(.*$/, "");
}

export type DependencyTarget =
  | { readonly kind: "link"; readonly path: string }
  | { readonly kind: "package"; readonly key: string };

/**
 * Turns a name and a lockfile version into what it points at. "link:" versions are
 * relative to `base`: the importer's folder for an importer's dependencies, the
 * repository root (".") for a snapshot's dependencies. The result is relative to
 * the repository root, or absolute when the link was absolute. Aliased versions
 * ("other@1.0.0") are already a snapshot key.
 */
export function resolveTarget(
  base: string,
  name: string,
  version: string,
): DependencyTarget {
  if (version.startsWith("link:")) {
    const target = version.slice("link:".length).replace(/\\/g, "/");
    if (isAbsolute(target)) return { kind: "link", path: target };
    return { kind: "link", path: posix.normalize(posix.join(base, target)) };
  }
  const plain = version.replace(/\(.*$/, "");
  if (!plain.startsWith("file:") && plain.lastIndexOf("@") > 0) {
    return { kind: "package", key: version };
  }
  return { kind: "package", key: `${name}@${version}` };
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

/** True if a root-relative or absolute path lies outside the repository. */
export function isOutsideRepository(path: string): boolean {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  return isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../");
}

export interface Classification {
  /** Package ids that must meet the production policy. */
  readonly production: ReadonlySet<string>;
  /** Package ids reachable only from the root's devDependencies. */
  readonly development: ReadonlySet<string>;
  /** Problems that make the check fail, such as links that leave the workspace. */
  readonly problems: readonly string[];
}

/** Classifies every package in the lockfile as production or development. */
export function classifyPackages(lockfile: Lockfile): Classification {
  const problems: string[] = [];
  const importerPaths = new Set(lockfile.importers.map((importer) => importer.path));

  const productionRoots: string[] = [];
  const developmentRoots: string[] = [];

  // `from` names the importer folder or the snapshot key, for messages; `base` is
  // the folder that link: versions are relative to.
  const addTarget = (
    from: string,
    base: string,
    name: string,
    version: string,
    roots: string[],
  ): void => {
    const target = resolveTarget(base, name, version);
    if (target.kind === "link") {
      // A link must point at another workspace package. Anything else (outside the
      // repository, or a folder that is not a workspace package) is never installed
      // into the store, so `pnpm licenses list` cannot see its license.
      if (!importerPaths.has(target.path)) {
        problems.push(
          `${from} depends on ${name} through "${version}", which is not a workspace package. ` +
            "link: dependencies must point at a workspace package.",
        );
      }
      return;
    }
    const fileVersion = /@(file:.*)$/.exec(packageIdOf(target.key))?.[1];
    if (
      fileVersion !== undefined &&
      isOutsideRepository(fileVersion.slice("file:".length))
    ) {
      problems.push(
        `${from} depends on ${name} through "${fileVersion}", which is outside the repository. ` +
          "file: dependencies must stay inside the workspace.",
      );
    }
    roots.push(target.key);
  };

  for (const importer of lockfile.importers) {
    for (const dependency of importer.dependencies) {
      const developmentOnly =
        importer.path === "." && dependency.field === "devDependencies";
      addTarget(
        importer.path,
        importer.path,
        dependency.name,
        dependency.version,
        developmentOnly ? developmentRoots : productionRoots,
      );
    }
  }

  const walk = (roots: readonly string[]): Set<string> => {
    const seenKeys = new Set<string>();
    const ids = new Set<string>();
    const queue = [...roots];
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      ids.add(packageIdOf(key));
      const children = lockfile.snapshots.get(key);
      if (children === undefined) {
        problems.push(`pnpm-lock.yaml has no snapshot for ${key}.`);
        continue;
      }
      for (const [name, version] of children) addTarget(key, ".", name, version, queue);
    }
    return ids;
  };

  const production = walk(productionRoots);
  const development = new Set(
    [...walk(developmentRoots)].filter((id) => !production.has(id)),
  );
  return { production, development, problems: [...new Set(problems)] };
}

export interface LinkReference {
  /** The importer folder or snapshot key that has the link. */
  readonly from: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Every link: dependency, in an importer or a snapshot, whose target is `path` or
 * lies inside it. `path` is relative to the repository root. Importers at or inside
 * `path` are skipped: a package may link to its own subfolders.
 */
export function linksInto(lockfile: Lockfile, path: string): LinkReference[] {
  const inside = (target: string): boolean =>
    target === path || target.startsWith(`${path}/`);
  const found: LinkReference[] = [];
  for (const importer of lockfile.importers) {
    if (inside(importer.path)) continue;
    for (const { name, version } of importer.dependencies) {
      const target = resolveTarget(importer.path, name, version);
      if (target.kind === "link" && inside(target.path)) {
        found.push({ from: importer.path, name, version });
      }
    }
  }
  for (const [key, children] of lockfile.snapshots) {
    for (const [name, version] of children) {
      const target = resolveTarget(".", name, version);
      if (target.kind === "link" && inside(target.path)) {
        found.push({ from: key, name, version });
      }
    }
  }
  return found;
}
