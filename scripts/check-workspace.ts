// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the project's own workspace packages: license fields, required files and
// fields, nothing reaching the AGPL server package (by name, alias, path or a link
// in pnpm-lock.yaml), no undeclared imports and no relative paths out of a package
// (scripts, stylesheets, HTML, aliases and symbolic links, compared on real paths),
// and no .tsx reachable from code that Node runs from source. Rules are in scripts/lib/workspace.ts; docs/new-package.md explains
// them.
//
// Usage: node scripts/check-workspace.ts   (or `pnpm check:workspace`)

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLockfile, type Lockfile } from "./lib/lockfile.ts";
import { checkWorkspace, type Manifest, type WorkspacePackage } from "./lib/workspace.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function run(command: string, args: readonly string[], shell: boolean): string {
  // pnpm needs a shell on Windows (pnpm.cmd). The arguments are fixed strings.
  const result = shell
    ? spawnSync(`${command} ${args.join(" ")}`, {
        cwd: root,
        shell: true,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      })
    : spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
  if (result.error || result.status !== 0) {
    fail([
      `Workspace check could not run "${command} ${args.join(" ")}".`,
      result.stderr || String(result.error ?? ""),
    ]);
  }
  return result.stdout;
}

/** Workspace package folders from pnpm's own metadata, relative, "/" separators. */
function listPackagePaths(): string[] {
  const listed = JSON.parse(
    run("pnpm", ["ls", "--recursive", "--depth", "-1", "--json"], true),
  ) as Array<{
    path: string;
  }>;
  // Compare real paths: the repository may be reached through a symlink, or on
  // Windows through a short (8.3) name, and pnpm may report the other spelling.
  return listed.map((entry) => {
    const path = relative(realRoot, realpathSync.native(entry.path));
    if (path.startsWith("..") || isAbsolute(path)) {
      fail([`Workspace check: pnpm listed ${entry.path}, which is outside ${realRoot}.`]);
    }
    return path.split(sep).join("/") || ".";
  });
}

// The repository root where it really is, for comparing real paths.
const realRoot = realpathSync.native(root);

/**
 * Where a path really is after following symbolic links, relative to the real
 * repository root with "/" separators. For a path that does not exist, the real
 * location of its nearest existing parent plus the rest.
 */
function realPathOf(absolute: string): string {
  let existing = absolute;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  let real: string;
  try {
    real = join(realpathSync.native(existing), ...rest);
  } catch {
    real = absolute;
  }
  const path = relative(realRoot, real).split(sep).join("/");
  // On Windows a path on another drive stays absolute; mark it as outside.
  return isAbsolute(path) ? `../${path}` : path || ".";
}

function isSymlink(absolute: string): boolean {
  try {
    return lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Tracked and untracked, not ignored files; git writes "/" separators everywhere. */
function listFiles(): string[] {
  return run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    false,
  )
    .split("\0")
    .filter((file) => file.length > 0);
}

/** The lockfile, for link: targets that the manifests alone do not show (overrides). */
function readLockfile(): Lockfile {
  try {
    return parseLockfile(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  } catch (error) {
    fail([
      `Workspace check could not read pnpm-lock.yaml: ${String(error)}`,
      "Run pnpm install first.",
    ]);
  }
}

function main(): void {
  const paths = listPackagePaths();
  if (!paths.includes("."))
    fail(["Workspace check: pnpm did not list the root package."]);
  const files = listFiles();

  // Each file belongs to the deepest package folder that contains it.
  const deepestFirst = [...paths].sort((a, b) => b.length - a.length);
  const filesOf = new Map<string, string[]>(paths.map((path) => [path, []]));
  for (const file of files) {
    const owner =
      deepestFirst.find((path) => path === "." || file.startsWith(`${path}/`)) ?? ".";
    const local = owner === "." ? file : file.slice(owner.length + 1);
    filesOf.get(owner)?.push(local);
  }

  const packages: WorkspacePackage[] = paths.map((path) => {
    const folder = join(root, ...path.split("/"));
    const readLocal = (file: string): string => {
      try {
        return readFileSync(join(folder, ...file.split("/")), "utf8");
      } catch {
        return ""; // tracked but deleted in the working tree
      }
    };
    const files = filesOf.get(path) ?? [];
    return {
      path,
      manifest: JSON.parse(readLocal("package.json")) as Manifest,
      files,
      read: readLocal,
      realPath: (file: string) => realPathOf(join(folder, ...file.split("/"))),
      symlinks: files.filter((file) => isSymlink(join(folder, ...file.split("/")))),
    };
  });

  const problems = checkWorkspace(packages, readLockfile());
  if (problems.length > 0) {
    fail([
      `Workspace check failed: ${problems.length} problem(s).`,
      ...problems.map((problem) => `  - ${problem}`),
      "See docs/new-package.md.",
    ]);
  }
  console.log(`Workspace check passed: ${packages.length} workspace packages.`);
}

main();
