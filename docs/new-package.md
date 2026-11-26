# Adding a workspace package

`pnpm check` runs `scripts/check-workspace.ts`, which enforces the rules below. The quickest start is to copy `packages/core` and rename it.

## Where it goes

- `packages/<name>` or `packages/extensions/<name>`: a library that other packages import.
- `apps/<name>`: a program (web or desktop).
- `bench` and `tests/e2e`: tooling. No other places are allowed.

`pnpm-workspace.yaml` already lists these folders, so a new folder with a `package.json` is picked up after `pnpm install`.

## package.json

- `"private": true`.
- `"license"`: `"GPL-3.0-or-later"`. Only `packages/server` uses `"AGPL-3.0-or-later"`, and no other package may depend on it.
- Scripts: `typecheck` (`tsc -p tsconfig.json`) in every package; `build` in libraries and apps.
- Libraries: `exports` with `"@galatsa/source": "./src/index.ts"` as the first condition of every entry, then `types` and `default` pointing at `dist/`. The source condition lets other packages, tests and Node scripts use the package without building it first.
- Declare every package you import, in this package's own `package.json`. Importing a package that only the root or another package declares fails the check, even if it happens to resolve. Use `"workspace:*"` for other workspace packages and `"catalog:"` for versions shared in `pnpm-workspace.yaml` (for example `vitest`).
- Every dependency of a workspace package counts as production for the license check, whatever field lists it, because it may end up in the shipped program. Its license must be compatible with GPL-3.0-or-later. Only the root's `devDependencies` (repository tooling) are development-only.

## TypeScript

- `tsconfig.json` extends `../../tsconfig.base.json`, sets `"noEmit": true` and includes `src/**` with the tests. The base has no environment: add `"DOM"` and `"DOM.Iterable"` to `lib` in browser packages, and `"node"` to `types` in Node code. Code and tests of a package share one environment.
- Libraries also have `tsconfig.build.json`, extending `../../tsconfig.build.base.json` with `rootDir`, `outDir` and `include`. Do not set `exclude`: the shared one keeps test files out of `dist/`.
- Relative imports name the file with its extension: `import { x } from "./x.ts"`.
- A package with a `vite.config.ts` spreads `workspaceSourceResolve` from `../../vite.shared.ts` into its config, so Vite also reads workspace packages from source.

## Running code with Node

Node can run `.ts` files directly. To load workspace packages from source, pass the condition:

```sh
node --conditions=@galatsa/source src/main.ts
```

Put this in a `package.json` script (see `bench/package.json`). Node cannot load `.tsx` or `.jsx` files, so code that Node runs (the root's `scripts/` and `bench`) must not depend on a package that has them; the workspace check enforces this.

## Headers

Every source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later` (`/* ... */` in CSS, `<!-- ... -->` in HTML). Under `packages/server` the identifier is `AGPL-3.0-or-later`.
