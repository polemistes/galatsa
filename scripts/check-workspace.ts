// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the project's own workspace packages: license fields, required files and
// fields, no dependency on the AGPL server package, no undeclared imports, and no
// .tsx reachable from code that Node runs from source. Rules are in
// scripts/lib/workspace.ts; docs/new-package.md explains them.
//
// Usage: node scripts/check-workspace.ts   (or `pnpm check:workspace`)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  return listed.map((entry) => relative(root, entry.path).split(sep).join("/") || ".");
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
    return {
      path,
      manifest: JSON.parse(readLocal("package.json")) as Manifest,
      files: filesOf.get(path) ?? [],
      read: readLocal,
    };
  });

  const problems = checkWorkspace(packages);
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
