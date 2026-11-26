// SPDX-License-Identifier: GPL-3.0-or-later

// Builds small apps next to a fake AGPL server package, each trying one way of
// pulling server code into the bundle, and checks that the guard stops the build.
// The fixtures are written to a temporary folder, outside the workspace.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, createServer, type InlineConfig, type Plugin } from "vite";
import {
  createAgplGuard,
  hasAgplIdentifier,
  idMentionsFolder,
  idToPath,
  isInsideFolder,
} from "./agpl-guard.ts";

const AGPL_HEADER = "// SPDX-License-Identifier: AGPL-3.0-or-later\n";
const GPL_HEADER = "// SPDX-License-Identifier: GPL-3.0-or-later\n";

let work = "";
let serverDir = "";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeAll(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "galatsa-agpl-guard-")));
  serverDir = path.join(work, "server");
  for (const name of ["a", "b", "index"]) {
    write(
      path.join(serverDir, "src", `${name}.ts`),
      `${AGPL_HEADER}export const mark_${name} = "AGPL_SECRET_${name}";\nconsole.log(mark_${name});\n`,
    );
  }
  write(
    path.join(serverDir, "src", "s.css"),
    '/* SPDX-License-Identifier: AGPL-3.0-or-later */\n@value agplColor: #a91;\n.agpl {\n  content: "AGPL_SECRET_css";\n}\n',
  );
  write(path.join(serverDir, "public", "secret.txt"), "AGPL_SECRET_public\n");
});

afterAll(() => {
  if (work !== "") fs.rmSync(work, { recursive: true, force: true });
});

let appCount = 0;

/**
 * Creates an app folder next to the server: an index.html loading src/main.ts,
 * plus the given files. Returns its folder.
 */
function app(main: string, files: Record<string, string> = {}): string {
  appCount += 1;
  const root = path.join(work, `app${appCount}`);
  write(
    path.join(root, "index.html"),
    '<!doctype html>\n<html>\n  <body>\n    <script type="module" src="./src/main.ts"></script>\n  </body>\n</html>\n',
  );
  write(path.join(root, "src", "main.ts"), `${GPL_HEADER}${main}\n`);
  for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
  return root;
}

function config(root: string, extra: InlineConfig = {}): InlineConfig {
  const { plugins, build: buildOptions, ...rest } = extra;
  return {
    root,
    configFile: false,
    logLevel: "silent",
    ...rest,
    plugins: plugins ?? [createAgplGuard({ serverDir })],
    build: { outDir: "dist", emptyOutDir: true, minify: false, ...buildOptions },
  };
}

/** Builds and returns the text of every output file. */
async function buildApp(root: string, extra: InlineConfig = {}): Promise<string> {
  await build(config(root, extra));
  const out = path.join(root, "dist");
  const texts: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(full);
      else texts.push(fs.readFileSync(full, "utf8"));
    }
  };
  visit(out);
  return texts.join("\n");
}

async function expectBlocked(root: string, extra: InlineConfig = {}): Promise<void> {
  await expect(buildApp(root, extra)).rejects.toThrow(/AGPL guard/);
  // Nothing from the server was written.
  const out = path.join(root, "dist");
  if (fs.existsSync(out)) {
    const leaked = fs
      .readdirSync(out, { recursive: true, encoding: "utf8" })
      .map((file) => path.join(out, file))
      .filter((file) => fs.statSync(file).isFile())
      .some((file) => fs.readFileSync(file, "utf8").includes("AGPL_SECRET"));
    expect(leaked).toBe(false);
  }
}

const TIMEOUT = 20_000;

describe("AGPL guard: path helpers", () => {
  it("compares folders on POSIX and Windows paths", () => {
    expect(isInsideFolder("/r/packages/server/src/a.ts", "/r/packages/server")).toBe(
      true,
    );
    expect(isInsideFolder("/r/packages/server", "/r/packages/server")).toBe(true);
    expect(isInsideFolder("/r/packages/server-x/a.ts", "/r/packages/server")).toBe(false);
    expect(isInsideFolder("/r/packages/server/..x", "/r/packages/server")).toBe(true);
    expect(isInsideFolder("/r/bench/a.ts", "/r/packages/server")).toBe(false);
    const win = path.win32;
    expect(
      isInsideFolder("C:\\r\\packages\\SERVER\\a.ts", "c:\\r\\packages\\server", win),
    ).toBe(true);
    expect(
      isInsideFolder("D:\\r\\packages\\server\\a.ts", "C:\\r\\packages\\server", win),
    ).toBe(false);
  });

  it("reads file paths out of module ids", () => {
    expect(idToPath("/r/a.ts?raw")).toBe("/r/a.ts");
    expect(idToPath("\0/r/a.ts?commonjs-proxy")).toBe("/r/a.ts");
    expect(idToPath("/@fs/r/a.ts")).toBe("/r/a.ts");
    expect(idToPath("file:///r/a.ts#x")).toBe("/r/a.ts");
    expect(idToPath("\0vite/preload-helper")).toBeUndefined();
    expect(idToPath("virtual:x")).toBeUndefined();
    expect(idToPath("/C:/r/a.ts?url", path.win32)).toBe("C:/r/a.ts");
    expect(idToPath("C:\\r\\a.ts?inline", path.win32)).toBe("C:\\r\\a.ts");
    expect(
      idMentionsFolder("\0commonjs:/r/packages/server/a.js", "/r/packages/server", false),
    ).toBe(true);
    expect(
      idMentionsFolder("x:C:\\R\\Packages\\Server\\a.js", "c:/r/packages/server", true),
    ).toBe(true);
    expect(
      idMentionsFolder("\0commonjs:/r/packages/serverx", "/r/packages/server", false),
    ).toBe(false);
  });

  it("recognises AGPL license identifiers", () => {
    expect(hasAgplIdentifier("// SPDX-License-Identifier: AGPL-3.0-or-later")).toBe(true);
    expect(hasAgplIdentifier("/* SPDX-License-Identifier: AGPL-3.0-only */")).toBe(true);
    expect(hasAgplIdentifier("// SPDX-License-Identifier: GPL-3.0-or-later")).toBe(false);
  });
});

describe("AGPL guard: builds", () => {
  it(
    "lets an ordinary app build",
    async () => {
      const root = app('import { x } from "./x.ts";\nconsole.log(x);', {
        "src/x.ts": `${GPL_HEADER}export const x = "GPL_OK";\n`,
      });
      expect(await buildApp(root)).toContain("GPL_OK");
    },
    TIMEOUT,
  );

  it(
    "lets the server build itself",
    async () => {
      write(
        path.join(serverDir, "index.html"),
        '<!doctype html>\n<script type="module" src="./src/index.ts"></script>\n',
      );
      try {
        await build(
          config(serverDir, { build: { outDir: path.join(work, "server-out") } }),
        );
      } finally {
        fs.rmSync(path.join(serverDir, "index.html"));
      }
    },
    TIMEOUT,
  );

  it(
    "stops a conditional dynamic import",
    async () => {
      await expectBlocked(
        app('void import(Math.random() > 2 ? "../../server/src/b.ts" : "./x.ts");', {
          "src/x.ts": `${GPL_HEADER}export {};\n`,
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "stops import.meta.glob with a base option",
    async () => {
      await expectBlocked(
        app('import.meta.glob("./*.ts", { base: "../../server/src", eager: true });'),
      );
    },
    TIMEOUT,
  );

  it(
    "stops CSS Modules composes and @value from the server",
    async () => {
      await expectBlocked(
        app('import styles from "./x.module.css";\nconsole.log(styles);', {
          "src/x.module.css":
            '.x {\n  composes: agpl from "../../server/src/s.css";\n}\n',
        }),
      );
      await expectBlocked(
        app('import styles from "./y.module.css";\nconsole.log(styles);', {
          "src/y.module.css":
            '@value agplColor from "../../server/src/s.css";\n.y {\n  color: agplColor;\n}\n',
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "stops a CSS @import and a ?raw import",
    async () => {
      await expectBlocked(
        app('import "./z.css";', { "src/z.css": '@import "../../server/src/s.css";\n' }),
      );
      await expectBlocked(
        app('import raw from "../../server/src/a.ts?raw";\nconsole.log(raw);'),
      );
    },
    TIMEOUT,
  );

  it(
    "stops an HTML script whose attributes contain >",
    async () => {
      const root = app("export {};");
      write(
        path.join(root, "index.html"),
        '<!doctype html>\n<html>\n  <body>\n    <script type="module" data-note="a>b" src="../server/src/b.ts"></script>\n  </body>\n</html>\n',
      );
      await expectBlocked(root);
    },
    TIMEOUT,
  );

  it(
    "stops a publicDir in or around the server, before copying",
    async () => {
      await expectBlocked(app("export {};"), {
        publicDir: path.join(serverDir, "public"),
      });
      await expectBlocked(app("export {};"), { publicDir: work });
    },
    TIMEOUT,
  );

  it(
    "stops a server file given as a build input",
    async () => {
      const root = app("export {};");
      await expectBlocked(root, {
        build: {
          rollupOptions: {
            input: {
              main: path.join(root, "index.html"),
              srv: path.join(serverDir, "src", "a.ts"),
            },
          },
        },
      });
    },
    TIMEOUT,
  );

  it(
    "stops a plugin that resolves an import into the server before the guard",
    async () => {
      const shim: Plugin = {
        name: "shim",
        enforce: "pre",
        resolveId: (id) =>
          id === "shim" ? path.join(serverDir, "src", "index.ts") : null,
      };
      await expectBlocked(app('import "shim";'), {
        plugins: [shim, createAgplGuard({ serverDir })],
      });
    },
    TIMEOUT,
  );

  it(
    "stops a plugin that passes server code off as a virtual module",
    async () => {
      const virtual: Plugin = {
        name: "virtual",
        enforce: "pre",
        resolveId: (id) => (id === "virtual:x" ? "\0virtual:x" : null),
        load: (id) =>
          id === "\0virtual:x"
            ? fs.readFileSync(path.join(serverDir, "src", "a.ts"), "utf8")
            : null,
      };
      await expectBlocked(app('import "virtual:x";'), {
        plugins: [virtual, createAgplGuard({ serverDir })],
      });
    },
    TIMEOUT,
  );

  it(
    "stops an alias under a computed key",
    async () => {
      await expectBlocked(app('import "@x/srv";'), {
        resolve: { ["alias"]: { "@x/srv": path.join(serverDir, "src", "a.ts") } },
      });
    },
    TIMEOUT,
  );

  it(
    "stops a path through a symbolic link into the server",
    async () => {
      const root = app('import "./link/a.ts";');
      try {
        fs.symlinkSync(
          path.join(serverDir, "src"),
          path.join(root, "src", "link"),
          "junction",
        );
      } catch {
        return; // no permission to create links (Windows without developer mode)
      }
      await expectBlocked(root);
      await expectBlocked(root, { resolve: { preserveSymlinks: true } });
    },
    TIMEOUT,
  );

  it(
    "stops a package path with .. through a dependency without exports",
    async () => {
      const root = app('import "fake/../../../server/src/a.ts";', {
        "node_modules/fake/package.json": '{ "name": "fake", "main": "index.js" }\n',
        "node_modules/fake/index.js": "export {};\n",
      });
      await expectBlocked(root);
    },
    TIMEOUT,
  );

  it(
    "stops new URL() assets and workers from the server",
    async () => {
      await expectBlocked(
        app(
          'console.log(new URL("../../server/public/secret.txt", import.meta.url).href);',
        ),
      );
      await expectBlocked(
        app('new Worker(new URL("./w.ts", import.meta.url), { type: "module" });', {
          "src/w.ts": `${GPL_HEADER}import "../../server/src/a.ts";\n`,
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "stops a sourcemap that lists a server file",
    async () => {
      // A plugin that writes its own sourcemap next to the chunks.
      const mapper: Plugin = {
        name: "mapper",
        renderChunk() {
          this.emitFile({
            type: "asset",
            fileName: "assets/extra.js.map",
            source: JSON.stringify({
              version: 3,
              sources: [
                path.relative(
                  path.join(work, "out", "assets"),
                  path.join(serverDir, "src", "a.ts"),
                ),
              ],
              names: [],
              mappings: "",
            }),
          });
          return null;
        },
      };
      const root = app('console.log("main");');
      await expectBlocked(root, {
        plugins: [createAgplGuard({ serverDir }), mapper],
        build: { outDir: path.join(work, "out") },
      });
    },
    TIMEOUT,
  );
});

describe("AGPL guard: dev server and Vitest", () => {
  it(
    "rejects an import from outside the server, allows the server's own imports",
    async () => {
      const root = app('import "../../server/src/a.ts";');
      const server = await createServer({
        root: work,
        configFile: false,
        logLevel: "silent",
        plugins: [createAgplGuard({ serverDir })],
        server: { middlewareMode: true, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        const appMain = `/${path.relative(work, root).split(path.sep).join("/")}/src/main.ts`;
        await expect(server.ssrLoadModule(appMain)).rejects.toThrow(/AGPL guard/);
        write(path.join(serverDir, "src", "uses.ts"), `${AGPL_HEADER}import "./b.ts";\n`);
        await expect(server.ssrLoadModule("/server/src/uses.ts")).resolves.toBeDefined();
      } finally {
        fs.rmSync(path.join(serverDir, "src", "uses.ts"), { force: true });
        await server.close();
      }
    },
    TIMEOUT,
  );
});
