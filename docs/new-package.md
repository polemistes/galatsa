# Adding a workspace package

`pnpm check` runs `scripts/check-workspace.ts`, which enforces the rules below. The quickest start is to copy `packages/core` and rename it.

## Where it goes

- `packages/<name>` or `packages/extensions/<name>`: a library that other packages import.
- `apps/<name>`: a program (web or desktop).
- `bench` and `tests/e2e`: tooling. No other places are allowed.

`pnpm-workspace.yaml` already lists these folders, so a new folder with a `package.json` is picked up after `pnpm install`.

## package.json

- `"private": true`.
- `"license"`: `"GPL-3.0-or-later"`. Only `packages/server` uses `"AGPL-3.0-or-later"`, and nothing else may reach it: not by name, not under another name (`"srv": "workspace:@galatsa/server@*"`), not through a `link:`, `file:` or `workspace:` path, not through an override in `pnpm-workspace.yaml`, and not with a relative import. Beyond these rules, every Vite build checks what it really bundles; see [Vite and the AGPL guard](#vite-and-the-agpl-guard).
- Scripts: `typecheck` (`tsc -p tsconfig.json`) in every package; `build` in libraries and apps.
- Libraries: `exports` with `"@galatsa/source": "./src/index.ts"` as the first condition of every entry, then `types` and `default` pointing at `dist/`. The source condition lets other packages, tests and Node scripts use the package without building it first. The one entry without it is `"./package.json": "./package.json"`, which is allowed.
- Targets in `exports` and `imports` (`"#name"` mappings) are `./` paths inside the package. A package named in `imports` must be declared like any other dependency.
- Declare every package you import, in this package's own `package.json`. Importing a package that only the root or another package declares fails the check, even if it happens to resolve. Use `"workspace:*"` for other workspace packages and `"catalog:"` for versions shared in `pnpm-workspace.yaml` (for example `vitest`).
- Third-party packages come from the npm registry, in a version that is at least two weeks old (see [Dependencies](#dependencies)). Dependencies from git, from a tarball or from a folder outside the workspace are not supported.
- Every dependency of a workspace package counts as production for the license check, whatever field lists it, because it may end up in the shipped program. Its license must be compatible with GPL-3.0-or-later. Only the root's `devDependencies` (repository tooling) are development-only.

## Imports and other references

The check reads every script (`.ts`, `.tsx`, `.js` and the like), stylesheet (`.css`, `.scss`, `.less` and the like) HTML file and Svelte component (its `<script>` and `<style>` blocks and element paths) of the package:

- imports, `export ... from`, `import()` and `require()`;
- `@import`, `@use` and `url()` in stylesheets, `@font-face` sources included, CSS Modules' `composes: ... from "..."` and `@value ... from "..."`, and Tailwind's `@config`, `@plugin`, `@reference` and `@source`;
- `src` and `href` of `script`, `link`, `img` and media elements in HTML (quoted or not), and inline scripts and styles;
- `new URL("...", import.meta.url)` and `import.meta.glob("...")`, with its `base` option.

Each reference must be one of these:

- a file inside the package's own folder. A relative path that leaves the folder (`../../shared/x.ts`) fails, even if the file exists, and so does a path into another workspace package. Share code through a workspace package instead. The check compares real paths: a symbolic link inside the package that points out of it fails by itself, and so does any path through it, also when git ignores the link.
- a package declared in this package's `package.json`, without `.` or `..` in the path after the name (`"pkg/../server/x.ts"` fails: a package without `exports` lets such a path leave it). In a stylesheet, a bare name (`@import "x.css"`) is a file next to the stylesheet if there is one, otherwise a package; `~name` is always a package.
- a Node built-in with the `node:` prefix (`node:fs`). Without the prefix, `events` or `buffer` is the npm package of that name and must be declared.
- a URL (`https:`, `data:`) or a `#name` mapping that the package declares in its `imports` field. An undeclared `#name` fails, also if a Vite alias or tsconfig `paths` would resolve it.

Relative imports name the file with its extension and use `/`: `import { x } from "./x.ts"`. Backslashes, drive letters, `file:` URLs and Vite's `/@fs/` paths fail.

Computed imports are checked by their fixed start. ``import(`./locales/${lang}.ts`)`` may reach every file in `./locales/`, so that folder must be inside the package and must not contain another workspace package. An `import()` or `require()` whose fixed start names no folder (``import(`${base}/x.ts`)``) fails, because a bundler may still follow it. Each branch of a choice is checked: `import(fast ? "./a.ts" : "../../server/b.ts")` fails. An `import()` of a plain variable is not followed by bundlers and is allowed.

Aliases are references too. The targets in `"paths"` of a tsconfig file, and in `resolve.alias` of `vite.config.*` and `vitest.config.*` (also written as `"alias"` or `["alias"]`), follow the same rules, as do `publicDir`, `root` and the build `input` entries of those configs. An alias target is understood if it is a string, or `path.resolve`, `path.join` or `fileURLToPath(new URL(..., import.meta.url))` of strings, `import.meta.dirname`, `__dirname` and `process.cwd()` (taken as the package folder). Any other alias fails, because the check cannot see where it points.

These rules read the files and can be outwitted, by a plugin, a glob or something nobody thought of. They are the first line of defence; the second is in the build itself, below.

## Vite and the AGPL guard

Every Vite and Vitest config in the workspace contains the AGPL guard from `vite.shared.ts` (code in `scripts/lib/agpl-guard.ts`). It fails a build when anything under `packages/server` would end up in it: a module, a file the build reads (stylesheets, assets, anything a plugin reads), `publicDir`, a build input, a sourcemap source, or code that carries an AGPL license identifier. Web workers get the guard too. While Vite serves (the dev server, Vitest), it fails an import from outside `packages/server` that leads into it. The server's own build is exempt.

- A config without plugins of its own spreads the shared settings:

  ```ts
  import { defineConfig } from "vite";
  import { workspaceSourceResolve } from "../../vite.shared.ts";

  export default defineConfig({ ...workspaceSourceResolve, build: { outDir: "dist" } });
  ```

- A config with plugins of its own wraps its settings in `workspaceConfig()`, which joins the plugin lists. A `plugins` key after the spread would replace the guard:

  ```ts
  import { svelte } from "@sveltejs/vite-plugin-svelte";
  import { defineConfig } from "vite";
  import { workspaceConfig } from "../../vite.shared.ts";

  export default defineConfig(workspaceConfig({ plugins: [svelte()] }));
  ```

- The workspace check loads every `vite.config.*` and `vitest.config.*` file with Vite, as `vite build` would, plus every file a package script passes to `vite --config`, and fails if the guard is missing or changed. It does not matter how the config is written, only what it amounts to.
- A package whose scripts run `vite` needs a `vite.config.ts` at its top: without a config file, Vite has no guard. Package scripts must not run other bundlers (Rollup, Rolldown, esbuild, webpack and the like), which the guard does not cover; `tsc` does not bundle and is fine.

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

- A package with a `vite.config.ts` uses the shared settings from `../../vite.shared.ts` (see [Vite and the AGPL guard](#vite-and-the-agpl-guard)), so Vite also reads workspace packages from source. A config file at the top of a package (`*.config.ts`) is the only place that may import `vite.shared.ts` with a relative path, and the package must then declare `vite` itself.
- Code that uses Vite's own features (`import.meta.env`, `import.meta.hot`, imports of `.css`, `.module.css`, `.svg` or `?url`) needs Vite's types. Add `src/vite-env.d.ts` to the package:

  ```ts
  // SPDX-License-Identifier: GPL-3.0-or-later

  /// <reference types="vite/client" />
  ```

  The root type check (`tsc -p tsconfig.json` in `pnpm check`) reads every file with only Node's types, so `"types": ["vite/client"]` in the package's own `tsconfig.json` is not enough on its own; the file is. The package declares `vite` (`"catalog:"`) in its devDependencies.

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

Put this in a `package.json` script (see `bench/package.json`). Node cannot load `.tsx`, `.jsx` or `.svelte` files, so code that Node runs (the root's `scripts/` and `bench`) must not depend on a package that has them; the workspace check enforces this. Test files (`*.test.tsx`) do not count, because Node never loads them from another package.

## Headers

Every source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later` (`/* ... */` in CSS, `<!-- ... -->` in HTML). Under `packages/server` the identifier is `AGPL-3.0-or-later`.

## Text and translations

User interface text never appears in code; it comes from message files. `pnpm check` runs `scripts/check-i18n.ts`, which enforces this. The design is in [docs/adr/0003-translations.md](adr/0003-translations.md).

- Put the package's text in `src/messages/nb.ts` and `src/messages/en.ts` (default export: key to message text, same keys in both), and create the bundle in `src/messages/index.ts` with `defineMessages("<namespace>", { nb, en })` from `@galatsa/i18n`. Extensions use their extension id as the namespace.
- Look text up with `i18n.translator(bundle)` or `i18n.t("namespace:key", values)`.
- The message files are exactly `src/messages/<language>.ts` for each interface language; other files in the folder are not catalogs. `defineMessages()` belongs in `src/messages/index.ts`, with the catalogs imported from those files. A bundle written by hand (`{ namespace: "editor", messages: { nb, en } }`) fails the check, because its languages would never be compared.
- User interface code is checked for hard-coded text. In a package that has `.tsx`, `.jsx` or `.svelte` files or declares `@galatsa/i18n`, that is every script and Svelte component under `src/`, plus HTML pages; in other packages, `.tsx`, `.jsx`, `.svelte` and HTML files. Svelte components are parsed with `svelte/compiler`: text in the markup and text attributes as in JSX, and the scripts and markup expressions with the script rules; write `<!-- i18n-ignore: reason -->` in markup. A package can list its own globs in its `package.json`, with `!` to leave files out: `"galatsa": { "i18n": { "uiFiles": ["src/**", "!src/model/**"] } }`. The other settings (`messages`, `textAttributes`, `textCalls`) are described in `scripts/lib/i18n-config.ts`.
- Names are a guess. For names that hold text only by their ending (`errorMessage`, `plainText`, `sortDescription`), a value that looks like a code is not reported: one ASCII word without spaces that is all lower case (`"ascending"`), all upper case (`"ENOENT"`), camelCase, or has a digit or one of `/ _ . : + = # @ -` (`"text/plain"`, `"en-US"`). A capitalised word (`"Save"`), text with a space and text with letters outside ASCII are reported. In the fixed text places (JSX text, `title`, `aria-label`, `textContent` and so on) every value with a letter is reported. Text that is only a URL or an e-mail address is never reported, and neither is the content of `<style>` and `<script>`.
- Text that must not be translated (a product name, a code sample) is marked with `// i18n-ignore: <reason>` on the line or alone on the line above (`{/* i18n-ignore: <reason> */}` in JSX, `<!-- i18n-ignore: <reason> -->` in HTML). Only comments count, not the same words in a string.
