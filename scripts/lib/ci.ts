// SPDX-License-Identifier: GPL-3.0-or-later

// Recognising a CI run, for checks that must not be skipped there.
//
// CI=true is the common signal, but a workflow step can change it for the steps
// after it (for example `echo CI=false >> $GITHUB_ENV`). GitHub Actions does not
// let a workflow overwrite its own GITHUB_* variables, and GITHUB_ACTIONS is always
// "true" there (https://docs.github.com/en/actions/reference/workflows-and-actions/variables,
// checked 2026-11-26). So a run counts as CI when CI is set to anything but "",
// "0" or "false", or when any of the service variables below is set to anything
// at all, whatever CI says. The variables of the other services are listed from
// memory, as an extra: the project's CI is GitHub Actions.

/** Variables that CI services set, each with the service it belongs to. */
export const CI_SERVICE_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["GITHUB_ACTIONS", "GitHub Actions"],
  ["GITLAB_CI", "GitLab CI"],
  ["BUILDKITE", "Buildkite"],
  ["CIRCLECI", "CircleCI"],
  ["TRAVIS", "Travis CI"],
  ["TF_BUILD", "Azure Pipelines"],
  ["JENKINS_URL", "Jenkins"],
  ["TEAMCITY_VERSION", "TeamCity"],
  ["APPVEYOR", "AppVeyor"],
  ["BITBUCKET_BUILD_NUMBER", "Bitbucket Pipelines"],
  ["CODEBUILD_BUILD_ID", "AWS CodeBuild"],
  ["DRONE", "Drone"],
  ["CIRRUS_CI", "Cirrus CI"],
  ["SEMAPHORE", "Semaphore"],
];

type Environment = Readonly<Record<string, string | undefined>>;

/** True for a switch variable that is on: set, and not "", "0" or "false". */
export function isOn(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * Why this run counts as CI ("the CI environment variable is set", "GITHUB_ACTIONS
 * is set (GitHub Actions ...)"), or undefined if it does not.
 */
export function ciReason(env: Environment): string | undefined {
  for (const [name, service] of CI_SERVICE_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== "") return `${name} is set (${service})`;
  }
  if (isOn(env["CI"])) return "the CI environment variable is set";
  return undefined;
}

/**
 * Environment variables that change pnpm's release-age settings
 * (minimumReleaseAge, minimumReleaseAgeExclude, minimumReleaseAgeStrict, ...).
 * pnpm 12 reads pnpm_config_minimum_release_age and its upper-case spelling
 * PNPM_CONFIG_MINIMUM_RELEASE_AGE; any letter case and separator is matched here,
 * to be safe.
 */
export function releaseAgeOverrides(env: Environment): string[] {
  return Object.keys(env)
    .filter((name) => /^pnpm[_-]config[_-]minimum[_-]?release[_-]?age/i.test(name))
    .sort();
}
