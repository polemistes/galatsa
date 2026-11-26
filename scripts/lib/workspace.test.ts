// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parseLockfile } from "./lockfile.ts";
import {
  checkImports,
  checkManifestMappings,
  checkNodeRunnable,
  checkServerDependency,
  checkStructure,
  importsOf,
  kindOf,
  packageNameOf,
  referencesOf,
  specifierTarget,
  type Manifest,
  type WorkspacePackage,
} from "./workspace.ts";

const header = "// SPDX-License-Identifier: GPL-3.0-or-later\n";

function pkg(
  path: string,
  manifest: Manifest,
  files: Record<string, string> = {},
): WorkspacePackage {
  return {
    path,
    manifest,
    files: Object.keys(files),
    read: (file) => files[file] ?? "",
  };
}

const goodLibrary: Manifest = {
  name: "@galatsa/lib",
  private: true,
  license: "GPL-3.0-or-later",
  scripts: { typecheck: "tsc -p tsconfig.json", build: "tsc -p tsconfig.build.json" },
  exports: { ".": { "@galatsa/source": "./src/index.ts", default: "./dist/index.js" } },
};
const libraryFiles = {
  "tsconfig.json": '{ "extends": "../../tsconfig.base.json" }',
  "tsconfig.build.json": '{ "extends": "../../tsconfig.build.base.json" }',
};

describe("kindOf", () => {
  it("knows where packages belong", () => {
    expect(kindOf(".")).toBe("root");
    expect(kindOf("packages/core")).toBe("library");
    expect(kindOf("packages/extensions/text")).toBe("library");
    expect(kindOf("apps/web")).toBe("app");
    expect(kindOf("bench")).toBe("tooling");
    expect(kindOf("tests/e2e")).toBe("tooling");
    expect(kindOf("tools/x")).toBeUndefined();
    expect(kindOf("packages/a/b")).toBeUndefined();
  });
});

describe("checkStructure", () => {
  it("accepts a complete library", () => {
    expect(checkStructure(pkg("packages/lib", goodLibrary, libraryFiles))).toEqual([]);
  });

  it("reports missing files, scripts, private and license", () => {
    const problems = checkStructure(pkg("packages/lib", { name: "@galatsa/lib" }, {}));
    expect(problems.join("\n")).toContain('"license" is undefined');
    expect(problems.join("\n")).toContain('"private": true');
    expect(problems.join("\n")).toContain("tsconfig.json is missing");
    expect(problems.join("\n")).toContain("tsconfig.build.json is missing");
    expect(problems.join("\n")).toContain('"typecheck" script is missing');
    expect(problems.join("\n")).toContain('"build" script is missing');
    expect(problems.join("\n")).toContain('"exports" must have a "." entry');
  });

  it('requires "@galatsa/source" first in every export', () => {
    const manifest = {
      ...goodLibrary,
      exports: {
        ".": { default: "./dist/index.js", "@galatsa/source": "./src/index.ts" },
        "./x": { "@galatsa/source": "./src/x.ts" },
      },
    };
    expect(checkStructure(pkg("packages/lib", manifest, libraryFiles))).toEqual([
      '@galatsa/lib (packages/lib): exports["."] must list "@galatsa/source": "./src/..." first.',
    ]);
  });

  it('accepts "./package.json" in exports', () => {
    const manifest = {
      ...goodLibrary,
      exports: {
        ".": { "@galatsa/source": "./src/index.ts", default: "./dist/index.js" },
        "./package.json": "./package.json",
      },
    };
    expect(checkStructure(pkg("packages/lib", manifest, libraryFiles))).toEqual([]);
  });

  it("rejects an exclude in tsconfig.build.json", () => {
    const files = {
      ...libraryFiles,
      "tsconfig.build.json":
        '{ "extends": "../../tsconfig.build.base.json", "exclude": ["x"] }',
    };
    expect(checkStructure(pkg("packages/lib", goodLibrary, files))).toEqual([
      '@galatsa/lib (packages/lib): tsconfig.build.json must not set "exclude"; the shared one in tsconfig.build.base.json keeps tests out of dist/.',
    ]);
  });

  it("requires the shared base configs, at the right depth", () => {
    const files = {
      "tsconfig.json": '{ "extends": "../tsconfig.base.json" }',
      "tsconfig.build.json": '{ "extends": "../../tsconfig.base.json" }',
    };
    expect(checkStructure(pkg("packages/lib", goodLibrary, files))).toEqual([
      '@galatsa/lib (packages/lib): tsconfig.json must extend "../../tsconfig.base.json".',
      '@galatsa/lib (packages/lib): tsconfig.build.json must extend "../../tsconfig.build.base.json".',
    ]);
    const extension = {
      // Comments are allowed, and "./" or an array of configs are fine.
      "tsconfig.json": '// x\n{ "extends": ["./../../../tsconfig.base.json"] }',
      "tsconfig.build.json": '{ "extends": "../../../tsconfig.build.base.json" }',
    };
    expect(checkStructure(pkg("packages/extensions/x", goodLibrary, extension))).toEqual(
      [],
    );
  });

  it("requires the same lib and types in tsconfig.json and tsconfig.build.json", () => {
    const files = {
      "tsconfig.json":
        '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023", "DOM"] } }',
      "tsconfig.build.json": '{ "extends": "../../tsconfig.build.base.json" }',
    };
    const problems = checkStructure(pkg("packages/lib", goodLibrary, files));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      '"lib" is ["dom","es2023"] in tsconfig.json but (inherited) in tsconfig.build.json',
    );
    const same = {
      "tsconfig.json":
        '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["node"] } }',
      "tsconfig.build.json":
        '{ "extends": "../../tsconfig.build.base.json", "compilerOptions": { "lib": ["DOM", "ES2023"], "types": ["node"] } }',
    };
    expect(checkStructure(pkg("packages/lib", goodLibrary, same))).toEqual([]);
  });

  it("allows AGPL only in packages/server", () => {
    const agpl = { ...goodLibrary, license: "AGPL-3.0-or-later" };
    expect(checkStructure(pkg("packages/server", agpl, libraryFiles))).toEqual([]);
    expect(checkStructure(pkg("packages/lib", agpl, libraryFiles))[0]).toContain(
      'must be "GPL-3.0-or-later"',
    );
    expect(
      checkStructure(pkg("packages/server", goodLibrary, libraryFiles))[0],
    ).toContain('must be "AGPL-3.0-or-later"');
  });

  it("needs less for apps and tooling, and rejects unknown places", () => {
    const app = {
      name: "@galatsa/web",
      private: true,
      license: "GPL-3.0-or-later",
      scripts: { typecheck: "tsc", build: "vite build" },
    };
    const appFiles = { "tsconfig.json": '{ "extends": "../../tsconfig.base.json" }' };
    expect(checkStructure(pkg("apps/web", app, appFiles))).toEqual([]);
    const tool = { ...app, scripts: { typecheck: "tsc" } };
    const toolFiles = { "tsconfig.json": '{ "extends": "../tsconfig.base.json" }' };
    expect(checkStructure(pkg("bench", tool, toolFiles))).toEqual([]);
    expect(checkStructure(pkg("tools/x", tool, {}))[0]).toContain("belong in");
  });
});

describe("specifierTarget", () => {
  it("resolves names, aliases and paths", () => {
    expect(specifierTarget("packages/a", "x", "1.0.0")).toEqual({ name: "x" });
    expect(specifierTarget("packages/a", "x", "workspace:*")).toEqual({ name: "x" });
    expect(specifierTarget("packages/a", "srv", "workspace:@galatsa/server@*")).toEqual({
      name: "@galatsa/server",
    });
    expect(specifierTarget("packages/a", "srv", "workspace:server@^")).toEqual({
      name: "server",
    });
    expect(specifierTarget("packages/a", "srv", "workspace:../server")).toEqual({
      path: "packages/server",
    });
    expect(specifierTarget("packages/a", "srv", "link:../server")).toEqual({
      path: "packages/server",
    });
    expect(specifierTarget("packages/a", "srv", "file:..\\server")).toEqual({
      path: "packages/server",
    });
    expect(specifierTarget("packages/a", "w", "npm:string-width@4.2.3")).toEqual({
      name: "string-width",
    });
    expect(specifierTarget("packages/a", "w", "npm:@scope/x@1")).toEqual({
      name: "@scope/x",
    });
  });
});

describe("checkServerDependency", () => {
  const server = pkg("packages/server", { name: "@galatsa/server" });
  it("rejects a dependency on the server from another package, in any field", () => {
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ] as const) {
      const core = pkg("packages/core", {
        name: "@galatsa/core",
        [field]: { "@galatsa/server": "workspace:*" },
      });
      expect(checkServerDependency([server, core])).toHaveLength(1);
    }
  });

  it.each([
    "workspace:@galatsa/server@*",
    "workspace:../server",
    "link:../server",
    "file:../server",
    "link:../server/src",
  ])("rejects the server under another name: %s", (specifier) => {
    const editor = pkg("packages/editor", {
      name: "@galatsa/editor",
      dependencies: { srv: specifier },
    });
    const problems = checkServerDependency([server, editor]);
    expect(problems).toEqual([
      `@galatsa/editor (packages/editor): "srv": "${specifier}" in dependencies points at packages/server. Only packages/server may use the AGPL server code.`,
    ]);
  });

  it("rejects a path to the server even before the server package exists", () => {
    const editor = pkg("packages/editor", {
      name: "@galatsa/editor",
      dependencies: { srv: "link:../server" },
    });
    expect(checkServerDependency([editor])).toHaveLength(1);
  });

  it("rejects links into the server in the lockfile, from importers and overrides", () => {
    const lockfile = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  packages/editor:",
        "    dependencies:",
        "      srv:",
        "        specifier: link:../server",
        "        version: link:../server",
        "  packages/server: {}",
        "packages:",
        "  optionator@0.9.4:",
        "    resolution: {integrity: sha512-x}",
        "snapshots:",
        "  optionator@0.9.4:",
        "    dependencies:",
        "      deep-is: link:packages/server",
      ].join("\n"),
    );
    const problems = checkServerDependency([server], lockfile);
    expect(problems).toEqual([
      'pnpm-lock.yaml: packages/editor depends on srv through "link:../server", which is in packages/server. Only packages/server may use the AGPL server code.',
      'pnpm-lock.yaml: optionator@0.9.4 depends on deep-is through "link:packages/server", which is in packages/server. Only packages/server may use the AGPL server code.',
    ]);
  });

  it("accepts packages that do not depend on it", () => {
    expect(
      checkServerDependency([
        server,
        pkg("packages/core", {
          name: "@galatsa/core",
          dependencies: { "@galatsa/server-types": "workspace:*", x: "link:../x" },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("references", () => {
  it("finds static, dynamic, re-export and require imports, but not text in comments", () => {
    const text = [
      'import a from "a";',
      'import type { B } from "@scope/b/sub";',
      'export * from "c";',
      'const d = await import("d");',
      'const e = require("e");',
      '// import f from "f";',
      'const s = "import g from \\"g\\"";',
    ].join("\n");
    expect(importsOf(text).sort()).toEqual(["@scope/b/sub", "a", "c", "d", "e"]);
  });

  it("finds new URL() and import.meta.glob() paths in scripts", () => {
    const text = [
      'const a = new URL("./a.png", import.meta.url);',
      'const b = import.meta.glob(["../../x/*.ts", "!./skip/**"]);',
      'const c = new URL("https://example.org/");',
    ].join("\n");
    expect(referencesOf("src/x.ts", text)).toEqual([
      { specifier: "./a.png", kind: "path" },
      { specifier: "../../x/", kind: "prefix" },
      { specifier: "./skip/", kind: "prefix" },
    ]);
  });

  it("finds import(), require() and new URL() of template strings by their fixed start", () => {
    const text = [
      "const a = import(`./locales/${lang}.ts`);",
      'const b = require("./x/" + name);',
      "const c = new URL(`assets/${file}`, import.meta.url);",
      "const d = import(`${base}/x.ts`);",
      "const e = import(`./plain.ts`);",
      "const f = import(url);",
    ].join("\n");
    expect(referencesOf("src/x.ts", text)).toEqual([
      // TypeScript's own scan reports the first string of a concatenation, and a
      // template string without substitutions; both are checked as paths too.
      { specifier: "./x/", kind: "module" },
      { specifier: "./plain.ts", kind: "module" },
      { specifier: "./locales/", kind: "prefix" },
      { specifier: "./x/", kind: "prefix" },
      { specifier: "./assets/", kind: "prefix" },
      {
        specifier: "`${base}/x.ts`",
        kind: "unchecked",
        reason: "import() whose start does not name a folder",
      },
      { specifier: "./plain.ts", kind: "module" },
    ]);
  });

  it("finds resolve.alias targets in Vite config files", () => {
    const text = [
      'import { resolve, join } from "node:path";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const shared = { "@a": resolve(import.meta.dirname, "src/a") };',
      "export default {",
      "  resolve: {",
      "    alias: {",
      '      "@b": path.resolve(__dirname, "..", "packages/server/src"),',
      '      "@c": fileURLToPath(new URL("./src/c", import.meta.url)),',
      '      "@d": "some-package",',
      '      "@e": join(process.cwd(), `src/${x}`),',
      "    },",
      "  },",
      "  test: { alias: shared },",
      '  other: { alias: [{ find: /^~/, replacement: resolve(import.meta.dirname, "lib") }] },',
      "};",
    ].join("\n");
    const refs = referencesOf("vite.config.ts", text).filter(
      (r) => r.kind !== "module" || r.specifier === "some-package",
    );
    expect(refs).toEqual([
      { specifier: "./src/c", kind: "path" }, // new URL() is a reference in itself
      { specifier: "../packages/server/src", kind: "path" },
      { specifier: "./src/c", kind: "path" },
      { specifier: "some-package", kind: "module" },
      {
        specifier: "join(process.cwd(), `src/${x}`)",
        kind: "unchecked",
        reason: "an alias whose target cannot be checked",
      },
      { specifier: "./src/a", kind: "path" },
      { specifier: "./lib", kind: "path" },
    ]);
  });

  it("finds both branches of a computed import and the base of a glob", () => {
    const text = [
      'void import(Math.random() > 2 ? "../../server/b.ts" : "./x.ts");',
      'void import(name || "../up/y.ts");',
      'import.meta.glob("./*.ts", { base: "../../../packages/server/src", eager: true });',
      "import.meta.glob(`./*.ts`, options);",
    ].join("\n");
    const refs = referencesOf("src/x.ts", text);
    expect(refs).toContainEqual({ specifier: "../../server/b.ts", kind: "module" });
    expect(refs).toContainEqual({ specifier: "./x.ts", kind: "module" });
    expect(refs).toContainEqual({ specifier: "../up/y.ts", kind: "module" });
    expect(refs).toContainEqual({
      specifier: "../../../packages/server/src/",
      kind: "prefix",
    });
    expect(refs).toContainEqual(
      expect.objectContaining({ kind: "unchecked", specifier: "options" }),
    );
  });

  it("finds CSS Modules and Tailwind references", () => {
    const text = [
      '.a { composes: b c from "../../server/s.css"; }',
      '@value primary, secondary from "./colors.css";',
      '@config "../tailwind.config.js";',
      '@plugin "@tailwindcss/typography";',
      '@source "../../server/src";',
      '@reference "../app.css";',
    ].join("\n");
    expect(referencesOf("src/x.module.css", text).map((r) => r.specifier)).toEqual([
      "../../server/s.css",
      "./colors.css",
      "../tailwind.config.js",
      "@tailwindcss/typography",
      "../../server/src",
      "../app.css",
    ]);
  });

  it("reads HTML attributes with > inside quotes, and unquoted values", () => {
    const text = [
      '<script type="module" data-note="a>b" src="../server/b.ts"></script>',
      "<script type=module src=../server/c.ts></script>",
      '<script data-x="a>b">import "../server/d.ts";</script>',
    ].join("\n");
    expect(referencesOf("index.html", text).map((r) => r.specifier)).toEqual([
      "../server/b.ts",
      "../server/c.ts",
      "../server/d.ts",
    ]);
  });

  it("finds aliases under quoted or computed keys, and path options of Vite configs", () => {
    const text = [
      'import { resolve } from "node:path";',
      "export default {",
      '  resolve: { ["alias"]: { "@x": "../packages/server/src/a.ts" } },',
      '  publicDir: "../packages/server/public",',
      '  root: "web",',
      '  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), srv: resolve(import.meta.dirname, "../srv.ts") } } },',
      "  other: { publicDir: false },",
      "};",
    ].join("\n");
    const refs = referencesOf("vite.config.ts", text).filter((r) => r.kind !== "module");
    expect(refs).toEqual([
      { specifier: "../packages/server/src/a.ts", kind: "path" },
      { specifier: "../packages/server/public", kind: "path" },
      { specifier: "./web", kind: "path" },
      { specifier: "./index.html", kind: "path" },
      { specifier: "../srv.ts", kind: "path" },
    ]);
  });

  it("rejects . and .. in a package path", () => {
    const lib = pkg(
      "packages/lib",
      { ...goodLibrary, dependencies: { fake: "1.0.0" } },
      {
        "src/index.ts": `${header}import "fake/../../server/src/a.ts";\nimport "fake/sub/x.ts";\n`,
      },
    );
    expect(checkImports(lib)).toEqual([
      'packages/lib/src/index.ts: "fake/../../server/src/a.ts" has a "." or ".." segment, which can lead out of the package.',
    ]);
  });

  it("finds tsconfig paths, relative to baseUrl", () => {
    const text = JSON.stringify({
      compilerOptions: {
        baseUrl: "src",
        paths: { "#x/*": ["../../server/src/*"], "@y": ["./y.ts"] },
      },
    });
    expect(referencesOf("tsconfig.json", text)).toEqual([
      { specifier: "../server/src/", kind: "prefix" },
      { specifier: "./src/y.ts", kind: "path" },
    ]);
  });

  it("finds @import, @use and url() in stylesheets, but not in comments", () => {
    const text = [
      '@import "@fontsource/inter";',
      "@import url(./local.css) layer(base);",
      "@use 'sass-pkg';",
      "/* @import 'commented'; */",
      '@font-face { src: url("../fonts/x.woff2") format("woff2"); }',
      ".a { background: url(data:image/png;base64,AAAA); }",
    ].join("\n");
    expect(referencesOf("src/app.css", text).map((ref) => ref.specifier)).toEqual([
      "@fontsource/inter",
      "./local.css",
      "sass-pkg",
      "./local.css",
      "../fonts/x.woff2",
      "data:image/png;base64,AAAA",
    ]);
  });

  it("finds script, link and inline references in HTML", () => {
    const text = [
      '<link rel="stylesheet" href="../shared/x.css">',
      "<!-- <script src='commented.ts'></script> -->",
      '<script type="module" src="/src/main.ts"></script>',
      '<script type="module">import "inline-pkg";</script>',
      "<style>@import 'style-pkg';</style>",
    ].join("\n");
    expect(referencesOf("index.html", text).map((ref) => ref.specifier)).toEqual([
      "../shared/x.css",
      "/src/main.ts",
      "inline-pkg",
      "style-pkg",
    ]);
  });

  it("turns specifiers into package names", () => {
    expect(packageNameOf("react")).toBe("react");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
    expect(packageNameOf("@galatsa/core")).toBe("@galatsa/core");
    expect(packageNameOf("@scope/x/deep/file.js")).toBe("@scope/x");
    expect(packageNameOf("./local.ts")).toBeUndefined();
    expect(packageNameOf("node:fs")).toBeUndefined();
    expect(packageNameOf("virtual:pwa-register")).toBeUndefined();
    expect(packageNameOf("#internal")).toBeUndefined();
  });
});

describe("checkImports", () => {
  it("accepts declared packages, node: built-ins, local files and the package itself", () => {
    const web = pkg(
      "apps/web",
      {
        name: "@galatsa/web",
        devDependencies: { x: "1.0.0" },
        peerDependencies: { y: "1" },
      },
      {
        "src/main.ts": `${header}import x from "x";\nimport y from "y";\nimport fs from "node:fs";\nimport self from "@galatsa/web/sub";\nimport local from "./local.ts";\nimport "../index.css";\nimport raw from "./a.svg?raw";\n`,
        "src/local.ts": "",
        "src/a.svg": "",
        "index.css": '@import "./src/theme.css";\n@import "theme2.css";\n',
        "theme2.css": "",
        "index.html": '<script type="module" src="/src/main.ts"></script>',
      },
    );
    expect(checkImports(web)).toEqual([]);
  });

  it("rejects an undeclared package", () => {
    const web = pkg(
      "apps/web",
      { name: "@galatsa/web" },
      {
        "src/main.tsx": `${header}import blowfish from "blowfish-js";\n`,
        "README.md": 'import "x"',
      },
    );
    expect(checkImports(web)).toEqual([
      'apps/web/src/main.tsx uses "blowfish-js", which @galatsa/web (apps/web) does not declare in its package.json.',
    ]);
  });

  it("treats a built-in name without node: as an npm package", () => {
    const web = pkg(
      "apps/web",
      { name: "@galatsa/web" },
      { "src/main.ts": 'import { EventEmitter } from "events";\n' },
    );
    expect(checkImports(web)).toEqual([
      'apps/web/src/main.ts uses "events", which @galatsa/web (apps/web) does not declare in its package.json. For the Node built-in, write "node:events".',
    ]);
    const declared = pkg(
      "apps/web",
      { name: "@galatsa/web", dependencies: { events: "3.3.0" } },
      { "src/main.ts": 'import { EventEmitter } from "events";\n' },
    );
    expect(checkImports(declared)).toEqual([]);
  });

  it("rejects undeclared packages in stylesheets, by @import and url()", () => {
    const web = pkg(
      "apps/web",
      { name: "@galatsa/web", dependencies: { declared: "1.0.0" } },
      {
        "src/app.css": [
          '@import "@fontsource/inter";',
          '@import "~other/x.css";',
          '@import "declared/x.css";',
          "@font-face { src: url(font-pkg/files/x.woff2); }",
          ".a { background: url(#id) url(https://example.org/x.png); }",
        ].join("\n"),
      },
    );
    expect(checkImports(web)).toEqual([
      'apps/web/src/app.css uses "@fontsource/inter", which @galatsa/web (apps/web) does not declare in its package.json.',
      'apps/web/src/app.css uses "other", which @galatsa/web (apps/web) does not declare in its package.json.',
      'apps/web/src/app.css uses "font-pkg", which @galatsa/web (apps/web) does not declare in its package.json.',
    ]);
  });

  it("rejects relative paths that leave the package, in scripts, styles and HTML", () => {
    const web = pkg(
      "apps/web",
      { name: "@galatsa/web" },
      {
        "src/lazy.ts": 'export * from "../../../shared/strings.ts";\n',
        "src/img.ts": 'const u = new URL("../../x.png", import.meta.url);\n',
        "src/app.css": '@import "../../../shared/x.css";\n',
        "index.html": '<link rel="stylesheet" href="/../shared.css">',
      },
    );
    const problems = checkImports(web);
    expect(problems).toHaveLength(4);
    for (const problem of problems) expect(problem).toContain("which is outside");
    expect(problems[0]).toBe(
      'apps/web/src/lazy.ts refers to "../../../shared/strings.ts", which is outside @galatsa/web (apps/web). Relative paths must stay inside the package folder; use a declared workspace package instead.',
    );
  });

  it("rejects relative paths into the server and other nested packages", () => {
    const root = pkg(
      ".",
      { name: "galatsa" },
      { "scripts/x.ts": 'import { S } from "../packages/server/src/index.ts";\n' },
    );
    const server = pkg("packages/server", { name: "@galatsa/server" });
    const editor = pkg(
      "packages/editor",
      { name: "@galatsa/editor" },
      { "src/index.ts": 'export { S } from "../../server/src/index.ts";\n' },
    );
    const all = [root, server, editor];
    expect(checkImports(root, all)).toEqual([
      'scripts/x.ts refers to "../packages/server/src/index.ts", which is inside the workspace package packages/server. Declare that package and import it by name instead.',
    ]);
    expect(checkImports(editor, all)[0]).toContain("which is outside");
  });

  it("rejects a symbolic link out of the package, and paths through it", () => {
    // bench/src/srv -> packages/server/src, as the file system reports it.
    const real = (path: string): string =>
      path.startsWith("src/srv")
        ? `packages/server/src${path.slice(7)}`
        : `bench/${path}`;
    const bench = {
      ...pkg(
        "bench",
        { name: "@galatsa/bench" },
        {
          "src/srv": "",
          "src/main.ts":
            'import { S } from "./srv/index.ts";\nimport { T } from "./ok.ts";\n',
          "src/ok.ts": "",
        },
      ),
      realPath: (path: string) => (path === "." ? "bench" : real(path)),
      symlinks: ["src/srv"],
    };
    expect(checkImports(bench)).toEqual([
      'bench/src/main.ts refers to "./srv/index.ts", which is really packages/server/src/index.ts (through a symbolic link), outside @galatsa/bench (bench). Relative paths must stay inside the package folder; use a declared workspace package instead.',
      "bench/src/srv is a symbolic link to packages/server/src, outside @galatsa/bench (bench). Links may only point inside the package; share code through a declared workspace package instead.",
    ]);
  });

  it('accepts only "#name" imports declared in the "imports" field', () => {
    const manifest = {
      name: "@galatsa/web",
      imports: { "#config": "./src/config.ts", "#icons/*": "./src/icons/*.ts" },
    };
    const web = pkg("apps/web", manifest, {
      "src/main.ts": [
        'import c from "#config";',
        'import i from "#icons/save";',
        'import s from "#srv";',
        'const u = new URL("#top", import.meta.url);',
      ].join("\n"),
      "src/app.css": ".a { fill: url(#gradient); }",
    });
    expect(checkImports(web)).toEqual([
      'apps/web/src/main.ts imports "#srv", which is not declared in the "imports" field of @galatsa/web (apps/web). Declare it there ("#name": "./src/file.ts"), so the check can see where it points.',
    ]);
  });

  it("checks computed imports by the folder of their fixed start", () => {
    const root = pkg(".", { name: "galatsa" });
    const server = pkg("packages/server", { name: "@galatsa/server" });
    const bench = pkg(
      "bench",
      { name: "@galatsa/bench", dependencies: { lodash: "1" } },
      {
        "src/ok.ts": [
          "import(`./engines/${name}.ts`);",
          "import(`lodash/${fn}.js`);",
          "new URL(`../assets/${file}`, import.meta.url);",
        ].join("\n"),
        "src/bad.ts": [
          "import(`../../packages/server/src/${which}.ts`);",
          'import("../../" + where);',
          "import(`${base}/x.ts`);",
          "import(`@galatsa/${pkg}`);",
        ].join("\n"),
      },
    );
    const all = [root, server, bench];
    expect(checkImports(bench, all)).toEqual([
      'bench/src/bad.ts refers to "../../", which is outside @galatsa/bench (bench). Relative paths must stay inside the package folder; use a declared workspace package instead.',
      'bench/src/bad.ts refers to "../../packages/server/src/", which is outside @galatsa/bench (bench). Relative paths must stay inside the package folder; use a declared workspace package instead.',
      "bench/src/bad.ts: import() whose start does not name a folder (`${base}/x.ts`); a bundler may still follow it, so it is not allowed.",
      'bench/src/bad.ts: a computed import starting with "@galatsa/" does not name a whole package or a folder.',
    ]);
    // From the root, a folder that contains a workspace package can reach into it.
    const rootWithGlob = pkg(
      ".",
      { name: "galatsa" },
      {
        "scripts/x.ts": "import(`../packages/${name}/src/index.ts`);",
      },
    );
    expect(checkImports(rootWithGlob, [rootWithGlob, server, bench])).toEqual([
      'scripts/x.ts refers to "../packages/", which can reach into the workspace package packages/server. Declare that package and import it by name instead.',
    ]);
  });

  it("checks alias targets in Vite configs and tsconfig paths", () => {
    const bench = pkg(
      "bench",
      { name: "@galatsa/bench", devDependencies: { vite: "1" } },
      {
        "vite.config.ts": [
          'import { resolve } from "node:path";',
          "export default {",
          "  resolve: {",
          '    alias: { "#srv": resolve(import.meta.dirname, "..", "packages/server/src/a.ts") },',
          "  },",
          "};",
        ].join("\n"),
        "vitest.config.ts": "export default { resolve: { alias: makeAliases() } };",
        "tsconfig.json":
          '{ "compilerOptions": { "paths": { "#x/*": ["../packages/server/src/*"] } } }',
        "src/ok.ts": "",
      },
    );
    expect(checkImports(bench)).toEqual([
      'bench/vite.config.ts refers to "../packages/server/src/a.ts", which is outside @galatsa/bench (bench). Relative paths must stay inside the package folder; use a declared workspace package instead.',
      "bench/vitest.config.ts: an alias whose target cannot be checked (makeAliases()); a bundler may still follow it, so it is not allowed.",
      'bench/tsconfig.json refers to "../packages/server/src/", which is outside @galatsa/bench (bench). Relative paths must stay inside the package folder; use a declared workspace package instead.',
    ]);
  });

  it("rejects backslashes and absolute paths in specifiers", () => {
    const web = pkg(
      "apps/web",
      { name: "@galatsa/web" },
      {
        "src/main.ts": [
          String.raw`import a from "..\\..\\packages\\server\\src\\a.ts";`,
          'import b from "C:/repo/packages/server/src/b.ts";',
          'import c from "file:///repo/packages/server/src/c.ts";',
          'import d from "/@fs/repo/packages/server/src/d.ts";',
        ].join("\n"),
      },
    );
    expect(checkImports(web)).toEqual([
      'apps/web/src/main.ts: "..\\..\\packages\\server\\src\\a.ts" contains a backslash; write paths with "/".',
      'apps/web/src/main.ts: "C:/repo/packages/server/src/b.ts" is an absolute file path; use a path relative to the file.',
      'apps/web/src/main.ts: "file:///repo/packages/server/src/c.ts" is an absolute file path; use a path relative to the file.',
      'apps/web/src/main.ts: "/@fs/repo/packages/server/src/d.ts" is an absolute file path; use a path relative to the file.',
    ]);
  });

  it("lets a config file import a shared root file whose packages it declares", () => {
    const root = pkg(
      ".",
      { name: "galatsa", devDependencies: { vite: "1" } },
      { "vite.shared.ts": 'import { x } from "vite";\n' },
    );
    const files = { "vite.config.ts": 'import { w } from "../vite.shared.ts";\n' };
    const declared = pkg("bench", { name: "b", devDependencies: { vite: "1" } }, files);
    expect(checkImports(declared, [root, declared])).toEqual([]);
    const undeclared = pkg("bench", { name: "b" }, files);
    expect(checkImports(undeclared, [root, undeclared])).toEqual([
      'bench/vite.config.ts (through vite.shared.ts) uses "vite", which b (bench) does not declare in its package.json.',
    ]);
    const fromSource = pkg(
      "bench",
      { name: "b", devDependencies: { vite: "1" } },
      { "src/x.ts": 'import { w } from "../../vite.shared.ts";\n' },
    );
    expect(checkImports(fromSource, [root, fromSource])[0]).toContain("which is outside");
  });
});

describe("checkManifestMappings", () => {
  it("accepts targets inside the package and declared packages", () => {
    const lib = pkg("packages/lib", {
      ...goodLibrary,
      dependencies: { x: "1" },
      imports: { "#a": "./src/a.ts", "#b": { node: "x/node", default: "./src/b.ts" } },
    });
    expect(checkManifestMappings(lib)).toEqual([]);
  });

  it("rejects targets outside the package and undeclared packages", () => {
    const lib = pkg("packages/lib", {
      ...goodLibrary,
      exports: { ".": { "@galatsa/source": "./src/index.ts", default: "../x.js" } },
      imports: { "#a": "./../../shared/a.ts", "#b": "undeclared/sub" },
    });
    expect(checkManifestMappings(lib)).toEqual([
      '@galatsa/lib (packages/lib): "exports" target "../x.js" must be a "./" path inside the package.',
      '@galatsa/lib (packages/lib): "imports" target "./../../shared/a.ts" must be a "./" path inside the package.',
      '@galatsa/lib (packages/lib): "imports" maps to "undeclared", which is not declared in its package.json.',
    ]);
  });
});

describe("checkNodeRunnable", () => {
  it("rejects .tsx reachable from bench through workspace dependencies", () => {
    const bench = pkg("bench", {
      name: "@galatsa/bench",
      dependencies: { "@galatsa/format": "workspace:*" },
    });
    const format = pkg("packages/format", {
      name: "@galatsa/format",
      dependencies: { ed: "workspace:@galatsa/editor@*" },
    });
    const editor = pkg(
      "packages/editor",
      { name: "@galatsa/editor" },
      { "src/App.tsx": "" },
    );
    const problems = checkNodeRunnable([bench, format, editor]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "@galatsa/editor (packages/editor) has .tsx or .jsx files",
    );
  });

  it("accepts bench when nothing it reaches has .tsx outside tests", () => {
    const bench = pkg("bench", {
      name: "@galatsa/bench",
      dependencies: { "@galatsa/core": "workspace:*" },
    });
    const core = pkg(
      "packages/core",
      { name: "@galatsa/core" },
      { "src/index.ts": "", "src/view.test.tsx": "" },
    );
    const editor = pkg(
      "packages/editor",
      { name: "@galatsa/editor" },
      { "src/App.tsx": "" },
    );
    expect(checkNodeRunnable([bench, core, editor])).toEqual([]);
  });
});
