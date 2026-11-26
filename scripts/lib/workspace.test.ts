// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  checkImports,
  checkNodeRunnable,
  checkServerDependency,
  checkStructure,
  importsOf,
  kindOf,
  packageNameOf,
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
const libraryFiles = { "tsconfig.json": "{}", "tsconfig.build.json": "{}" };

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

  it("rejects an exclude in tsconfig.build.json", () => {
    const files = { ...libraryFiles, "tsconfig.build.json": '{ "exclude": ["x"] }' };
    expect(checkStructure(pkg("packages/lib", goodLibrary, files))[0]).toContain(
      'must not set "exclude"',
    );
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
    expect(checkStructure(pkg("apps/web", app, { "tsconfig.json": "{}" }))).toEqual([]);
    const tool = { ...app, scripts: { typecheck: "tsc" } };
    expect(checkStructure(pkg("bench", tool, { "tsconfig.json": "{}" }))).toEqual([]);
    expect(checkStructure(pkg("tools/x", tool, {}))[0]).toContain("belong in");
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
  it("accepts packages that do not depend on it", () => {
    expect(
      checkServerDependency([server, pkg("packages/core", { name: "@galatsa/core" })]),
    ).toEqual([]);
  });
});

describe("imports", () => {
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

  it("accepts declared packages, built-ins and the package itself", () => {
    const web = pkg(
      "apps/web",
      {
        name: "@galatsa/web",
        devDependencies: { x: "1.0.0" },
        peerDependencies: { y: "1" },
      },
      {
        "src/main.ts": `${header}import x from "x";\nimport y from "y";\nimport fs from "node:fs";\nimport path from "path";\nimport self from "@galatsa/web/sub";\nimport local from "./local.ts";\n`,
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
      'apps/web/src/main.tsx imports "blowfish-js", which @galatsa/web (apps/web) does not declare in its package.json.',
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
      dependencies: { "@galatsa/editor": "workspace:*" },
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

  it("accepts bench when nothing it reaches has .tsx", () => {
    const bench = pkg("bench", {
      name: "@galatsa/bench",
      dependencies: { "@galatsa/core": "workspace:*" },
    });
    const core = pkg("packages/core", { name: "@galatsa/core" }, { "src/index.ts": "" });
    const editor = pkg(
      "packages/editor",
      { name: "@galatsa/editor" },
      { "src/App.tsx": "" },
    );
    expect(checkNodeRunnable([bench, core, editor])).toEqual([]);
  });
});
