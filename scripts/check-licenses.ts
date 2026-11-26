// SPDX-License-Identifier: GPL-3.0-or-later

// Checks the license of every installed dependency of every workspace package,
// including optional dependencies and transitive dependencies. Policies are in
// scripts/lib/licenses.ts.
//
// Usage: node scripts/check-licenses.ts   (or `pnpm check:licenses`)
// Exits with 1 if a license is not acceptable, if the list of dependencies is empty,
// or if a lockfile entry is missing from the report.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findViolations,
  flattenReport,
  isPackageManagerEntry,
  normalizeLockKey,
  type LicenseReport,
  type PackageLicense,
} from "./lib/licenses.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** Runs `pnpm licenses list` and returns the parsed report. Fails the check on error. */
function readLicenseReport(extraArgs: readonly string[]): LicenseReport {
  // "shell: true" so that the pnpm command is found on Windows as well.
  const result = spawnSync(
    `pnpm licenses list --json --recursive ${extraArgs.join(" ")}`,
    {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    fail([
      `License check could not run "pnpm licenses list ${extraArgs.join(" ")}".`,
      result.stderr || String(result.error ?? ""),
    ]);
  }
  try {
    return JSON.parse(result.stdout) as LicenseReport;
  } catch {
    fail(["License check could not read the output of pnpm licenses list as JSON."]);
  }
}

/**
 * Collects "name@version" ids of every package in pnpm-lock.yaml, for all platforms.
 * The lockfile may hold several YAML documents (pnpm writes an environment document
 * too), so every "packages:" section is read.
 */
function readLockfileIds(): Set<string> {
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(lockPath))
    fail(["License check needs pnpm-lock.yaml. Run pnpm install first."]);
  const ids = new Set<string>();
  for (const document of readFileSync(lockPath, "utf8").split(/^---$/m)) {
    const section = document.split(/^packages:\n/m)[1];
    if (section === undefined) continue;
    const body = section.split(/^\S/m)[0] ?? "";
    for (const match of body.matchAll(/^ {2}(\S.*?):\s*$/gm)) {
      ids.add(normalizeLockKey(match[1] ?? ""));
    }
  }
  return ids;
}

function main(): void {
  const all = flattenReport(readLicenseReport([]));
  const productionIds = new Set(
    flattenReport(readLicenseReport(["--prod"])).map((e) => e.id),
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
  const unverified = [...readLockfileIds()].filter(
    (id) => !reported.has(id) && !isPackageManagerEntry(id),
  );
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
    `License check passed: ${packages.length} packages checked (${production} production, ${packages.length - production} development).`,
  );
}

main();
