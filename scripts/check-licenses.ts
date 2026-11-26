// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the license of every third-party JavaScript package in the lockfile: direct
// and transitive dependencies of every workspace package, optional and platform
// packages for every operating system included. Which packages are production and
// which are development-only is worked out from pnpm-lock.yaml
// (scripts/lib/lockfile.ts); the license policies are in scripts/lib/licenses.ts.
// The licenses themselves come from `pnpm licenses list`.
//
// The project's own workspace packages are checked by scripts/check-workspace.ts.
//
// Usage: node scripts/check-licenses.ts   (or `pnpm check:licenses`)
// Exits with 1 if a license is not acceptable, if nothing is installed, if a lockfile
// package is missing from the report, if a package does not come from the npm
// registry, if a link: or file: dependency leaves the workspace, or if the
// classification disagrees with pnpm's own.
//
// The script runs main() unconditionally (no "is this the main module" guard), so it
// behaves the same when started through a symlink or another path spelling.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findViolations,
  flattenReport,
  type LicenseReport,
  type PackageLicense,
} from "./lib/licenses.ts";
import {
  classifyPackages,
  describeSource,
  parseLockfile,
  resolveTarget,
  type Lockfile,
} from "./lib/lockfile.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** Runs `pnpm licenses list` for all workspace packages and returns the report. */
function readLicenseReport(extraArgs: string): LicenseReport {
  const args = `licenses list --json --recursive ${extraArgs}`.trim();
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
  try {
    return JSON.parse(result.stdout) as LicenseReport;
  } catch {
    fail([`License check could not read the output of "pnpm ${args}" as JSON.`]);
  }
}

function readLockfile(): Lockfile {
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(lockPath))
    fail(["License check needs pnpm-lock.yaml. Run pnpm install first."]);
  let lockfile: Lockfile;
  try {
    lockfile = parseLockfile(readFileSync(lockPath, "utf8"));
  } catch (error) {
    fail([`License check could not read pnpm-lock.yaml: ${String(error)}`]);
  }
  if (lockfile.hasConfigDependencies) {
    fail([
      "pnpm-lock.yaml lists pnpm config dependencies (configDependencies).",
      "The license check does not cover them yet. Extend scripts/check-licenses.ts first.",
    ]);
  }
  return lockfile;
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

  const lockfile = readLockfile();
  const { production, development, problems } = classifyPackages(lockfile);
  if (problems.length > 0) {
    fail(["License check failed:", ...problems.map((problem) => `  - ${problem}`)]);
  }

  // pnpm reports a package from git, a tarball or a folder under the version in its
  // package.json, not under its lockfile id, so it could not be matched below. Such
  // packages also have no registry publish date for the release-age check.
  const outsideRegistry = [...lockfile.packageIds].flatMap((id) => {
    const source = lockfile.sources.get(id);
    const description = source === undefined ? undefined : describeSource(id, source);
    return description === undefined ? [] : [description];
  });
  if (outsideRegistry.length > 0) {
    fail([
      `License check failed: ${outsideRegistry.length} package(s) do not come from the npm registry.`,
      ...outsideRegistry.map((line) => `  - ${line}`),
      "Only registry packages are supported, because the license and release-age checks",
      'rely on registry metadata. Use "workspace:*" for the project\'s own packages and a',
      "published registry version for third-party packages.",
    ]);
  }

  const all = flattenReport(readLicenseReport(""));
  if (all.length === 0) {
    fail([
      "License check found no dependencies to check.",
      "Run pnpm install first. An empty result is not a pass.",
    ]);
  }

  // Sanity checks on the classification, so that a change in pnpm or in the lockfile
  // format cannot quietly turn production packages into development ones.
  const insane: string[] = [];
  // 1. Every direct dependency of every workspace package except the root's
  //    devDependencies is production.
  for (const importer of lockfile.importers) {
    for (const dependency of importer.dependencies) {
      if (importer.path === "." && dependency.field === "devDependencies") continue;
      const target = resolveTarget(importer.path, dependency.name, dependency.version);
      if (target.kind === "link") continue;
      const id = target.key.replace(/\(.*$/, "");
      if (!production.has(id)) {
        insane.push(
          `${dependency.name} (${dependency.field} of ${importer.path}) is not production`,
        );
      }
    }
  }
  // 2. Everything pnpm itself calls production is production here too.
  for (const { id } of flattenReport(readLicenseReport("--prod"))) {
    if (!production.has(id)) insane.push(`${id} is production for pnpm but not here`);
  }
  // 3. Every package in the lockfile is classified.
  for (const id of lockfile.packageIds) {
    if (!production.has(id) && !development.has(id))
      insane.push(`${id} is not reachable`);
  }
  if (insane.length > 0) {
    fail([
      "License check could not trust its production/development classification:",
      ...insane.map((line) => `  - ${line}`),
      "See scripts/lib/lockfile.ts.",
    ]);
  }

  // Every lockfile package (all platforms, optional packages included) must be in the
  // report. Otherwise a package could be skipped without anyone noticing.
  const reported = new Set(all.map((entry) => entry.id));
  const unverified = [...lockfile.packageIds].filter((id) => !reported.has(id));
  if (unverified.length > 0) {
    fail([
      `License check could not read the license of ${unverified.length} lockfile package(s):`,
      ...unverified.map((id) => `  - ${id}`),
      "They are not installed. Check that supportedArchitectures in pnpm-workspace.yaml covers them.",
    ]);
  }

  const packages: PackageLicense[] = all.map((entry) => ({
    ...entry,
    production: production.has(entry.id),
  }));
  const violations = findViolations(packages);
  if (violations.length > 0) {
    fail([
      `License check failed: ${violations.length} package(s) have a license that is not acceptable.`,
      ...violations.map(
        (v) => `  - ${v.id}: ${v.license} (failed the ${v.policy} policy)`,
      ),
      "",
      "Production dependencies (any dependency of a workspace package other than the root's",
      "devDependencies) must be GPL-3.0-or-later compatible (scripts/lib/licenses.ts,",
      "PRODUCTION_LICENSES). The root's devDependencies only need a free license.",
      "Remove the package, or review its license and add it to the list with a reason.",
    ]);
  }

  const productionCount = packages.filter((p) => p.production).length;
  console.log(
    `License check passed: ${packages.length} third-party packages checked (${productionCount} production, ${packages.length - productionCount} development).`,
  );
}

main();
