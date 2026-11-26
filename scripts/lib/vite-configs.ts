// SPDX-License-Identifier: GPL-3.0-or-later

// Rules for the Vite and Vitest configs of the workspace, used by the workspace
// check (scripts/check-workspace.ts):
//
// - Every vite.config.* and vitest.config.* file, and every file a package script
//   passes to vite or vitest with --config / -c, must resolve to a config that
//   contains the AGPL guard (scripts/lib/agpl-guard.ts) for this repository's
//   packages/server. The check loads each config with Vite itself, so it does not
//   matter how the config is written, only what it amounts to.
// - A package whose scripts run `vite` must have a vite.config.* file at its top,
//   because Vite without a config file has no guard.
// - Package scripts must not run other bundlers (Rollup, Rolldown, esbuild,
//   webpack, ...), which the guard does not cover. TypeScript's tsc does not bundle
//   and is fine.

import { AGPL_GUARD_NAME, type AgplGuardApi } from "./agpl-guard.ts";
import type { WorkspacePackage } from "./workspace.ts";

/** Vite and Vitest config files, at any depth. */
export const VITE_CONFIG_PATTERN = /(?:^|\/)(?:vite|vitest)\.config\.[cm]?[jt]s$/;

/** Bundlers other than Vite, by the command a package script would run. */
const OTHER_BUNDLERS: readonly string[] = [
  "rollup",
  "rolldown",
  "esbuild",
  "webpack",
  "webpack-cli",
  "parcel",
  "rspack",
  "rsbuild",
  "tsup",
  "tsdown",
  "microbundle",
  "unbuild",
  "ncc",
];

/** Words of a shell command line, split at whitespace and the usual operators. */
function commandWords(script: string): string[][] {
  return script.split(/&&|\|\||[;|&()]/).map((part) =>
    part
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0),
  );
}

/** The program a command runs, skipping env assignments, npx, pnpm exec and the like. */
function programOf(words: readonly string[]): { program: string; rest: string[] } {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "env" || word === "cross-env") {
      index += 1;
    } else if (["npx", "pnpx", "bunx"].includes(word)) {
      index += 1;
    } else if (["pnpm", "npm", "yarn"].includes(word) && words[index + 1] === "exec") {
      index += 2;
    } else if (word.startsWith("-") && index > 0) {
      index += 1; // an option of npx or exec
    } else {
      break;
    }
  }
  const program = (words[index] ?? "").replace(/^.*[\\/]/, "");
  return { program, rest: words.slice(index + 1) };
}

export interface ScriptFindings {
  /** Config files named with --config or -c, relative to the package. */
  readonly configs: string[];
  readonly problems: string[];
}

/** Reads a package's scripts for Vite runs, config files and other bundlers. */
export function checkBuildScripts(pkg: WorkspacePackage): ScriptFindings {
  const configs: string[] = [];
  const problems: string[] = [];
  const name = typeof pkg.manifest.name === "string" ? pkg.manifest.name : "(no name)";
  const label = `${name} (${pkg.path})`;
  let runsVite = false;
  for (const [scriptName, value] of Object.entries(pkg.manifest.scripts ?? {})) {
    if (typeof value !== "string") continue;
    for (const words of commandWords(value)) {
      const { program, rest } = programOf(words);
      if (program === "vite" || program === "vitest") {
        if (program === "vite") runsVite = true;
        rest.forEach((word, index) => {
          const inline = /^(?:--config|-c)=(.+)$/.exec(word);
          if (inline?.[1] !== undefined) configs.push(inline[1]);
          else if (
            (word === "--config" || word === "-c") &&
            rest[index + 1] !== undefined
          ) {
            configs.push(rest[index + 1] as string);
          }
        });
      } else if (OTHER_BUNDLERS.includes(program)) {
        problems.push(
          `${label}: script "${scriptName}" runs ${program}. Bundle with Vite and the shared config (vite.shared.ts), which guards against AGPL code.`,
        );
      }
    }
  }
  const hasTopConfig = pkg.files.some((file) => /^vite\.config\.[cm]?[jt]s$/.test(file));
  if (runsVite && !hasTopConfig) {
    problems.push(
      `${label}: its scripts run vite, but it has no vite.config.ts. Without a config file Vite has no AGPL guard; add one that uses vite.shared.ts.`,
    );
  }
  return { configs, problems };
}

/** The parts of a resolved Vite plugin the guard check looks at. */
export interface PluginLike {
  readonly name?: unknown;
  readonly api?: unknown;
  readonly apply?: unknown;
  readonly enforce?: unknown;
  readonly [hook: string]: unknown;
}

const GUARD_HOOKS = [
  "config",
  "configResolved",
  "buildStart",
  "resolveId",
  "transform",
  "buildEnd",
  "generateBundle",
];

/**
 * Undefined if the resolved plugins of a config contain a working AGPL guard for
 * `serverDir` (a real path); otherwise what is wrong.
 */
export function guardProblem(
  plugins: readonly PluginLike[],
  serverDir: string,
): string | undefined {
  const guards = plugins.filter((plugin) => plugin.name === AGPL_GUARD_NAME);
  if (guards.length === 0) {
    return "has no AGPL guard. Spread workspaceSourceResolve from vite.shared.ts into it, or wrap it in workspaceConfig() when it has plugins of its own";
  }
  for (const guard of guards) {
    const api = guard.api as Partial<AgplGuardApi> | undefined;
    const hooksIntact = GUARD_HOOKS.every((hook) => {
      const value = guard[hook];
      return (
        typeof value === "function" ||
        (value !== null &&
          typeof value === "object" &&
          typeof (value as { handler?: unknown }).handler === "function")
      );
    });
    if (
      api?.serverDir === serverDir &&
      guard.apply === undefined &&
      guard.enforce === "pre" &&
      hooksIntact
    ) {
      return undefined;
    }
  }
  return "has an AGPL guard that was changed or points at another folder. Use agplGuard() from vite.shared.ts as it is";
}
