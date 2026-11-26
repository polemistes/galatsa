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
      { specifier: "../../x/", kind: "path" },
      { specifier: "./skip/", kind: "path" },
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
