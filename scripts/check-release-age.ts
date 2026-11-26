// SPDX-License-Identifier: GPL-3.0-or-later

// Checks that every third-party package version in pnpm-lock.yaml (both documents,
// so pnpm itself as well) was published at least two weeks ago, unless it is listed
// in scripts/lib/release-age-exceptions.ts. Also checks pnpm's own release-age
// settings in pnpm-workspace.yaml. The rules are in scripts/lib/release-age.ts.
//
// Publish times come from the npm registry (https://registry.npmjs.org). A publish
// time never changes, so each one is cached in node_modules/.cache (ignored by git)
// and fetched only once per machine.
//
// Usage: node scripts/check-release-age.ts [--offline]   (or `pnpm check:release-age`)
//
// Without network access the check fails. Locally, --offline (or the environment
// variable GALATSA_CHECK_OFFLINE=1) checks only the cached times and skips the rest
// with a warning. In CI (the CI environment variable is set) offline mode is refused.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describeSource, parseLockfile, type Lockfile } from "./lib/lockfile.ts";
import {
  checkSettings,
  evaluateAges,
  MINIMUM_AGE_DAYS,
  packumentUrl,
  publishTimeOf,
  splitPackageId,
  type ReleaseAgeSettings,
} from "./lib/release-age.ts";
import { RELEASE_AGE_EXCEPTIONS } from "./lib/release-age-exceptions.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = join(
  root,
  "node_modules",
  ".cache",
  "release-age",
  "publish-times.json",
);

/** A generic client name; nothing about the user or the machine is sent. */
const USER_AGENT = "release-age-check";
const CONCURRENCY = 8;
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function readLockfile(): Lockfile {
  try {
    return parseLockfile(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  } catch (error) {
    fail([`Release-age check could not read pnpm-lock.yaml: ${String(error)}`]);
  }
}

function readSettings(): ReleaseAgeSettings {
  try {
    const settings: unknown = parse(
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    );
    return settings !== null && typeof settings === "object"
      ? (settings as ReleaseAgeSettings)
      : {};
  } catch (error) {
    fail([`Release-age check could not read pnpm-workspace.yaml: ${String(error)}`]);
  }
}

function readCache(): Map<string, string> {
  if (!existsSync(cachePath)) return new Map();
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as {
      times?: Record<string, unknown>;
    };
    return new Map(
      Object.entries(data.times ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map(); // a broken cache is refetched
  }
}

function writeCache(times: ReadonlyMap<string, string>): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const sorted = Object.fromEntries([...times].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(cachePath, `${JSON.stringify({ times: sorted }, null, 2)}\n`);
  } catch (error) {
    console.warn(`Release-age check could not write its cache: ${String(error)}`);
  }
}

async function fetchPackument(name: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(packumentUrl(name), {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) throw new Error("not found in the registry (404)");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (String(error).includes("404")) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Fetches the publish times of the given ids, grouped by package name. */
async function fetchTimes(
  ids: readonly string[],
): Promise<{ times: Map<string, string>; errors: string[] }> {
  const byName = new Map<string, string[]>();
  for (const id of ids) {
    const { name, version } = splitPackageId(id);
    byName.set(name, [...(byName.get(name) ?? []), version]);
  }
  const names = [...byName.keys()];
  const times = new Map<string, string>();
  const errors: string[] = [];
  const worker = async (): Promise<void> => {
    for (let name = names.pop(); name !== undefined; name = names.pop()) {
      try {
        const packument = await fetchPackument(name);
        for (const version of byName.get(name) ?? []) {
          const time = publishTimeOf(packument, version);
          if (time === undefined) {
            errors.push(`${name}@${version}: the registry has no publish time for it`);
          } else {
            times.set(`${name}@${version}`, time);
          }
        }
      } catch (error) {
        const cause = (error as { cause?: unknown }).cause;
        errors.push(`${name}: ${String(error)}${cause ? ` (${String(cause)})` : ""}`);
        // No connection at all (as opposed to an HTTP error): stop asking.
        if (error instanceof TypeError || String(error).includes("TimeoutError")) {
          names.length = 0;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { times, errors };
}

function warnLoudly(lines: readonly string[]): void {
  const bar = "!".repeat(78);
  console.warn([bar, ...lines.map((line) => `!! ${line}`), bar].join("\n"));
}

async function main(): Promise<void> {
  const offline =
    process.argv.slice(2).includes("--offline") ||
    isSet(process.env["GALATSA_CHECK_OFFLINE"]);
  const ci = isSet(process.env["CI"]);
  if (offline && ci) {
    fail([
      "Release-age check: offline mode is not allowed in CI (the CI environment variable is set).",
      "The check needs the npm registry there.",
    ]);
  }

  const lockfile = readLockfile();
  const problems = checkSettings(readSettings(), RELEASE_AGE_EXCEPTIONS);

  // Every third-party package, including pnpm itself from the boot document.
  const ids = new Set([...lockfile.packageIds, ...lockfile.bootPackageIds]);
  const registryIds: string[] = [];
  for (const id of ids) {
    const source = lockfile.sources.get(id);
    const outside = source === undefined ? undefined : describeSource(id, source);
    if (outside === undefined) registryIds.push(id);
    else problems.push(`${outside}, so it has no registry publish date.`);
  }

  const cache = readCache();
  const missing = registryIds.filter((id) => !cache.has(id));
  let fetched = 0;
  let skipped: string[] = [];
  if (missing.length > 0 && offline) {
    skipped = missing;
  } else if (missing.length > 0) {
    const { times, errors } = await fetchTimes(missing);
    fetched = times.size;
    for (const [id, time] of times) cache.set(id, time);
    if (times.size > 0) writeCache(cache);
    if (errors.length > 0) {
      fail([
        `Release-age check could not get the publish time of ${errors.length} package(s) from the npm registry:`,
        ...errors.slice(0, 20).map((line) => `  - ${line}`),
        ...(errors.length > 20 ? [`  - ... and ${errors.length - 20} more`] : []),
        "",
        "The check needs network access to https://registry.npmjs.org for versions it has not",
        "seen before. Times that were fetched are cached, so a later run only asks for the rest.",
        ci
          ? "This is CI, where the check must not be skipped."
          : "Without network access, run `pnpm check:release-age --offline` (or set GALATSA_CHECK_OFFLINE=1) to skip them with a warning.",
      ]);
    }
  }

  const times = new Map(
    registryIds.flatMap((id) => {
      const time = cache.get(id);
      return time === undefined ? [] : [[id, time] as const];
    }),
  );
  const result = evaluateAges(ids, times, new Date(), RELEASE_AGE_EXCEPTIONS);
  problems.push(...result.problems);
  for (const entry of result.young) {
    problems.push(
      `${entry.id} was published ${entry.published.slice(0, 10)}, ${entry.ageDays} day(s) ago.`,
    );
  }

  if (skipped.length > 0) {
    warnLoudly([
      `OFFLINE: the release age of ${skipped.length} package version(s) was NOT checked,`,
      "because their publish times are not cached and the registry was not asked.",
      "Run the check again with network access before you push.",
    ]);
  }
  for (const id of result.removable) {
    console.warn(
      `Release-age check: ${id} is ${MINIMUM_AGE_DAYS} days old now. Remove its exception and its minimumReleaseAgeExclude entry.`,
    );
  }
  for (const entry of result.excepted) {
    console.warn(
      `Release-age check: ${entry.id} is ${entry.ageDays} day(s) old, allowed by an exception.`,
    );
  }
  if (problems.length > 0) {
    fail([
      `Release-age check failed: ${problems.length} problem(s).`,
      ...problems.map((problem) => `  - ${problem}`),
      "",
      `Third-party package versions must be at least ${MINIMUM_AGE_DAYS} days old. Choose an older`,
      "version, or wait. An exception needs a reason in scripts/lib/release-age-exceptions.ts.",
    ]);
  }
  const checked = registryIds.length - skipped.length;
  console.log(
    skipped.length > 0
      ? `Release-age check passed for the ${checked} cached package versions only; ${skipped.length} were skipped (offline).`
      : `Release-age check passed: ${checked} package versions are at least ${MINIMUM_AGE_DAYS} days old (${fetched} fetched from the registry, ${checked - fetched} from the cache).`,
  );
}

await main();
