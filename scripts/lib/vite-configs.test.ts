// SPDX-License-Identifier: GPL-3.0-or-later

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig, type UserConfig } from "vite";
import { agplGuard, workspaceConfig, workspaceSourceResolve } from "../../vite.shared.ts";
import { checkBuildScripts, guardProblem, type PluginLike } from "./vite-configs.ts";
import type { Manifest, WorkspacePackage } from "./workspace.ts";

const repository = join(import.meta.dirname, "..", "..");
const serverDir = (() => {
  try {
    return realpathSync.native(join(repository, "packages", "server"));
  } catch {
    return join(realpathSync.native(repository), "packages", "server");
  }
})();

async function problemOf(config: UserConfig): Promise<string | undefined> {
  const resolved = await resolveConfig(
    { ...config, configFile: false, root: repository, logLevel: "silent" },
    "build",
    "production",
  );
  return guardProblem(resolved.plugins as readonly PluginLike[], serverDir);
}

const other = { name: "other", enforce: "pre" as const, resolveId: () => null };

describe("the AGPL guard in configs", () => {
  it("is there when a config spreads the shared settings or uses workspaceConfig()", async () => {
    expect(await problemOf({ ...workspaceSourceResolve })).toBeUndefined();
    expect(await problemOf(workspaceConfig({ plugins: [other] }))).toBeUndefined();
    expect(
      await problemOf({
        ...workspaceSourceResolve,
        plugins: [...workspaceSourceResolve.plugins, other],
      }),
    ).toBeUndefined();
  });

  it("is missing when a plugins key replaces the shared one", async () => {
    expect(await problemOf({ ...workspaceSourceResolve, plugins: [other] })).toMatch(
      /has no AGPL guard/,
    );
    expect(await problemOf({})).toMatch(/has no AGPL guard/);
  });

  it("is rejected when it was changed", async () => {
    const guard = agplGuard();
    expect(await problemOf({ plugins: [{ ...guard, transform: undefined }] })).toMatch(
      /changed or points at another folder/,
    );
    // Vite leaves out a plugin whose apply() says no, so the guard counts as missing.
    expect(await problemOf({ plugins: [{ ...guard, apply: () => false }] })).toMatch(
      /AGPL guard/,
    );
    expect(
      await problemOf({ plugins: [{ ...guard, api: { serverDir: "/elsewhere" } }] }),
    ).toMatch(/changed/);
  });
});

function pkg(scripts: Record<string, string>, files: string[] = []): WorkspacePackage {
  const manifest: Manifest = { name: "@galatsa/x", scripts };
  return { path: "apps/x", manifest, files, read: () => "" };
}

describe("package scripts", () => {
  it("needs a vite.config for scripts that run vite", () => {
    expect(checkBuildScripts(pkg({ build: "tsc && vite build" })).problems).toEqual([
      expect.stringMatching(/run vite, but it has no vite.config.ts/),
    ]);
    expect(
      checkBuildScripts(pkg({ build: "vite build" }, ["vite.config.ts"])).problems,
    ).toEqual([]);
  });

  it("collects configs given with --config and -c", () => {
    const found = checkBuildScripts(
      pkg(
        {
          a: "vite build --config other.ts",
          b: "pnpm exec vite -c=third.mts",
          c: "vitest -c v.ts",
        },
        ["vite.config.ts"],
      ),
    );
    expect(found.configs).toEqual(["other.ts", "third.mts", "v.ts"]);
  });

  it("rejects other bundlers", () => {
    const found = checkBuildScripts(
      pkg({
        a: "rollup -c",
        b: "NODE_ENV=production npx esbuild src/x.ts",
        c: "tsc -p .",
      }),
    );
    expect(found.problems).toHaveLength(2);
    expect(found.problems[0]).toMatch(/runs rollup/);
    expect(found.problems[1]).toMatch(/runs esbuild/);
  });
});
