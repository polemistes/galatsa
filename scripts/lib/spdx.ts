// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the SPDX header check: which files need a header, and whether a
// given file has it. The CLI in scripts/check-spdx.ts lists the files. The expected
// license depends on where the file is (scripts/lib/project-license.ts).

import { licenseForPath, PROGRAM_LICENSE } from "./project-license.ts";

/** The SPDX tag for a license, for example "SPDX-License-Identifier: GPL-3.0-or-later". */
export function spdxIdentifier(license: string): string {
  return `SPDX-License-Identifier: ${license}`;
}

/** The tag for the program's license, GPL-3.0-or-later. */
export const SPDX_IDENTIFIER = spdxIdentifier(PROGRAM_LICENSE);

type CommentStyle = "line" | "block" | "html";

/** Comment style used by each extension that must carry the header. Keys are lowercase. */
const STYLES: ReadonlyMap<string, CommentStyle> = new Map([
  [".ts", "line"],
  [".tsx", "line"],
  [".mts", "line"],
  [".cts", "line"],
  [".js", "line"],
  [".jsx", "line"],
  [".mjs", "line"],
  [".cjs", "line"],
  [".rs", "line"],
  [".css", "block"],
  [".html", "html"],
]);

/** Extensions whose files may start with a "#!" line. */
const SHEBANG_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

/** Returns true if the file path is one that must carry an SPDX header. */
export function needsHeader(path: string): boolean {
  return STYLES.has(extensionOf(path));
}

/**
 * Returns true if the file content starts with the SPDX header in the comment style of
 * its extension, naming the license that applies to the file's path. A UTF-8 byte
 * order mark and a shebang line before the header are allowed.
 */
export function hasSpdxHeader(path: string, content: string): boolean {
  const extension = extensionOf(path);
  const style = STYLES.get(extension);
  if (style === undefined) return false;

  let text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (SHEBANG_EXTENSIONS.has(extension) && text.startsWith("#!")) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }

  const firstLine = (text.split("\n", 1)[0] ?? "").replace(/\r$/, "");
  return firstLine === expectedHeader(path);
}

/** The header line a file at this path must start with. */
export function expectedHeader(path: string): string {
  const identifier = spdxIdentifier(licenseForPath(path));
  switch (STYLES.get(extensionOf(path))) {
    case "block":
      return `/* ${identifier} */`;
    case "html":
      return `<!-- ${identifier} -->`;
    default:
      return `// ${identifier}`;
  }
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
