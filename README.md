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

`pnpm check` runs, in order: type checking, linting, format checking, the license header check, the workspace check, the translation check, unit tests and the dependency license check. It exits with a non-zero code on the first failure. It does not need `pnpm build` first: workspace packages import each other from source (see `tsconfig.base.json`). GitHub Actions runs `pnpm check` and then `pnpm build` on Linux, Windows and macOS.

The dependency license check covers the JavaScript dependencies of every workspace package, including the optional platform packages for every operating system. To make that possible, `pnpm-workspace.yaml` tells pnpm to install the platform packages for all systems, not only the current one. Every dependency of a workspace package counts as production and must be compatible with GPL-3.0-or-later. The root's `devDependencies` (repository tooling) only need a free license. Rust crates (the Tauri desktop app, later) are not covered: they will need their own check, added when Rust code arrives.

`pnpm check` also runs the workspace check, which enforces the rules for the project's own packages. See [docs/new-package.md](docs/new-package.md) before adding one.

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
