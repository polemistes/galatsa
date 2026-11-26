# Galatsa

Galatsa is a presentation program built around an infinite canvas. The presenter moves a camera across the canvas and saves routes of camera stops, so a presentation is a path through one large picture. Presentations are meant to work fully offline and without an account.

Galatsa is licensed under the GNU General Public License, version 3 or later (GPL-3.0-or-later). See [LICENSE](LICENSE).

## Requirements

- Node.js 24 or newer. The check scripts are TypeScript files that Node runs directly. On Node 24 this prints an "ExperimentalWarning" about type stripping, which is harmless.
- pnpm 12, the version named in the `packageManager` field of `package.json`. Install it with `npm install -g pnpm@12`, or with one of the other methods on [pnpm.io/installation](https://pnpm.io/installation). If a different pnpm version is installed, pnpm switches to the pinned version by itself.

## Running the checks

```sh
pnpm install
pnpm check
```

`pnpm check` runs, in order: type checking, linting, format checking, the license header check, the workspace check, the translation check, unit tests, the dependency license check and the release-age check. It exits with a non-zero code on the first failure. It does not need `pnpm build` first: workspace packages import each other from source (see `tsconfig.base.json`). GitHub Actions runs `pnpm check` and then `pnpm build` on Linux, Windows and macOS.

The dependency license check covers the JavaScript dependencies of every workspace package, including the optional platform packages for every operating system. To make that possible, `pnpm-workspace.yaml` tells pnpm to install the platform packages for all systems, not only the current one. Every dependency of a workspace package counts as production and must be compatible with GPL-3.0-or-later. The root's `devDependencies` (repository tooling) only need a free license. The license lists and the sources behind them are described in [docs/adr/0002-kontroll-av-forutsetninger.md](docs/adr/0002-kontroll-av-forutsetninger.md) (in Norwegian).

Two things are deliberately not covered yet. Rust crates (the Tauri desktop app, later) need their own license check, added when Rust code arrives. And the planned licensing exception for the player can only cover the project's own code, so the player may need a stricter list than the rest of the program, with permissive licenses only; that list is decided when the exception is written.

The release-age check enforces the project rule that a third-party package version is used only after it has been published for at least two weeks. pnpm applies the same rule when it resolves versions (`minimumReleaseAge` in `pnpm-workspace.yaml`); the check verifies every version in `pnpm-lock.yaml`, pnpm itself included, against the publish dates in the npm registry, and fails on any `minimumReleaseAgeExclude` entry that is not a listed exception (`scripts/lib/release-age-exceptions.ts`). It needs network access the first time; the dates are cached in `node_modules/.cache`. Without a network, `GALATSA_CHECK_OFFLINE=1 pnpm check` (or `pnpm check:release-age --offline`) skips the dates that are not cached, with a warning. In CI the check never skips. A run counts as CI when `CI` is set to anything but empty, `0` or `false`, or when a variable that the CI service sets itself is present (`GITHUB_ACTIONS` on GitHub Actions, which a workflow cannot overwrite), whatever `CI` says (`scripts/lib/ci.ts`). With `minimumReleaseAge` set, pnpm also checks the lockfile against registry data on `pnpm install`, so installing without a network may fail when pnpm has not cached that data. Registry requests that fail with a rate limit or a server error are retried with increasing waits.

The two-week rule covers only the dependencies the project chooses and bundles (npm packages now, Rust crates later). System libraries from a Linux distribution (for example webkit2gtk or gtk) are tested by the distribution and always accepted, however new they are; the check never sees them. A distribution package build (PKGBUILD, deb, rpm) should not run the release-age check: setting `GALATSA_DISTRIBUTION_BUILD=1` makes `pnpm check` skip it, and `pnpm_config_minimum_release_age=0` turns off pnpm's own rule for that build (pnpm 12 reads its settings from `pnpm_config_*` environment variables). In CI the check fails if either is set, and also for the upper-case spelling `PNPM_CONFIG_MINIMUM_RELEASE_AGE`, which pnpm honours too, and the other `minimum_release_age` variables.

`pnpm check` also runs the workspace check, which enforces the rules for the project's own packages. See [docs/new-package.md](docs/new-package.md) before adding one. Only `packages/server` is licensed AGPL-3.0-or-later, and nothing from it may reach the shipped program: besides the workspace check, every Vite build contains a guard that fails the build when anything from `packages/server` would be bundled (`scripts/lib/agpl-guard.ts`), and the workspace check fails when a Vite or Vitest config lacks it.

Other scripts:

| Script        | What it does                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`  | Builds all packages that have a `build` script                                                                                                                                                                                                                           |
| `pnpm test`   | Runs unit tests with Vitest                                                                                                                                                                                                                                              |
| `pnpm e2e`    | Runs end-to-end tests with Playwright. Needs `pnpm --filter @galatsa/e2e exec playwright install chromium` the first time. Not part of `pnpm check`. Includes the benchmark repeatability check, which takes about two minutes (see [bench/README.md](bench/README.md)). |
| `pnpm format` | Formats the repository with Prettier                                                                                                                                                                                                                                     |

## Repository layout

```
packages/   core, renderer, format, player, editor, i18n, extensions, server
apps/       web, desktop
bench/      performance measurements
tests/e2e/  end-to-end tests
docs/adr/   decision records
scripts/    project checks
```
