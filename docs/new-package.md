# Adding a workspace package

`pnpm check` runs `scripts/check-workspace.ts`, which enforces the rules below. The quickest start is to copy `packages/core` and rename it.

## Where it goes

- `packages/<name>` or `packages/extensions/<name>`: a library that other packages import.
- `apps/<name>`: a program (web or desktop).
- `bench` and `tests/e2e`: tooling. No other places are allowed.

`pnpm-workspace.yaml` already lists these folders, so a new folder with a `package.json` is picked up after `pnpm install`.

## package.json

- `"private": true`.
- `"license"`: `"GPL-3.0-or-later"`. Only `packages/server` uses `"AGPL-3.0-or-later"`, and nothing else may reach it: not by name, not under another name (`"srv": "workspace:@galatsa/server@*"`), not through a `link:`, `file:` or `workspace:` path, not through an override in `pnpm-workspace.yaml`, and not with a relative import.
- Scripts: `typecheck` (`tsc -p tsconfig.json`) in every package; `build` in libraries and apps.
- Libraries: `exports` with `"@galatsa/source": "./src/index.ts"` as the first condition of every entry, then `types` and `default` pointing at `dist/`. The source condition lets other packages, tests and Node scripts use the package without building it first. The one entry without it is `"./package.json": "./package.json"`, which is allowed.
- Targets in `exports` and `imports` (`"#name"` mappings) are `./` paths inside the package. A package named in `imports` must be declared like any other dependency.
- Declare every package you import, in this package's own `package.json`. Importing a package that only the root or another package declares fails the check, even if it happens to resolve. Use `"workspace:*"` for other workspace packages and `"catalog:"` for versions shared in `pnpm-workspace.yaml` (for example `vitest`).
- Third-party packages come from the npm registry, in a version that is at least two weeks old (see [Dependencies](#dependencies)). Dependencies from git, from a tarball or from a folder outside the workspace are not supported.
- Every dependency of a workspace package counts as production for the license check, whatever field lists it, because it may end up in the shipped program. Its license must be compatible with GPL-3.0-or-later. Only the root's `devDependencies` (repository tooling) are development-only.

## Imports and other references

The check reads every script (`.ts`, `.tsx`, `.js` and the like), stylesheet (`.css`, `.scss`, `.less` and the like) and HTML file of the package:

- imports, `export ... from`, `import()` and `require()`;
- `@import`, `@use` and `url()` in stylesheets, `@font-face` sources included;
- `src` and `href` of `script`, `link`, `img` and media elements in HTML, and inline scripts and styles;
- `new URL("...", import.meta.url)` and `import.meta.glob("...")`.

Each reference must be one of these:

- a file inside the package's own folder. A relative path that leaves the folder (`../../shared/x.ts`) fails, even if the file exists, and so does a path into another workspace package. Share code through a workspace package instead.
- a package declared in this package's `package.json`. In a stylesheet, a bare name (`@import "x.css"`) is a file next to the stylesheet if there is one, otherwise a package; `~name` is always a package.
- a Node built-in with the `node:` prefix (`node:fs`). Without the prefix, `events` or `buffer` is the npm package of that name and must be declared.
- a URL (`https:`, `data:`) or a `#name` mapping from `imports`.

Relative imports name the file with its extension: `import { x } from "./x.ts"`.

## TypeScript

- `tsconfig.json` extends the root `tsconfig.base.json` (`../../tsconfig.base.json` from `packages/<name>`), sets `"noEmit": true` and includes `src/**` with the tests. The base has no environment: add `"DOM"` and `"DOM.Iterable"` to `lib` in browser packages, and `"node"` to `types` in Node code. Code and tests of a package share one environment.
- Libraries also have `tsconfig.build.json`, extending the root `tsconfig.build.base.json` with `rootDir`, `outDir` and `include`. Do not set `exclude`: the shared one keeps test files out of `dist/`.
- Set the same `lib` and `types` in `tsconfig.build.json` as in `tsconfig.json`. The two files extend different bases, so `tsconfig.build.json` does not see what `tsconfig.json` adds. Without `"DOM"` in both, `pnpm check` passes but `pnpm build` fails with "Cannot find name 'document'" (TS2584). The check compares the two. A browser library looks like this:

  ```jsonc
  // tsconfig.json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "noEmit": true, "lib": ["ES2023", "DOM", "DOM.Iterable"] },
    "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts", "src/**/*.cts"],
  }
  ```

  ```jsonc
  // tsconfig.build.json
  {
    "extends": "../../tsconfig.build.base.json",
    "compilerOptions": {
      "rootDir": "src",
      "outDir": "dist",
      "lib": ["ES2023", "DOM", "DOM.Iterable"],
    },
    "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts", "src/**/*.cts"],
  }
  ```

- A package with a `vite.config.ts` spreads `workspaceSourceResolve` from `../../vite.shared.ts` into its config, so Vite also reads workspace packages from source. A config file at the top of a package (`*.config.ts`) is the only place that may import `vite.shared.ts` with a relative path, and the package must then declare `vite` itself.

## Tests

`pnpm test` runs every `*.test.*` file in the repository with Vitest, from the root `vitest.config.ts`. Tests run in Node by default, without a DOM.

A browser package whose tests need `document` or `window` gets a DOM environment:

1. Add the environment package to the root's devDependencies, if it is not there yet: `pnpm add -D -w -E happy-dom`. Vitest loads it from the repository root, so the package itself does not declare it. happy-dom is the suggested choice; jsdom works the same way here. Both are MIT licensed (npm registry, versions 21.0.4 and 31.0.1, checked 2026-11-26).
2. Add the package folder to `DOM_TEST_PACKAGES` in the root `vitest.config.ts`, for example `{ "packages/renderer": "happy-dom" }`. Its tests then run in their own Vitest project with that environment.

The package declares `vitest` (`"catalog:"`) in its devDependencies, like any package with tests.

## Dependencies

- Pin exact versions (`pnpm add -E`), or use `"catalog:"` for the shared ones.
- A version must have been published at least two weeks ago. pnpm enforces this while it resolves versions (`minimumReleaseAge` in `pnpm-workspace.yaml`): a younger version makes `pnpm install` fail. `scripts/check-release-age.ts` checks every version in `pnpm-lock.yaml` against the publish dates in the npm registry, and is part of `pnpm check`.
- pnpm may offer to add a young version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Do not accept. The check fails on every entry there, unless the same version is listed with a reason in `scripts/lib/release-age-exceptions.ts`. That list is for real needs, such as a security fix that cannot wait.

## Running code with Node

Node can run `.ts` files directly. To load workspace packages from source, pass the condition:

```sh
node --conditions=@galatsa/source src/main.ts
```

Put this in a `package.json` script (see `bench/package.json`). Node cannot load `.tsx` or `.jsx` files, so code that Node runs (the root's `scripts/` and `bench`) must not depend on a package that has them; the workspace check enforces this. Test files (`*.test.tsx`) do not count, because Node never loads them from another package.

## Headers

Every source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later` (`/* ... */` in CSS, `<!-- ... -->` in HTML). Under `packages/server` the identifier is `AGPL-3.0-or-later`.
