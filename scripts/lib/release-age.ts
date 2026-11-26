// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the release-age check (scripts/check-release-age.ts).
//
// Project rule: a third-party package version is used only after it has been
// published for at least two weeks. A new release has had little time for anyone to
// notice a mistake or a malicious change, so waiting lowers the risk of pulling one
// in. pnpm enforces the same rule while it resolves versions (minimumReleaseAge in
// pnpm-workspace.yaml); this check verifies the lockfile itself, so the rule also
// holds if the setting is changed, weakened by an exclude entry, or bypassed.
//
// Exceptions are listed, with a reason, in scripts/lib/release-age-exceptions.ts.

/** Minimum age of a third-party package version, in days. */
export const MINIMUM_AGE_DAYS = 14;

/** The same age in minutes, the unit of pnpm's minimumReleaseAge setting. */
export const MINIMUM_AGE_MINUTES = MINIMUM_AGE_DAYS * 24 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReleaseAgeException {
  readonly name: string;
  /** One exact version. */
  readonly version: string;
  /** Why this version cannot wait. Required. */
  readonly reason: string;
}

/** "@scope/name@1.2.3" -> { name: "@scope/name", version: "1.2.3" }. */
export function splitPackageId(id: string): { name: string; version: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) throw new Error(`not a package id: ${id}`);
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

/** URL of a package's full registry metadata, which has the publish time of each version. */
export function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

/** The publish time of a version from registry metadata, or undefined if it is missing. */
export function publishTimeOf(packument: unknown, version: string): string | undefined {
  if (packument === null || typeof packument !== "object") return undefined;
  const time = (packument as { time?: unknown }).time;
  if (time === null || typeof time !== "object") return undefined;
  const value = (time as Record<string, unknown>)[version];
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

export interface YoungPackage {
  readonly id: string;
  readonly published: string;
  /** Age in whole days, rounded down. */
  readonly ageDays: number;
}

export interface AgeResult {
  /** Younger than the minimum and not excepted: the check fails. */
  readonly young: readonly YoungPackage[];
  /** Younger than the minimum, but listed as an exception. */
  readonly excepted: readonly YoungPackage[];
  /** Problems with the exception list itself. */
  readonly problems: readonly string[];
  /** Exceptions that are old enough now and can be removed. */
  readonly removable: readonly string[];
}

/**
 * Compares publish times with the minimum age. `times` maps every package id that
 * was checked to its publish time; `ids` is every package id in the lockfile.
 */
export function evaluateAges(
  ids: ReadonlySet<string>,
  times: ReadonlyMap<string, string>,
  now: Date,
  exceptions: readonly ReleaseAgeException[],
): AgeResult {
  const problems: string[] = [];
  const excepted = new Set<string>();
  for (const exception of exceptions) {
    const id = `${exception.name}@${exception.version}`;
    if (exception.reason.trim() === "") {
      problems.push(`The release-age exception for ${id} has no reason.`);
    }
    if (!ids.has(id)) {
      problems.push(
        `The release-age exception for ${id} is not in pnpm-lock.yaml any more. Remove it.`,
      );
    }
    excepted.add(id);
  }

  const young: YoungPackage[] = [];
  const youngExcepted: YoungPackage[] = [];
  const removable: string[] = [];
  for (const [id, published] of times) {
    const ageMs = now.getTime() - Date.parse(published);
    const old = ageMs >= MINIMUM_AGE_DAYS * DAY_MS;
    if (old) {
      if (excepted.has(id)) removable.push(id);
      continue;
    }
    const entry = { id, published, ageDays: Math.max(0, Math.floor(ageMs / DAY_MS)) };
    (excepted.has(id) ? youngExcepted : young).push(entry);
  }
  young.sort((a, b) => a.id.localeCompare(b.id));
  return { young, excepted: youngExcepted, problems, removable: removable.sort() };
}

/** The parts of pnpm-workspace.yaml that this check reads. */
export interface ReleaseAgeSettings {
  readonly minimumReleaseAge?: unknown;
  readonly minimumReleaseAgeExclude?: unknown;
  readonly minimumReleaseAgeStrict?: unknown;
}

/**
 * Checks pnpm's own release-age settings: minimumReleaseAge must be at least the
 * project minimum, strict mode must not be turned off, and every exclude entry must
 * name exact versions that are listed as exceptions (pnpm can add entries by itself).
 */
export function checkSettings(
  settings: ReleaseAgeSettings,
  exceptions: readonly ReleaseAgeException[],
): string[] {
  const problems: string[] = [];
  const age = settings.minimumReleaseAge;
  if (typeof age !== "number" || age < MINIMUM_AGE_MINUTES) {
    problems.push(
      `pnpm-workspace.yaml: minimumReleaseAge is ${JSON.stringify(age)}, must be at least ${MINIMUM_AGE_MINUTES} (${MINIMUM_AGE_DAYS} days in minutes).`,
    );
  }
  if (settings.minimumReleaseAgeStrict === false) {
    problems.push(
      "pnpm-workspace.yaml: minimumReleaseAgeStrict is false, which lets pnpm install a younger version when no old enough one matches. Remove the setting.",
    );
  }
  const excluded = settings.minimumReleaseAgeExclude;
  if (excluded === undefined || excluded === null) return problems;
  if (!Array.isArray(excluded)) {
    return [...problems, "pnpm-workspace.yaml: minimumReleaseAgeExclude must be a list."];
  }
  const allowed = new Set(exceptions.map((e) => `${e.name}@${e.version}`));
  for (const entry of excluded) {
    const text = String(entry);
    const match = /^((?:@[^/@\s]+\/)?[^/@\s]+)@(.+)$/.exec(text.trim());
    const name = match?.[1];
    const versions = (match?.[2] ?? "").split("||").map((version) => version.trim());
    const exact = (version: string): boolean =>
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version);
    const covered =
      name !== undefined &&
      !name.includes("*") &&
      versions.every((version) => exact(version) && allowed.has(`${name}@${version}`));
    if (!covered) {
      problems.push(
        `pnpm-workspace.yaml: minimumReleaseAgeExclude has "${text}", which is not a listed exception. ` +
          "pnpm may add such entries by itself. Remove it, or add each exact version with a reason to scripts/lib/release-age-exceptions.ts.",
      );
    }
  }
  return problems;
}

/** True for registry answers worth asking again: rate limits and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * How long to wait before attempt `attempt + 1` after attempt `attempt` failed
 * (attempt counts from 1): exponential backoff from one second, with up to a
 * quarter of random jitter so parallel workers do not retry in step. A
 * Retry-After header from the registry (seconds, or an HTTP date) is honoured
 * when it asks for longer. Never more than 30 seconds.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null = null,
  now: number = Date.now(),
  random: () => number = Math.random,
): number {
  const MAX = 30_000;
  const backoff = 1000 * 2 ** (attempt - 1);
  const jittered = backoff * (1 + random() / 4);
  let asked = 0;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) asked = seconds * 1000;
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) asked = date - now;
    }
  }
  return Math.round(Math.min(MAX, Math.max(jittered, asked)));
}
