// SPDX-License-Identifier: GPL-3.0-or-later

// Vite settings shared by vitest.config.ts and the vite.config.ts of each app and
// browser package. Every Vite and Vitest config in the workspace must use them; the
// workspace check loads each config and fails if the AGPL guard is missing.
//
// A config without plugins of its own spreads the shared settings:
//
//   export default defineConfig({ ...workspaceSourceResolve, build: { ... } });
//
// A config with plugins of its own passes its settings through workspaceConfig(),
// which merges the plugin lists (a "plugins" key after the spread would replace the
// guard):
//
//   export default defineConfig(workspaceConfig({ plugins: [react()] }));
//
// The settings add the "@galatsa/source" export condition (see tsconfig.base.json),
// so Vite and Vitest load other workspace packages from their src/ instead of their
// dist/, and no build is needed first. Setting "conditions" replaces Vite's
// defaults, so the defaults are listed again. "ssr" covers Vitest's Node
// environment. They also add the AGPL guard (scripts/lib/agpl-guard.ts), which
// fails a build that would bundle anything from packages/server.

import { join } from "node:path";
import {
  defaultClientConditions,
  defaultServerConditions,
  mergeConfig,
  type Plugin,
  type UserConfig,
} from "vite";
import { AGPL_GUARD_NAME, createAgplGuard } from "./scripts/lib/agpl-guard.ts";
import { SERVER_PATH } from "./scripts/lib/project-license.ts";

/**
 * Extensions of test files. Vitest runs every "*.test.<ext>" file, and
 * tsconfig.build.base.json keeps the same files out of dist/.
 */
export const TEST_FILE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
] as const;

/** Glob for every test file, for Vitest's "include". */
export const TEST_FILE_GLOB = `**/*.test.{${TEST_FILE_EXTENSIONS.join(",")}}`;

export const SOURCE_CONDITION = "@galatsa/source";

export { AGPL_GUARD_NAME };

/** The AGPL server package folder of this repository. */
const SERVER_DIR = join(import.meta.dirname, ...SERVER_PATH.split("/"));

/** A new AGPL guard for this repository's packages/server. */
export function agplGuard(): Plugin {
  return createAgplGuard({ serverDir: SERVER_DIR });
}

export const workspaceSourceResolve = {
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
    },
  },
  // A getter, so that every config that spreads these settings gets its own guard.
  get plugins(): Plugin[] {
    return [agplGuard()];
  },
} satisfies UserConfig;

/** The shared settings merged with a config's own; plugin lists are joined. */
export function workspaceConfig(config: UserConfig): UserConfig {
  return mergeConfig<UserConfig, UserConfig>({ ...workspaceSourceResolve }, config);
}
