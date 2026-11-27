// SPDX-License-Identifier: GPL-3.0-or-later

// A Vite plugin that stops a build when anything from the AGPL server package
// (packages/server) would end up in its output. The workspace check reads source
// files and configs and catches the usual ways of reaching the server, but no
// pattern matching can be complete: a plugin, an alias, a glob or a stylesheet can
// always reach a file the check did not foresee. This guard looks at what the
// bundler actually does, so it does not need to understand how a file was reached.
//
// In a build (`vite build`), the build fails when any of these is under the
// server folder, compared on real paths (symbolic links followed):
//
//   - the configured publicDir, or a publicDir that contains the server folder
//     (checked before anything is copied);
//   - an entry (build.rollupOptions.input or build.rolldownOptions.input);
//   - a module that is transformed, and every module in the module graph at the end
//     of the build, with or without "\0" prefixes, query strings and /@fs/ paths;
//   - a file that the build reads through node:fs while it runs: stylesheets read
//     by CSS tooling (@import, CSS Modules composes and @value, Tailwind), assets
//     reached through new URL(..., import.meta.url) or url(), and anything a
//     plugin reads by itself;
//   - the original file of an emitted asset, and every "sources" entry of a
//     sourcemap in the output;
//
// and it also fails when a module's source or an output file carries an AGPL
// SPDX license identifier, which catches server code that a plugin passes off as
// a virtual module. Web workers are bundled separately; the guard adds itself to
// their plugins too.
//
// While Vite serves (the dev server and Vitest), the guard only rejects an import
// from outside the server folder that resolves to a file inside it, so the
// server's own tests still run from the root Vitest config.
//
// A config whose root is inside the server folder (the server's own build) is
// exempt.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig, UserConfig } from "vite";

/** Name of the plugin; the workspace check looks for it in every Vite config. */
export const AGPL_GUARD_NAME = "galatsa:agpl-guard";

export interface AgplGuardOptions {
  /** Absolute path of the folder whose files must not be bundled. */
  readonly serverDir: string;
}

/** What the plugin exposes on its `api` field, for the workspace check. */
export interface AgplGuardApi {
  /** The real path of the guarded folder. */
  readonly serverDir: string;
}

type PathApi = Pick<typeof path, "relative" | "isAbsolute" | "sep" | "resolve">;

/** True if `child` is `parent` or inside it (both absolute, same spelling rules). */
export function isInsideFolder(
  child: string,
  parent: string,
  api: PathApi = path,
): boolean {
  const relative = api.relative(parent, child);
  if (relative === "") return true;
  if (api.isAbsolute(relative)) return false; // another drive on Windows
  const first = relative.split(/[\\/]/)[0];
  return first !== "..";
}

/**
 * The file system path in a module id, or undefined for an id that names no file
 * (a virtual module such as "\0vite/preload-helper", or a bare name). Strips the
 * "\0" prefix, the query and hash, Vite's /@fs/ prefix, file: URLs, and the
 * leading "/" before a Windows drive letter ("/C:/x").
 */
export function idToPath(id: string, api: PathApi = path): string | undefined {
  let value = id.replace(/^\0+/, "");
  if (value.startsWith("file:")) {
    try {
      // Read the URL by the rules of `api`, not of the host: on a Windows host the
      // default would reject a POSIX URL such as file:///r/a.ts, and the other way
      // round. With the default `api` (the host's path module) nothing changes.
      value = fileURLToPath(value.split(/[?#]/)[0] ?? value, {
        windows: api.sep === "\\",
      });
    } catch {
      return undefined;
    }
  }
  value = value.replace(/[?#].*$/s, "");
  if (value.startsWith("/@fs/")) value = value.slice("/@fs".length);
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  if (value === "" || !api.isAbsolute(value)) return undefined;
  return value;
}

/**
 * True if an id mentions the folder anywhere, also behind a prefix such as
 * "\0commonjs-proxy:" that idToPath cannot strip. Separators and, on Windows and
 * macOS, letter case are ignored.
 */
export function idMentionsFolder(id: string, folder: string, caseInsensitive: boolean) {
  const normalize = (text: string): string => {
    const slashes = text.replace(/\\/g, "/");
    return caseInsensitive ? slashes.toLowerCase() : slashes;
  };
  const haystack = normalize(id);
  const needle = normalize(folder).replace(/\/+$/, "");
  return haystack.includes(`${needle}/`) || haystack.endsWith(needle);
}

/** Matches an AGPL license identifier in a file header or anywhere in a bundle. */
const AGPL_SPDX = /SPDX-License-Identifier:[^\n\r]*\bAGPL-\d/;

/** True if source text carries an AGPL SPDX license identifier. */
export function hasAgplIdentifier(text: string): boolean {
  return AGPL_SPDX.test(text);
}

/**
 * Where a path really is: symbolic links followed, and for a path that does not
 * exist, the real location of its nearest existing parent plus the rest.
 */
function realPathOf(absolute: string): string {
  let existing = path.resolve(absolute);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(absolute);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

// File reads during a build -------------------------------------------------------

interface ReadWatcher {
  readonly serverDir: string;
  /** Returns an error to throw for a read of `real`, or undefined to allow it. */
  readonly check: (real: string, kind: "file" | "tree") => Error | undefined;
}

interface ReadRegistry {
  readonly watchers: Set<ReadWatcher>;
  restore: (() => void) | undefined;
}

// Shared through globalThis: Vite bundles each config file with the modules it
// imports, so one process can hold several copies of this module.
const REGISTRY_KEY = Symbol.for("galatsa.agpl-guard.reads");

function registry(): ReadRegistry {
  const store = globalThis as { [REGISTRY_KEY]?: ReadRegistry };
  store[REGISTRY_KEY] ??= { watchers: new Set(), restore: undefined };
  return store[REGISTRY_KEY];
}

function pathArgument(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL)
    return value.protocol === "file:" ? fileURLToPath(value) : undefined;
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  return undefined; // a file descriptor or a FileHandle
}

function readViolation(value: unknown, kind: "file" | "tree"): Error | undefined {
  const given = pathArgument(value);
  if (given === undefined) return undefined;
  const real = realPathOf(given);
  for (const watcher of registry().watchers) {
    const error = watcher.check(real, kind);
    if (error !== undefined) return error;
  }
  return undefined;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** What a wrapped function does instead when it is asked for a server file. */
type Denial = "empty" | "skip" | "fail";

/** The empty result of a read: "" when an encoding was asked for, else a Buffer. */
function emptyContent(options: unknown): string | Buffer {
  const encoding =
    typeof options === "string"
      ? options
      : options !== null && typeof options === "object"
        ? (options as { encoding?: unknown }).encoding
        : undefined;
  return typeof encoding === "string" && encoding !== "buffer" ? "" : Buffer.alloc(0);
}

/**
 * Wraps the node:fs functions that read file contents or copy files, so that every
 * read during a build is checked. Installed while at least one guarded build runs.
 *
 * A read of a server file is recorded (the build then fails with the reason) and
 * answered without the file's content: reads return nothing and copies do
 * nothing. Throwing instead would be simpler, but some tools ignore read errors
 * and then crash with a message that hides the reason (postcss-modules does).
 * Opening a file or a read stream fails with the guard's error.
 */
function installReadHooks(): () => void {
  const patched: Array<[Record<string, unknown>, string, unknown]> = [];
  const wrap = (
    target: Record<string, unknown>,
    name: string,
    style: "callback" | "sync" | "promise",
    kind: "file" | "tree",
    denial: Denial,
  ): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    const fn = original as AnyFunction;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const error = readViolation(args[0], kind);
      if (error === undefined) return fn.apply(this, args);
      const result = denial === "empty" ? emptyContent(args[1]) : undefined;
      if (style === "promise") {
        return denial === "fail" ? Promise.reject(error) : Promise.resolve(result);
      }
      const callback = args.at(-1);
      if (style === "callback" && typeof callback === "function") {
        if (denial === "fail") process.nextTick(callback as (e: Error) => void, error);
        else process.nextTick(callback as (e: null, r: unknown) => void, null, result);
        return undefined;
      }
      if (denial === "fail") throw error;
      return result;
    };
    patched.push([target, name, original]);
    target[name] = wrapped;
  };
  const sync = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  wrap(sync, "readFile", "callback", "file", "empty");
  wrap(sync, "readFileSync", "sync", "file", "empty");
  wrap(promises, "readFile", "promise", "file", "empty");
  wrap(sync, "copyFile", "callback", "file", "skip");
  wrap(sync, "copyFileSync", "sync", "file", "skip");
  wrap(promises, "copyFile", "promise", "file", "skip");
  wrap(sync, "cp", "callback", "tree", "skip");
  wrap(sync, "cpSync", "sync", "tree", "skip");
  wrap(promises, "cp", "promise", "tree", "skip");
  wrap(sync, "open", "callback", "file", "fail");
  wrap(sync, "openSync", "sync", "file", "fail");
  wrap(promises, "open", "promise", "file", "fail");
  wrap(sync, "createReadStream", "sync", "file", "fail");
  syncBuiltinESMExports();
  return () => {
    for (const [target, name, original] of patched.reverse()) target[name] = original;
    syncBuiltinESMExports();
  };
}

function watchReads(watcher: ReadWatcher): () => void {
  const reads = registry();
  reads.watchers.add(watcher);
  reads.restore ??= installReadHooks();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    reads.watchers.delete(watcher);
    if (reads.watchers.size === 0) {
      reads.restore?.();
      reads.restore = undefined;
    }
  };
}

// The plugin ------------------------------------------------------------------------

function inputPaths(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.filter((item) => typeof item === "string");
  if (input !== null && typeof input === "object") {
    return Object.values(input).filter((item) => typeof item === "string");
  }
  return [];
}

/**
 * The guard for one folder. Use agplGuard() from vite.shared.ts in configs; this
 * factory takes the folder as an option for the guard's own tests.
 */
export function createAgplGuard(options: AgplGuardOptions): Plugin {
  const serverDir = realPathOf(options.serverDir);
  let config: ResolvedConfig | undefined;
  let exempt = false;
  let building = false;
  let stopWatching: (() => void) | undefined;
  const readViolations: string[] = [];

  const under = (real: string): boolean => isInsideFolder(real, serverDir);

  // Paths in messages are relative to the folder above the server's parent
  // (the repository root for packages/server).
  const describe = (file: string): string => {
    const base = path.dirname(path.dirname(serverDir));
    const relative = path.relative(base, file);
    return isInsideFolder(file, base) ? relative.split(path.sep).join("/") : file;
  };

  const message = (what: string): string =>
    `AGPL guard: ${what}. Files under ${describe(serverDir)} are AGPL-3.0-or-later and must not be bundled into the GPL program. ` +
    "Share code through a GPL workspace package instead.";

  /** The real path of a module id under the server folder, if it is one. */
  const serverFileOf = (id: string): string | undefined => {
    const file = idToPath(id);
    if (file !== undefined) {
      const real = realPathOf(file);
      if (under(real)) return real;
      return undefined;
    }
    // A relative id (an alias to "../x.ts" can produce one) is read from the
    // working folder or the config root.
    const plain = id.replace(/^\0+/, "").replace(/[?#].*$/s, "");
    if (/^\.\.?[\\/]/.test(plain)) {
      for (const base of new Set([process.cwd(), config?.root ?? process.cwd()])) {
        const real = realPathOf(path.resolve(base, plain));
        if (under(real)) return real;
      }
    }
    return idMentionsFolder(id, serverDir, CASE_INSENSITIVE) ? id : undefined;
  };

  const stop = (): void => {
    stopWatching?.();
    stopWatching = undefined;
  };

  const plugin: Plugin = {
    name: AGPL_GUARD_NAME,
    enforce: "pre",
    api: { serverDir } satisfies AgplGuardApi,

    config(user: UserConfig) {
      // Workers are bundled with their own plugin list: add a guard there as well.
      const previous = user.worker?.plugins as unknown;
      user.worker = {
        ...user.worker,
        plugins: () =>
          [
            createAgplGuard(options),
            ...(typeof previous === "function"
              ? (previous as () => unknown[])()
              : Array.isArray(previous)
                ? previous
                : []),
          ] as ReturnType<NonNullable<NonNullable<UserConfig["worker"]>["plugins"]>>,
      };
    },

    configResolved(resolved) {
      config = resolved;
      exempt = under(realPathOf(resolved.root));
      building = resolved.command === "build" && !exempt;
      if (!building) return;
      if (resolved.publicDir) {
        const publicDir = realPathOf(resolved.publicDir);
        if (under(publicDir) || isInsideFolder(serverDir, publicDir)) {
          throw new Error(
            message(
              `publicDir ${resolved.publicDir} is or contains ${describe(serverDir)}`,
            ),
          );
        }
      }
      const build = resolved.build as {
        rollupOptions?: { input?: unknown };
        rolldownOptions?: { input?: unknown };
      };
      const inputs = [
        ...inputPaths(build.rollupOptions?.input),
        ...inputPaths(build.rolldownOptions?.input),
      ];
      for (const input of inputs) {
        const real = serverFileOf(path.resolve(resolved.root, input));
        if (real !== undefined)
          throw new Error(message(`the build entry ${input} is ${describe(real)}`));
      }
    },

    buildStart() {
      if (!building) return;
      stop();
      readViolations.length = 0;
      stopWatching = watchReads({
        serverDir,
        check: (real, kind) => {
          if (under(real) || (kind === "tree" && isInsideFolder(serverDir, real))) {
            const error = new Error(message(`the build read ${describe(real)}`));
            // Some tools swallow read errors (Vite treats an unreadable asset as
            // missing): show the reason now and fail the build at its next step.
            if (!readViolations.includes(error.message)) {
              readViolations.push(error.message);
              config?.logger.error(error.message);
            }
            return error;
          }
          return undefined;
        },
      });
    },

    async resolveId(source, importer, resolveOptions) {
      // While serving (dev server, Vitest): an import from outside the server folder
      // must not resolve into it. A build checks the module graph instead.
      if (config?.command !== "serve" || exempt || importer === undefined) return null;
      // Only real files count as importers: Vite resolves entries from a stand-in
      // index.html in the root, and Vitest's test files have no importer.
      const importerFile = idToPath(importer);
      if (importerFile === undefined || !fs.existsSync(importerFile)) return null;
      if (serverFileOf(importer) !== undefined) return null;
      const resolved = await this.resolve(source, importer, {
        ...resolveOptions,
        skipSelf: true,
      });
      if (resolved && !resolved.external) {
        const real = serverFileOf(resolved.id);
        if (real !== undefined) {
          this.error(
            message(`${importer} imports "${source}", which is ${describe(real)}`),
          );
        }
      }
      return null;
    },

    transform(code, id) {
      if (!building) return null;
      const real = serverFileOf(id);
      if (real !== undefined)
        this.error(message(`the module ${describe(real)} is part of the build`));
      if (hasAgplIdentifier(code)) {
        this.error(message(`the module ${id} carries an AGPL license identifier`));
      }
      return null;
    },

    buildEnd(error) {
      if (!building) return;
      if (error) {
        stop();
        return;
      }
      for (const id of this.getModuleIds()) {
        const real = serverFileOf(id);
        if (real === undefined) continue;
        const importers = this.getModuleInfo(id)?.importers ?? [];
        const by = importers.length > 0 ? `, imported by ${importers.join(", ")}` : "";
        stop();
        this.error(message(`the module ${describe(real)} is part of the build${by}`));
      }
      if (readViolations[0] !== undefined) {
        stop();
        this.error(readViolations[0]);
      }
    },

    renderError() {
      stop();
    },

    generateBundle(outputOptions, bundle) {
      if (!building || config === undefined) return;
      const root = config.root;
      const outDir = path.resolve(
        root,
        outputOptions.dir ??
          (outputOptions.file ? path.dirname(outputOptions.file) : config.build.outDir),
      );
      const fail = (what: string): never => {
        stop();
        return this.error(message(what));
      };
      if (readViolations[0] !== undefined) {
        stop();
        this.error(readViolations[0]);
      }
      const checkMap = (fileName: string, map: unknown): void => {
        if (map === null || typeof map !== "object") return;
        const { sources, sourceRoot, sourcesContent } = map as {
          sources?: unknown;
          sourceRoot?: unknown;
          sourcesContent?: unknown;
        };
        const base = path.resolve(
          outDir,
          path.dirname(fileName),
          typeof sourceRoot === "string" ? sourceRoot : "",
        );
        for (const source of Array.isArray(sources) ? sources : []) {
          if (typeof source !== "string") continue;
          const id = source.startsWith("\0") ? source : path.resolve(base, source);
          const real = serverFileOf(id);
          if (real !== undefined)
            fail(`the sourcemap of ${fileName} lists ${describe(real)}`);
        }
        for (const content of Array.isArray(sourcesContent) ? sourcesContent : []) {
          if (typeof content === "string" && hasAgplIdentifier(content)) {
            fail(
              `the sourcemap of ${fileName} contains a file with an AGPL license identifier`,
            );
          }
        }
      };
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          for (const id of item.moduleIds) {
            const real = serverFileOf(id);
            if (real !== undefined)
              fail(`the chunk ${item.fileName} contains ${describe(real)}`);
          }
          if (hasAgplIdentifier(item.code)) {
            fail(`the chunk ${item.fileName} carries an AGPL license identifier`);
          }
          checkMap(item.fileName, item.map);
          continue;
        }
        for (const original of item.originalFileNames ?? []) {
          const real = serverFileOf(path.resolve(root, original));
          if (real !== undefined)
            fail(`the asset ${item.fileName} comes from ${describe(real)}`);
        }
        const text =
          typeof item.source === "string"
            ? item.source
            : item.source.byteLength <= 64 * 1024 * 1024
              ? Buffer.from(item.source).toString("utf8")
              : "";
        if (hasAgplIdentifier(text)) {
          fail(`the asset ${item.fileName} carries an AGPL license identifier`);
        }
        if (item.fileName.endsWith(".map")) {
          try {
            checkMap(item.fileName.slice(0, -".map".length), JSON.parse(text));
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
    },

    writeBundle() {
      // Reads after generateBundle (none are expected) still fail the build.
      if (building && readViolations[0] !== undefined) {
        stop();
        this.error(readViolations[0]);
      }
    },

    closeBundle() {
      stop();
    },
  };
  return plugin;
}
