// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the license of every installed dependency of every workspace package,
// including optional dependencies and transitive dependencies, and the license field
// of every workspace package itself. Policies are in scripts/lib/licenses.ts.
//
// Usage: node scripts/check-licenses.ts   (or `pnpm check:licenses`)
// Exits with 1 if a license is not acceptable, if the list of dependencies is empty,
// or if a lockfile entry is missing from the report.
//
// The script runs main() unconditionally (no "is this the main module" guard), so it
// behaves the same when started through a symlink or another path spelling.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findViolations,
  findWorkspaceViolations,
  flattenReport,
  hasConfigDependencies,
  lockfilePackageIds,
  WORKSPACE_LICENSES,
  type LicenseReport,
  type PackageLicense,
  type WorkspacePackage,
} from "./lib/licenses.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** Runs a pnpm command and returns its standard output. Fails the check on error. */
function runPnpm(args: string): string {
  // "shell: true" so that the pnpm command (pnpm.cmd) is found on Windows as well.
  // The arguments are fixed strings from this file, never user input.
  const result = spawnSync(`pnpm ${args}`, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail([
      `License check could not run "pnpm ${args}".`,
      result.stderr || String(result.error ?? ""),
    ]);
  }
  return result.stdout;
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    fail([`License check could not read the output of ${what} as JSON.`]);
  }
}

/** Runs `pnpm licenses list` for all workspace packages and returns the report. */
function readLicenseReport(extraArgs: string): LicenseReport {
  const args = `licenses list --json --recursive ${extraArgs}`.trim();
  return parseJson<LicenseReport>(runPnpm(args), `pnpm ${args}`);
}

/**
 * Lists the workspace packages (the root included) from pnpm's own metadata, and
 * reads the license field of each. Packages are identified by their folder, not by
 * their name.
 */
function readWorkspacePackages(): WorkspacePackage[] {
  const listed = parseJson<Array<{ name?: string; path: string }>>(
    runPnpm("ls --recursive --depth -1 --json"),
    "pnpm ls",
  );
  return listed.map((entry) => {
    const manifest = JSON.parse(
      readFileSync(join(entry.path, "package.json"), "utf8"),
    ) as {
      license?: unknown;
    };
    const path = relative(root, entry.path).split(sep).join("/") || ".";
    return {
      name: entry.name ?? "(no name)",
      path,
      license: typeof manifest.license === "string" ? manifest.license : undefined,
    };
  });
}

/** Reads the "name@version" ids of every package in pnpm-lock.yaml, for all platforms. */
function readLockfileIds(): Set<string> {
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(lockPath))
    fail(["License check needs pnpm-lock.yaml. Run pnpm install first."]);
  const text = readFileSync(lockPath, "utf8");
  if (hasConfigDependencies(text)) {
    fail([
      "pnpm-lock.yaml lists pnpm config dependencies (configDependencies).",
      "The license check does not cover them yet. Extend scripts/check-licenses.ts first.",
    ]);
  }
  return lockfilePackageIds(text);
}

function main(): void {
  // Without node_modules, pnpm reads names from the lockfile and reports every license
  // as "Unknown". Say what is wrong instead.
  if (!existsSync(join(root, "node_modules", ".modules.yaml"))) {
    fail([
      "License check found no installed dependencies (node_modules/.modules.yaml is missing).",
      "Run pnpm install first. An empty result is not a pass.",
    ]);
  }
  const lockfileIds = readLockfileIds();

  const workspace = readWorkspacePackages();
  const workspaceViolations = findWorkspaceViolations(workspace);
  if (workspaceViolations.length > 0) {
    fail([
      `License check failed: ${workspaceViolations.length} workspace package(s) have a license field that is not allowed:`,
      ...workspaceViolations.map(
        (p) => `  - ${p.name} (${p.path}): ${p.license ?? "no license field"}`,
      ),
      `Workspace packages must use one of: ${[...WORKSPACE_LICENSES].join(", ")}.`,
    ]);
  }

  const all = flattenReport(readLicenseReport(""));
  const productionIds = new Set(
    flattenReport(readLicenseReport("--prod")).map((e) => e.id),
  );

  if (all.length === 0) {
    fail([
      "License check found no dependencies to check.",
      "Run pnpm install first. An empty result is not a pass.",
    ]);
  }

  const packages: PackageLicense[] = all.map((entry) => ({
    ...entry,
    production: productionIds.has(entry.id),
  }));

  // Every lockfile entry (all platforms, optional packages included) must be in the report.
  // Otherwise a package could be skipped without anyone noticing.
  const reported = new Set(all.map((entry) => entry.id));
  const unverified = [...lockfileIds].filter((id) => !reported.has(id));
  if (unverified.length > 0) {
    fail([
      `License check could not read the license of ${unverified.length} lockfile package(s):`,
      ...unverified.map((id) => `  - ${id}`),
      "They are not installed. Check that supportedArchitectures in pnpm-workspace.yaml covers them.",
    ]);
  }

  const violations = findViolations(packages);
  if (violations.length > 0) {
    fail([
      `License check failed: ${violations.length} package(s) have a license that is not acceptable.`,
      ...violations.map(
        (v) => `  - ${v.id}: ${v.license} (failed the ${v.policy} policy)`,
      ),
      "",
      "Production dependencies must be GPL-3.0-or-later compatible (scripts/lib/licenses.ts,",
      "PRODUCTION_LICENSES). Development dependencies only need a free license.",
      "Remove the package, or review its license and add it to the list with a reason.",
    ]);
  }

  const production = packages.filter((p) => p.production).length;
  console.log(
    `License check passed: ${workspace.length} workspace packages and ${packages.length} third-party packages checked (${production} production, ${packages.length - production} development).`,
  );
}

main();
