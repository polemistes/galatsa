// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the workspace check (scripts/check-workspace.ts): rules for the
// project's own packages. docs/new-package.md explains them for people.
//
// - Each package's "license" field matches its location (scripts/lib/project-license.ts).
// - Each package has the files and fields its kind needs (see PACKAGE_KINDS). Its
//   tsconfig.json extends tsconfig.base.json, its tsconfig.build.json extends
//   tsconfig.build.base.json, and the two declare the same environment ("lib" and
//   "types"), so code that type-checks also builds.
// - No package except packages/server reaches packages/server, so AGPL code cannot
//   reach the shipped program. What counts is the target, not the declared name: an
//   alias ("srv": "workspace:@galatsa/server@*"), a link:, file: or workspace: path,
//   and a link: in the lockfile (from an override) are all caught. Relative imports
//   are caught by the next rule.
// - Every reference in a source file (JS/TS imports, CSS @import and url(), HTML
//   script and link elements, new URL(..., import.meta.url), import.meta.glob) is
//   either a file inside the package's own folder, or a package declared in its own
//   package.json (any dependency field). A relative path may not leave the folder or
//   reach into a nested workspace package, and a package must not rely on another
//   package's dependencies being reachable in node_modules. Node built-ins count
//   only with the "node:" prefix: a bare "events" is the npm package of that name.
//   - "Inside the folder" is decided on the real path: a symbolic link inside the
//     package that points elsewhere (bench/src/srv -> packages/server/src) is
//     rejected itself, and a path through one is rejected as leaving the package.
//   - A "#name" import must be declared in the package's "imports" field.
//   - An import() or require() of a template string or a concatenation is checked
//     by its fixed start: `../x/${name}.ts` must stay inside the package, and its
//     folder must not contain a nested workspace package. If the fixed start says
//     nothing (`${base}/x.ts`), the import is rejected, because a bundler would
//     still follow it.
//   - Aliases are references too: "paths" in tsconfig files, and resolve.alias in
//     vite.config and vitest.config files, evaluated where they are literal paths,
//     path.resolve(import.meta.dirname, ...) and the like; any other alias value is
//     rejected because it cannot be checked.
//   - Backslashes, file: URLs and Vite's /@fs/ paths are rejected in specifiers.
// - The targets in package.json "exports" and "imports" follow the same rules.
// - Packages run by Node from source (NODE_RUN_PATHS) must not depend, directly or
//   through other workspace packages, on a package with .tsx or .jsx files: Node's
//   type stripping cannot load them. Test files do not count, Node never loads them
//   from another package.

import { isBuiltin } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { linksInto, type Lockfile } from "./lockfile.ts";
import { licenseForPath, SERVER_PATH } from "./project-license.ts";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Workspace packages that Node runs directly from source (the root runs scripts/). */
export const NODE_RUN_PATHS: readonly string[] = [".", "bench"];

/** Script file extensions whose imports are checked. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Stylesheet extensions whose @import, @use and url() references are checked. */
export const STYLE_EXTENSIONS: readonly string[] = [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".pcss",
  ".postcss",
];

/** HTML files, whose script, link and media elements are checked. */
export const HTML_EXTENSIONS: readonly string[] = [".html", ".htm"];

/**
 * Root files that a config file at the top of another package (for example
 * bench/vite.config.ts) may import with a relative path. The bare imports of such a
 * file must then be declared by the importing package as well.
 */
export const SHARED_ROOT_FILES: readonly string[] = ["vite.shared.ts"];

const CONFIG_FILE = /^[^/]+\.config\.(ts|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;

export interface Manifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly license?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly exports?: unknown;
  readonly imports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  /** Folder relative to the repository root, "/" separators, "." for the root. */
  readonly path: string;
  readonly manifest: Manifest;
  /** Files of the package (not of nested packages), relative to the package folder. */
  readonly files: readonly string[];
  /** Reads a file of the package, path relative to the package folder. */
  readonly read: (file: string) => string;
  /**
   * Where a path relative to the package folder really is, after following
   * symbolic links, relative to the repository root with "/" separators (it starts
   * with "../" when outside the repository). For a path that does not exist, the
   * real location of its nearest existing parent plus the rest. Undefined in tests
   * without a file system: paths are then taken as written.
   */
  readonly realPath?: (path: string) => string;
  /** Files of the package that are symbolic links. */
  readonly symlinks?: readonly string[];
}

export type PackageKind = "root" | "library" | "app" | "tooling";

/** The kind of a package, from its location; undefined if it is in an unexpected place. */
export function kindOf(path: string): PackageKind | undefined {
  if (path === ".") return "root";
  if (/^packages\/[^/]+$/.test(path) || /^packages\/extensions\/[^/]+$/.test(path)) {
    return "library";
  }
  if (/^apps\/[^/]+$/.test(path)) return "app";
  if (path === "bench" || path === "tests/e2e") return "tooling";
  return undefined;
}

/** What each kind of package must have. */
const PACKAGE_KINDS: Record<
  PackageKind,
  { files: readonly string[]; scripts: readonly string[]; sourceExports: boolean }
> = {
  root: { files: [], scripts: [], sourceExports: false },
  library: {
    files: ["tsconfig.json", "tsconfig.build.json"],
    scripts: ["typecheck", "build"],
    sourceExports: true,
  },
  app: {
    files: ["tsconfig.json"],
    scripts: ["typecheck", "build"],
    sourceExports: false,
  },
  tooling: { files: ["tsconfig.json"], scripts: ["typecheck"], sourceExports: false },
};

function label(pkg: WorkspacePackage): string {
  const name = typeof pkg.manifest.name === "string" ? pkg.manifest.name : "(no name)";
  return `${name} (${pkg.path})`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Path of a package file relative to the repository root. */
function repoPath(pkg: WorkspacePackage, file: string): string {
  return posix.normalize(posix.join(pkg.path, file));
}

function leavesRepository(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("/");
}

function isInside(path: string, folder: string): boolean {
  return folder === "." || path === folder || path.startsWith(`${folder}/`);
}

/** Checks the license field, the required files, scripts and exports of one package. */
export function checkStructure(pkg: WorkspacePackage): string[] {
  const problems: string[] = [];
  const kind = kindOf(pkg.path);
  if (kind === undefined) {
    return [
      `${label(pkg)}: workspace packages belong in packages/, packages/extensions/, apps/, bench or tests/e2e.`,
    ];
  }
  const expected = licenseForPath(pkg.path);
  if (pkg.manifest.license !== expected) {
    problems.push(
      `${label(pkg)}: "license" is ${JSON.stringify(pkg.manifest.license)}, must be "${expected}".`,
    );
  }
  if (pkg.manifest.private !== true) {
    problems.push(`${label(pkg)}: must have "private": true.`);
  }
  const rules = PACKAGE_KINDS[kind];
  for (const file of rules.files) {
    if (!pkg.files.includes(file)) problems.push(`${label(pkg)}: ${file} is missing.`);
  }
  for (const script of rules.scripts) {
    if (typeof pkg.manifest.scripts?.[script] !== "string") {
      problems.push(`${label(pkg)}: the "${script}" script is missing.`);
    }
  }
  if (rules.sourceExports) problems.push(...checkSourceExports(pkg));
  if (kind !== "root") problems.push(...checkTsconfigs(pkg));
  return problems;
}

interface TsconfigJson {
  readonly extends?: unknown;
  readonly exclude?: unknown;
  readonly compilerOptions?: { readonly lib?: unknown; readonly types?: unknown };
}

function readTsconfig(pkg: WorkspacePackage, file: string): TsconfigJson | undefined {
  if (!pkg.files.includes(file)) return undefined;
  const { config } = ts.parseConfigFileTextToJson(file, pkg.read(file));
  return isObject(config) ? (config as TsconfigJson) : {};
}

/** True if "extends" names the given root file, as a string or in an array. */
function extendsRootFile(
  pkg: WorkspacePackage,
  config: TsconfigJson,
  rootFile: string,
): boolean {
  const values = Array.isArray(config.extends) ? config.extends : [config.extends];
  return values.some(
    (value) => typeof value === "string" && repoPath(pkg, value) === rootFile,
  );
}

/** "lib" or "types" as a comparable string; undefined means inherited from the base. */
function environmentOf(value: unknown): string {
  if (value === undefined) return "(inherited)";
  if (!Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(value.map((item) => String(item).toLowerCase()).sort());
}

function checkTsconfigs(pkg: WorkspacePackage): string[] {
  const problems: string[] = [];
  const main = readTsconfig(pkg, "tsconfig.json");
  const build = readTsconfig(pkg, "tsconfig.build.json");
  if (main !== undefined && !extendsRootFile(pkg, main, "tsconfig.base.json")) {
    problems.push(
      `${label(pkg)}: tsconfig.json must extend "${posix.relative(pkg.path, "tsconfig.base.json")}".`,
    );
  }
  if (build === undefined) return problems;
  if (!extendsRootFile(pkg, build, "tsconfig.build.base.json")) {
    problems.push(
      `${label(pkg)}: tsconfig.build.json must extend "${posix.relative(pkg.path, "tsconfig.build.base.json")}".`,
    );
  }
  if (build.exclude !== undefined) {
    problems.push(
      `${label(pkg)}: tsconfig.build.json must not set "exclude"; the shared one in tsconfig.build.base.json keeps tests out of dist/.`,
    );
  }
  if (main !== undefined) {
    for (const option of ["lib", "types"] as const) {
      const inMain = environmentOf(main.compilerOptions?.[option]);
      const inBuild = environmentOf(build.compilerOptions?.[option]);
      if (inMain !== inBuild) {
        problems.push(
          `${label(pkg)}: "${option}" is ${inMain} in tsconfig.json but ${inBuild} in tsconfig.build.json. ` +
            "Set the same environment in both, or the build fails where type checking passes.",
        );
      }
    }
  }
  return problems;
}

function checkSourceExports(pkg: WorkspacePackage): string[] {
  const exports = pkg.manifest.exports;
  if (!isObject(exports) || !isObject(exports["."])) {
    return [`${label(pkg)}: "exports" must have a "." entry with conditions.`];
  }
  const problems: string[] = [];
  for (const [subpath, conditions] of Object.entries(exports)) {
    // Tools read package.json through this entry; it has no source to point at.
    if (subpath === "./package.json" && conditions === "./package.json") continue;
    const first = isObject(conditions) ? Object.entries(conditions)[0] : undefined;
    if (
      first === undefined ||
      first[0] !== "@galatsa/source" ||
      typeof first[1] !== "string" ||
      !first[1].startsWith("./src/")
    ) {
      problems.push(
        `${label(pkg)}: exports["${subpath}"] must list "@galatsa/source": "./src/..." first.`,
      );
    }
  }
  return problems;
}

/** Names of all packages a manifest declares, in any dependency field. */
export function declaredDependencies(manifest: Manifest): Set<string> {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

/** What a dependency specifier in package.json points at. */
export interface SpecifierTarget {
  /** The package name it installs (differs from the key for aliases). */
  readonly name?: string;
  /** The folder it points at, relative to the repository root, for path specifiers. */
  readonly path?: string;
}

/** Splits "name@range" (scoped or not); undefined if there is no name part. */
function splitAlias(text: string): { name: string; range: string } | undefined {
  const match = /^((?:@[^/@]+\/)?[^/@]+)@(.*)$/.exec(text);
  return match?.[1] === undefined ? undefined : { name: match[1], range: match[2] ?? "" };
}

/**
 * Resolves a dependency of the package at `packagePath`: "workspace:" (with a
 * range, an alias "workspace:other@*" or a path "workspace:../other"), "link:",
 * "file:" and "portal:" paths (relative to the package folder), "npm:" aliases, and
 * plain ranges.
 */
export function specifierTarget(
  packagePath: string,
  key: string,
  specifier: string,
): SpecifierTarget {
  const toPath = (relative: string): string => {
    const normalized = relative.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : posix.normalize(posix.join(packagePath, normalized));
  };
  const scheme = /^(workspace|link|file|portal|npm):(.*)$/.exec(specifier);
  if (scheme === null) return { name: key };
  const rest = scheme[2] ?? "";
  switch (scheme[1]) {
    case "workspace":
      if (rest.startsWith(".") || rest.startsWith("/")) return { path: toPath(rest) };
      return { name: splitAlias(rest)?.name ?? key };
    case "npm":
      return { name: splitAlias(rest)?.name ?? rest };
    default:
      return { path: toPath(rest) };
  }
}

/** No package other than packages/server may reach packages/server. */
export function checkServerDependency(
  packages: readonly WorkspacePackage[],
  lockfile?: Lockfile,
): string[] {
  const server = packages.find((pkg) => pkg.path === SERVER_PATH);
  const serverName =
    typeof server?.manifest.name === "string" ? server.manifest.name : undefined;
  const rule = `Only ${SERVER_PATH} may use the AGPL server code.`;
  const problems: string[] = [];
  for (const pkg of packages) {
    if (pkg === server || isInside(pkg.path, SERVER_PATH)) continue;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [key, specifier] of Object.entries(pkg.manifest[field] ?? {})) {
        const target = specifierTarget(pkg.path, key, String(specifier));
        const byPath = target.path !== undefined && isInside(target.path, SERVER_PATH);
        const byName = serverName !== undefined && target.name === serverName;
        if (byPath || byName) {
          problems.push(
            `${label(pkg)}: "${key}": "${specifier}" in ${field} points at ${SERVER_PATH}. ${rule}`,
          );
        }
      }
    }
  }
  for (const link of lockfile === undefined ? [] : linksInto(lockfile, SERVER_PATH)) {
    problems.push(
      `pnpm-lock.yaml: ${link.from} depends on ${link.name} through "${link.version}", which is in ${SERVER_PATH}. ${rule}`,
    );
  }
  return problems;
}

/** The npm package name of a bare import specifier, or undefined if it is not one. */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":") // node:fs, virtual:..., data:..., https://...
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Import specifiers of a source file: import, export from, import(), require(). */
export function importsOf(text: string): string[] {
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles.map((ref) => ref.fileName);
}

/**
 * A reference from a source file to another file or package.
 * - "module": a JS/TS import; a bare specifier is a package.
 * - "style": a stylesheet reference; a bare specifier is a file next to the
 *   stylesheet if the package has one, otherwise a package ("~pkg" is a package).
 * - "path": always a file path (HTML attributes, new URL(), import.meta.glob,
 *   alias targets).
 * - "prefix": the fixed start of a computed path or module specifier (a template
 *   string or a concatenation). It can reach anything in the folder it names.
 * - "unchecked": a reference whose target cannot be known; `specifier` holds the
 *   source text and `reason` says what it is.
 */
export interface Reference {
  readonly specifier: string;
  readonly kind: "module" | "style" | "path" | "prefix" | "unchecked";
  readonly reason?: string;
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot).toLowerCase();
}

/**
 * The name of a property: an identifier, a string key, or a computed key that is a
 * string (["alias"]). Undefined for other computed keys.
 */
function nameOf(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    let expression = name.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isStringLiteralLike(expression)) return expression.text;
  }
  return undefined;
}

/** The fixed text a computed string starts with, or undefined if it is not one. */
function fixedPrefix(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node)) return fixedPrefix(node.expression);
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    if (ts.isStringLiteralLike(node.left)) return node.left.text;
    const left = fixedPrefix(node.left);
    return left === undefined ? "" : left;
  }
  return undefined;
}

/**
 * References that need the syntax tree: new URL("<path>", import.meta.url),
 * import.meta.glob("<pattern>" | [...]), and import(), require() and new URL()
 * with a template string or a concatenation (by their fixed start).
 */
function astReferences(file: string, text: string): Reference[] {
  if (!/import\s*\(|require\s*\(|import\.meta/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isImportMeta = (node: ts.Node, property: string): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === property &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  const literals = (node: ts.Node | undefined): string[] => {
    if (node === undefined) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(literals);
    return [];
  };
  const found: Reference[] = [];
  const computed = (node: ts.Expression, what: string, kind: "module" | "path"): void => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isStringLiteralLike(node)) {
      found.push({ specifier: node.text, kind });
      return;
    }
    // Either branch of a choice may be taken: c ? "./a.ts" : "./b.ts", a || "./b.ts".
    if (ts.isConditionalExpression(node)) {
      computed(node.whenTrue, what, kind);
      computed(node.whenFalse, what, kind);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.CommaToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (node.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
        computed(node.left, what, kind);
      }
      computed(node.right, what, kind);
      return;
    }
    const prefix = fixedPrefix(node);
    if (prefix === undefined) return; // a variable: not something a bundler follows
    found.push(
      prefix === "" || !prefix.includes("/")
        ? {
            specifier: node.getText(source),
            kind: "unchecked",
            reason: `${what} whose start does not name a folder`,
          }
        : {
            // A URL path without "./" is still relative to the file.
            specifier:
              kind === "path" && !/^(?:\.|\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(prefix)
                ? `./${prefix}`
                : prefix,
            kind: "prefix",
          },
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[1] !== undefined &&
      isImportMeta(node.arguments[1], "url") &&
      node.arguments[0] !== undefined
    ) {
      const first = node.arguments[0];
      for (const text of literals(first)) found.push({ specifier: text, kind: "path" });
      if (!ts.isStringLiteral(first)) computed(first, "new URL()", "path");
    }
    if (ts.isCallExpression(node) && isImportMeta(node.expression, "glob")) {
      // Relative patterns are taken from the "base" option when it is given.
      const options = node.arguments[1];
      const baseProperty =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p) => p.name !== undefined && nameOf(p.name) === "base",
            )
          : undefined;
      let base: string | undefined;
      if (options !== undefined && !ts.isObjectLiteralExpression(options)) {
        found.push({
          specifier: options.getText(source),
          kind: "unchecked",
          reason: "import.meta.glob() options that cannot be read",
        });
      } else if (baseProperty !== undefined) {
        const value = ts.isPropertyAssignment(baseProperty)
          ? baseProperty.initializer
          : undefined;
        if (value !== undefined && ts.isStringLiteralLike(value)) {
          base = value.text;
        } else {
          found.push({
            specifier: baseProperty.getText(source),
            kind: "unchecked",
            reason: "an import.meta.glob() base that is not a string",
          });
        }
      }
      for (const pattern of literals(node.arguments[0])) {
        // The fixed part of the pattern decides where it can reach; "!" negates.
        let fixed = pattern.replace(/^!/, "").replace(/[*?{[].*$/, "");
        if (base !== undefined && !fixed.startsWith("/")) {
          const joined = posix.join(base, fixed);
          fixed = /^(?:\.{1,2}\/|\/)/.test(joined) ? joined : `./${joined}`;
        }
        found.push({ specifier: fixed === "" ? "./" : fixed, kind: "prefix" });
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamic || required) && !ts.isStringLiteral(node.arguments[0])) {
        computed(node.arguments[0], dynamic ? "import()" : "require()", "module");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function styleReferences(text: string): Reference[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Reference[] = [];
  const patterns = [
    /@import\s+(?:url\(\s*)?(["']?)([^"'()\s;]+)\1/g,
    /@(?:use|forward|require)\s+(["'])([^"']+)\1/g,
    /url\(\s*(["']?)([^"'()]+?)\1\s*\)/g,
    // CSS Modules: composes: a from "./x.css"; @value a from "./x.css";
    /\bcomposes\s*:[^;{}]*?\bfrom\s+(["'])([^"']+)\1/g,
    /@value\s[^;{}]*?\bfrom\s+(["'])([^"']+)\1/g,
    // Tailwind CSS: @config, @plugin, @reference and @source "<path or glob>".
    /@(?:config|plugin|reference|source)\s+(["'])([^"']+)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of css.matchAll(pattern)) {
      if (match[2] !== undefined) found.push({ specifier: match[2], kind: "style" });
    }
  }
  return found;
}

/** Text inside a tag: anything but a quote or ">", or a whole quoted value. */
const ATTRIBUTE_TEXT = `[^>"']|"[^"]*"|'[^']*'`;

function htmlReferences(text: string): Reference[] {
  const html = text.replace(/<!--[\s\S]*?-->/g, "");
  const found: Reference[] = [];
  // Attributes are skipped as a whole, so a ">" inside a quoted value does not end
  // the tag. Values may be quoted or not.
  const element = new RegExp(
    String.raw`<(?:script|link|img|source|video|audio|track|iframe|embed|input)\b(?:${ATTRIBUTE_TEXT})*?\s(?:src|href)\s*=\s*(?:(["'])(.*?)\1|([^\s"'>]+))`,
    "gi",
  );
  for (const match of html.matchAll(element)) {
    const value = match[2] ?? match[3];
    if (value !== undefined) found.push({ specifier: value, kind: "path" });
  }
  const inline = new RegExp(
    String.raw`<script\b((?:${ATTRIBUTE_TEXT})*)>([\s\S]*?)<\/script>`,
    "gi",
  );
  for (const match of html.matchAll(inline)) {
    if (!/\ssrc\s*=/i.test(match[1] ?? "")) {
      found.push(...scriptReferences("inline.ts", match[2] ?? ""));
    }
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    found.push(...styleReferences(match[1] ?? ""));
  }
  return found;
}

function scriptReferences(file: string, text: string): Reference[] {
  return [
    ...importsOf(text).map((specifier): Reference => ({ specifier, kind: "module" })),
    ...astReferences(file, text),
    ...(VITE_CONFIG_FILE.test(file) ? configReferences(file, text) : []),
  ];
}

/** Vite and Vitest config files, whose resolve.alias entries are checked. */
const VITE_CONFIG_FILE =
  /(?:^|\/)(?:vite|vitest)\.config\.[cm]?[jt]s$|(?:^|\/)vite\.shared\.ts$/;

/** tsconfig files, whose "paths" targets are checked. */
const TSCONFIG_FILE = /(?:^|\/)tsconfig[^/]*\.json$/;

/**
 * The targets of "paths" in a tsconfig file, as paths relative to the file: each
 * target is relative to "baseUrl" if set, otherwise to the tsconfig file. A target
 * with "*" is checked by its fixed start.
 */
function tsconfigReferences(text: string): Reference[] {
  const { config } = ts.parseConfigFileTextToJson("tsconfig.json", text);
  const options = isObject(config) ? config["compilerOptions"] : undefined;
  if (!isObject(options) || !isObject(options["paths"])) return [];
  const baseUrl = typeof options["baseUrl"] === "string" ? options["baseUrl"] : ".";
  const found: Reference[] = [];
  for (const targets of Object.values(options["paths"])) {
    for (const target of Array.isArray(targets) ? targets : []) {
      if (typeof target !== "string") continue;
      const star = target.indexOf("*");
      const fixed = star === -1 ? target : target.slice(0, star);
      const joined = /^(?:[A-Za-z]:)?[\\/]/.test(fixed)
        ? fixed
        : posix.join(baseUrl, fixed);
      const specifier =
        joined.startsWith(".") || joined.startsWith("/") ? joined : `./${joined}`;
      found.push({ specifier, kind: star === -1 ? "path" : "prefix" });
    }
  }
  return found;
}

/**
 * The paths in a Vite or Vitest config file, relative to the file (or package
 * names): the targets of resolve.alias (also under a quoted or computed key), and
 * publicDir, root and build input entries. A target is evaluated if it is a string,
 * or path.resolve() / path.join() / fileURLToPath(new URL(..., import.meta.url)) of
 * strings, import.meta.dirname, __dirname and process.cwd() (taken as the folder of
 * the config file, where Vite runs). Anything else is "unchecked".
 *
 * This is only the first line of defence: the AGPL guard in every Vite config
 * (scripts/lib/agpl-guard.ts) checks what the build really reads.
 */
function configReferences(file: string, text: string): Reference[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Reference[] = [];
  let what = "an alias";
  const unchecked = (node: ts.Node): void => {
    found.push({
      specifier: node.getText(source).replace(/\s+/g, " "),
      kind: "unchecked",
      reason: `${what} whose target cannot be checked`,
    });
  };
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const deref = (node: ts.Expression, depth = 0): ts.Expression => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    if (ts.isIdentifier(current) && depth < 10) {
      const value = constants.get(current.text);
      if (value !== undefined) return deref(value, depth + 1);
    }
    return current;
  };
  // An alias target may be a package name; a path option is always a path.
  let bareIsPath = false;
  const target = (node: ts.Expression): void => {
    const value = evaluatePath(deref(node), deref);
    if (value === undefined) unchecked(node);
    else if (value.startsWith(".")) found.push({ specifier: value, kind: "path" });
    else if (bareIsPath) found.push({ specifier: `./${value}`, kind: "path" });
    else found.push({ specifier: value, kind: "module" });
  };
  const entries = (node: ts.Expression): void => {
    const value = deref(node);
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)) target(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) target(property.name);
        else unchecked(property);
      }
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        const entry = deref(element);
        const replacement = ts.isObjectLiteralExpression(entry)
          ? entry.properties.find(
              (p) =>
                (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                ts.isIdentifier(p.name) &&
                p.name.text === "replacement",
            )
          : undefined;
        if (replacement !== undefined && ts.isPropertyAssignment(replacement)) {
          target(replacement.initializer);
        } else if (
          replacement !== undefined &&
          ts.isShorthandPropertyAssignment(replacement)
        ) {
          target(replacement.name);
        } else {
          unchecked(element);
        }
      }
    } else {
      unchecked(node);
    }
  };
  // Paths: publicDir and root (false turns publicDir off), and the entries of
  // build.rollupOptions.input / build.rolldownOptions.input.
  const paths = (node: ts.Expression, many: boolean): void => {
    const value = deref(node);
    if (value.kind === ts.SyntaxKind.FalseKeyword) return;
    if (many && ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)) target(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) target(property.name);
        else unchecked(property);
      }
    } else if (many && ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) target(element);
    } else {
      target(node);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = nameOf(node.name);
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      if (name === "alias") {
        [what, bareIsPath] = ["an alias", false];
        entries(value);
      } else if (name === "publicDir" || name === "root" || name === "input") {
        [what, bareIsPath] = [`a "${name}" option`, true];
        paths(value, name === "input");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Evaluates a path expression of a config file to a path relative to the file's
 * folder ("./x", "../y") or a bare module name; undefined if it cannot be known.
 */
function evaluatePath(
  node: ts.Expression,
  deref: (node: ts.Expression) => ts.Expression,
): string | undefined {
  const here = "<here>";
  // Each part is a path; <here> stands for the config file's folder.
  const part = (raw: ts.Expression): string | undefined => {
    const expression = deref(raw);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    const text = expression.getText().replace(/\s+/g, "");
    if (
      text === "import.meta.dirname" ||
      text === "__dirname" ||
      text === "process.cwd()"
    ) {
      return here;
    }
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression.getText().replace(/\s+/g, "");
      const name = callee.split(".").pop() ?? "";
      if (
        ["resolve", "join"].includes(name) &&
        /^(?:(?:node:)?path\.|posix\.|path\.posix\.)?(?:resolve|join)$/.test(callee)
      ) {
        const parts = expression.arguments.map(part);
        if (parts.some((p) => p === undefined)) return undefined;
        let result = name === "resolve" ? here : "";
        for (const p of parts as string[]) {
          if (p === here) result = here;
          else if (/^(?:[A-Za-z]:)?[\\/]/.test(p))
            return undefined; // absolute
          else result = result === "" ? p : `${result}/${p}`;
        }
        return result;
      }
      if (name === "fileURLToPath" && expression.arguments[0] !== undefined) {
        const url = deref(expression.arguments[0]);
        if (
          ts.isNewExpression(url) &&
          ts.isIdentifier(url.expression) &&
          url.expression.text === "URL" &&
          url.arguments?.[0] !== undefined &&
          url.arguments[1]?.getText().replace(/\s+/g, "") === "import.meta.url"
        ) {
          const relative = part(url.arguments[0]);
          return relative === undefined || relative === here
            ? undefined
            : `${here}/${relative}`;
        }
      }
    }
    return undefined;
  };
  const value = part(node);
  if (value === undefined) return undefined;
  if (value === here) return ".";
  if (value.startsWith(`${here}/`)) {
    const rest = posix.normalize(value.slice(here.length + 1));
    return rest.startsWith("..") ? rest : `./${rest}`;
  }
  if (value.startsWith(".")) return value; // a relative string: taken from the file
  if (/^(?:[A-Za-z]:)?[\\/]/.test(value)) return undefined; // absolute
  return value; // a package name
}

/** Every reference of a source file to another file or package; [] for other files. */
export function referencesOf(file: string, text: string): Reference[] {
  const extension = extensionOf(file);
  if (SOURCE_EXTENSIONS.includes(extension)) return scriptReferences(file, text);
  if (STYLE_EXTENSIONS.includes(extension)) return styleReferences(text);
  if (HTML_EXTENSIONS.includes(extension)) return htmlReferences(text);
  if (TSCONFIG_FILE.test(file)) return tsconfigReferences(text);
  return [];
}

/** True for URLs and other specifiers that are not files or packages. */
function isExternal(specifier: string, kind: Reference["kind"]): boolean {
  return (
    specifier === "" ||
    // node:, https:, data:, virtual: (but not a Windows drive or a file: URL)
    (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) &&
      !/^(?:[A-Za-z]:|file:)/i.test(specifier)) ||
    specifier.startsWith("//") ||
    // A fragment in CSS and HTML; in a script, "#name" is an "imports" mapping.
    (specifier.startsWith("#") && kind !== "module") ||
    specifier.includes("${") ||
    specifier.includes("{{")
  );
}

type Resolved =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly path: string; readonly folder?: boolean }
  | { readonly kind: "package"; readonly name: string }
  | { readonly kind: "imports"; readonly name: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** Resolves a reference of `file`; file paths come back relative to the package. */
function resolveReference(
  pkg: WorkspacePackage,
  file: string,
  { specifier, kind, reason }: Reference,
): Resolved {
  if (kind === "unchecked") {
    return {
      kind: "invalid",
      reason: `${reason ?? "a reference"} (${specifier}); a bundler may still follow it, so it is not allowed`,
    };
  }
  if (specifier.includes("\\")) {
    return {
      kind: "invalid",
      reason: `"${specifier}" contains a backslash; write paths with "/"`,
    };
  }
  if (/^(?:[A-Za-z]:\/|file:|\/@fs\/|\/@id\/)/i.test(specifier)) {
    return {
      kind: "invalid",
      reason: `"${specifier}" is an absolute file path; use a path relative to the file`,
    };
  }
  if (isExternal(specifier, kind)) return { kind: "none" };
  if (kind === "module" && specifier.startsWith("#")) {
    return { kind: "imports", name: specifier };
  }
  if (kind === "prefix") {
    // Everything in the folder of the fixed start can be reached.
    const folder = specifier.slice(0, specifier.lastIndexOf("/") + 1);
    if (!/^\.{0,2}\//.test(folder)) {
      const name = packageNameOf(folder);
      const complete = name !== undefined && folder.startsWith(`${name}/`);
      return complete
        ? { kind: "package", name }
        : {
            kind: "invalid",
            reason: `a computed import starting with "${specifier}" does not name a whole package or a folder`,
          };
    }
    const resolved = resolveReference(pkg, file, { specifier: folder, kind: "path" });
    return resolved.kind === "file" ? { ...resolved, folder: true } : resolved;
  }
  const plain = specifier.replace(/[?#].*$/, "");
  const fromFile = (relative: string): Resolved => {
    const joined = relative.startsWith("/")
      ? posix.join(".", relative) // Vite: the package folder
      : posix.join(posix.dirname(file), relative);
    return { kind: "file", path: posix.normalize(joined).replace(/(.)\/+$/, "$1") };
  };
  const looksRelative = plain === "." || plain === ".." || /^\.{0,2}\//.test(plain);
  if (kind === "path" || looksRelative) return fromFile(plain);
  if (kind === "style") {
    if (plain.startsWith("~")) return packageOf(plain.slice(1));
    const next = fromFile(plain);
    if (next.kind === "file" && pkg.files.includes(next.path)) return next;
  }
  return packageOf(plain);
}

function packageOf(specifier: string): Resolved {
  const name = packageNameOf(specifier);
  if (name === undefined) return { kind: "none" };
  // "pkg/../server/x.ts": a package without "exports" lets the path leave it.
  const rest = specifier.slice(name.length).split("/");
  if (rest.some((segment) => segment === "." || segment === "..")) {
    return {
      kind: "invalid",
      reason: `"${specifier}" has a "." or ".." segment, which can lead out of the package`,
    };
  }
  return { kind: "package", name };
}

/** True if a key of package.json "imports" matches the specifier ("#x" or "#x/*"). */
function importsHas(manifest: Manifest, specifier: string): boolean {
  const imports = manifest.imports;
  if (!isObject(imports)) return false;
  return Object.keys(imports).some((key) => {
    const star = key.indexOf("*");
    if (star === -1) return key === specifier;
    const before = key.slice(0, star);
    const after = key.slice(star + 1);
    return (
      specifier.length >= key.length - 1 &&
      specifier.startsWith(before) &&
      specifier.endsWith(after)
    );
  });
}

/** Checks the source files of one package; `all` is every workspace package. */
export function checkImports(
  pkg: WorkspacePackage,
  all: readonly WorkspacePackage[] = [pkg],
): string[] {
  const declared = declaredDependencies(pkg.manifest);
  const ownName = typeof pkg.manifest.name === "string" ? pkg.manifest.name : undefined;
  const nested = all
    .map((other) => other.path)
    .filter((path) => path !== pkg.path && isInside(path, pkg.path));
  const root = all.find((other) => other.path === ".");
  const problems = new Set<string>();
  const where = (file: string): string => repoPath(pkg, file);

  const checkPackage = (file: string, name: string, via: string): void => {
    if (name === ownName || declared.has(name)) return;
    const hint = isBuiltin(name) ? ` For the Node built-in, write "node:${name}".` : "";
    problems.add(
      `${where(file)}${via} uses "${name}", which ${label(pkg)} does not declare in its package.json.${hint}`,
    );
  };

  // The package folder and nested packages where they really are.
  const realOf = (path: string): string =>
    pkg.realPath === undefined ? repoPath(pkg, path) : pkg.realPath(path);
  const realFolder = realOf(".");

  const checkFile = (
    file: string,
    path: string,
    specifier: string,
    folder = false,
  ): void => {
    const target = repoPath(pkg, path);
    const leaves = path === ".." || path.startsWith("../") || leavesRepository(target);
    if (leaves) {
      if (SHARED_ROOT_FILES.includes(target) && CONFIG_FILE.test(file) && root) {
        // A shared root config file: its packages must be declared here too.
        for (const reference of referencesOf(target, root.read(target))) {
          const resolved = resolveReference(root, target, reference);
          if (resolved.kind === "package")
            checkPackage(file, resolved.name, ` (through ${target})`);
        }
        return;
      }
      problems.add(
        `${where(file)} refers to "${specifier}", which is outside ${label(pkg)}. ` +
          "Relative paths must stay inside the package folder; use a declared workspace package instead.",
      );
      return;
    }
    const inner = nested.find(
      (path) => isInside(target, path) || (folder && isInside(path, target)),
    );
    if (inner !== undefined) {
      problems.add(
        `${where(file)} refers to "${specifier}", which ${folder ? "can reach into" : "is inside"} the workspace package ${inner}. ` +
          "Declare that package and import it by name instead.",
      );
      return;
    }
    // The same on the real path, after symbolic links.
    const real = realOf(path);
    const realInner = nested.find((path) =>
      isInside(real, realOf(posix.relative(pkg.path, path) || ".")),
    );
    if (
      !isInside(real, realFolder) ||
      leavesRepository(real) ||
      realInner !== undefined
    ) {
      problems.add(
        `${where(file)} refers to "${specifier}", which is really ${real} (through a symbolic link), outside ${label(pkg)}. ` +
          "Relative paths must stay inside the package folder; use a declared workspace package instead.",
      );
    }
  };

  for (const file of pkg.files) {
    const references = referencesOf(file, pkg.read(file));
    for (const reference of references) {
      const resolved = resolveReference(pkg, file, reference);
      if (resolved.kind === "package") checkPackage(file, resolved.name, "");
      if (resolved.kind === "file") {
        checkFile(file, resolved.path, reference.specifier, resolved.folder);
      }
      if (resolved.kind === "imports" && !importsHas(pkg.manifest, resolved.name)) {
        problems.add(
          `${where(file)} imports "${resolved.name}", which is not declared in the "imports" field of ${label(pkg)}. ` +
            'Declare it there ("#name": "./src/file.ts"), so the check can see where it points.',
        );
      }
      if (resolved.kind === "invalid") {
        problems.add(`${where(file)}: ${resolved.reason}.`);
      }
    }
  }

  // A symbolic link must point inside the package, outside every nested package.
  for (const link of pkg.symlinks ?? []) {
    const real = realOf(link);
    const realInner = nested.find((path) =>
      isInside(real, realOf(posix.relative(pkg.path, path) || ".")),
    );
    if (
      !isInside(real, realFolder) ||
      leavesRepository(real) ||
      realInner !== undefined
    ) {
      problems.add(
        `${where(link)} is a symbolic link to ${real}, outside ${label(pkg)}. ` +
          "Links may only point inside the package; share code through a declared workspace package instead.",
      );
    }
  }
  return [...problems];
}

/** String targets of an "exports" or "imports" value, through nested conditions. */
function mappingTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(mappingTargets);
  if (isObject(value)) return Object.values(value).flatMap(mappingTargets);
  return [];
}

/**
 * Checks the targets of "exports" and "imports" in package.json: files must be
 * "./" paths inside the package; packages named in "imports" must be declared.
 */
export function checkManifestMappings(
  pkg: WorkspacePackage,
  all: readonly WorkspacePackage[] = [pkg],
): string[] {
  const problems: string[] = [];
  const declared = declaredDependencies(pkg.manifest);
  const nested = all
    .map((other) => other.path)
    .filter((path) => path !== pkg.path && isInside(path, pkg.path));
  const checkPath = (field: string, target: string): void => {
    const path = posix.normalize(target);
    const full = repoPath(pkg, path);
    const inner = nested.find((folder) => isInside(full, folder));
    if (!target.startsWith("./") || path === ".." || path.startsWith("../")) {
      problems.push(
        `${label(pkg)}: "${field}" target "${target}" must be a "./" path inside the package.`,
      );
    } else if (inner !== undefined) {
      problems.push(
        `${label(pkg)}: "${field}" target "${target}" is inside the workspace package ${inner}.`,
      );
    }
  };
  for (const target of mappingTargets(pkg.manifest.exports)) checkPath("exports", target);
  for (const target of mappingTargets(pkg.manifest.imports)) {
    if (target.startsWith(".") || target.startsWith("/")) {
      checkPath("imports", target);
      continue;
    }
    if (target.startsWith("node:")) continue;
    const name = packageNameOf(target);
    if (name !== undefined && name !== pkg.manifest.name && !declared.has(name)) {
      problems.push(
        `${label(pkg)}: "imports" maps to "${name}", which is not declared in its package.json.`,
      );
    }
  }
  return problems;
}

/**
 * Packages run by Node from source must not reach a workspace package that has .tsx
 * or .jsx files (other than tests), through workspace dependencies.
 */
export function checkNodeRunnable(packages: readonly WorkspacePackage[]): string[] {
  const byName = new Map<string, WorkspacePackage>();
  const byPath = new Map<string, WorkspacePackage>();
  for (const pkg of packages) {
    if (typeof pkg.manifest.name === "string") byName.set(pkg.manifest.name, pkg);
    byPath.set(pkg.path, pkg);
  }
  const hasJsx = (pkg: WorkspacePackage): boolean =>
    pkg.files.some((file) => /\.(tsx|jsx)$/i.test(file) && !TEST_FILE.test(file));

  const problems: string[] = [];
  for (const start of packages.filter((pkg) => NODE_RUN_PATHS.includes(pkg.path))) {
    const seen = new Set<WorkspacePackage>();
    const queue: WorkspacePackage[] = [start];
    for (let pkg = queue.pop(); pkg !== undefined; pkg = queue.pop()) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      if (hasJsx(pkg)) {
        problems.push(
          `${label(start)} is run by Node from source, but ${label(pkg)} has .tsx or .jsx files, which Node cannot load.`,
        );
      }
      for (const field of DEPENDENCY_FIELDS) {
        for (const [key, specifier] of Object.entries(pkg.manifest[field] ?? {})) {
          const target = specifierTarget(pkg.path, key, String(specifier));
          const next =
            target.path !== undefined
              ? byPath.get(target.path)
              : target.name !== undefined
                ? byName.get(target.name)
                : undefined;
          if (next !== undefined) queue.push(next);
        }
      }
    }
  }
  return problems;
}

/** Runs every rule over all workspace packages. */
export function checkWorkspace(
  packages: readonly WorkspacePackage[],
  lockfile?: Lockfile,
): string[] {
  return [
    ...packages.flatMap(checkStructure),
    ...checkServerDependency(packages, lockfile),
    ...packages.flatMap((pkg) => checkImports(pkg, packages)),
    ...packages.flatMap((pkg) => checkManifestMappings(pkg, packages)),
    ...checkNodeRunnable(packages),
  ];
}
