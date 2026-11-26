# Galatsa

Galatsa is a presentation program built around an infinite canvas. The presenter moves a camera across the canvas and saves routes of camera stops, so a presentation is a path through one large picture. Presentations are meant to work fully offline and without an account.

Galatsa is licensed under the GNU General Public License, version 3 or later (GPL-3.0-or-later). See [LICENSE](LICENSE).

## Requirements

- Node.js 22.12 or newer
- pnpm, the version named in the `packageManager` field of `package.json` (run `corepack enable` or install it with `npm install -g pnpm`)

## Running the checks

```sh
pnpm install
pnpm check
```

`pnpm check` runs, in order: type checking, linting, format checking, the license header check, unit tests and the dependency license check. It exits with a non-zero code on the first failure. The same command runs on Linux, Windows and macOS in GitHub Actions.

Other scripts:

| Script        | What it does                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`  | Builds all packages that have a `build` script                                                                                 |
| `pnpm test`   | Runs unit tests with Vitest                                                                                                    |
| `pnpm e2e`    | Runs end-to-end tests with Playwright. Needs `pnpm exec playwright install chromium` the first time. Not part of `pnpm check`. |
| `pnpm format` | Formats the repository with Prettier                                                                                           |

## Repository layout

```
packages/   core, renderer, format, player, editor, i18n, extensions, server
apps/       web, desktop
bench/      performance measurements
tests/e2e/  end-to-end tests
docs/adr/   decision records
scripts/    project checks
plan/       development plan
```
