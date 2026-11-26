// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { expectedHeader, hasSpdxHeader, needsHeader, SPDX_IDENTIFIER } from "./spdx.ts";

const line = `// ${SPDX_IDENTIFIER}`;
const BOM = String.fromCharCode(0xfeff);

describe("needsHeader", () => {
  it("covers the source types, with case-insensitive extensions", () => {
    for (const path of [
      "a.ts",
      "a.TSX",
      "a.mts",
      "a.cts",
      "a.js",
      "a.JSX",
      "a.mjs",
      "a.cjs",
      "a.rs",
      "a.css",
      "a.HTML",
    ]) {
      expect(needsHeader(path), path).toBe(true);
    }
  });

  it("ignores other files, including names without an extension", () => {
    for (const path of ["README.md", "a.json", "Makefile", "dir/.gitignore", "a.png"]) {
      expect(needsHeader(path), path).toBe(false);
    }
  });
});

describe("hasSpdxHeader", () => {
  it("accepts the header on the first line of a TypeScript file", () => {
    expect(hasSpdxHeader("src/a.ts", `${line}\n\nexport const x = 1;\n`)).toBe(true);
  });

  it("accepts CRLF line endings", () => {
    expect(hasSpdxHeader("src/a.ts", `${line}\r\nexport const x = 1;\r\n`)).toBe(true);
  });

  it("rejects a missing header, or a header that is not on the first line", () => {
    expect(hasSpdxHeader("src/a.ts", "export const x = 1;\n")).toBe(false);
    expect(hasSpdxHeader("src/a.ts", `\n${line}\n`)).toBe(false);
    expect(hasSpdxHeader("src/a.ts", "// SPDX-License-Identifier: MIT\n")).toBe(false);
    expect(hasSpdxHeader("src/a.ts", "")).toBe(false);
  });

  it("accepts a shebang line before the header in JavaScript and TypeScript", () => {
    expect(
      hasSpdxHeader("bin/run.mjs", `#!/usr/bin/env node\n${line}\nconsole.log(1);\n`),
    ).toBe(true);
    expect(hasSpdxHeader("bin/run.ts", `#!/usr/bin/env -S node\n${line}\n`)).toBe(true);
  });

  it("rejects a shebang line in a file type that does not use it", () => {
    expect(hasSpdxHeader("src/lib.rs", `#!/usr/bin/env node\n${line}\n`)).toBe(false);
  });

  it("accepts a UTF-8 byte order mark before the header", () => {
    expect(hasSpdxHeader("src/a.ts", `${BOM}${line}\n`)).toBe(true);
    expect(hasSpdxHeader("src/a.ts", `${BOM}#!/usr/bin/env node\n${line}\n`)).toBe(true);
  });

  it("uses the block comment form for CSS", () => {
    expect(hasSpdxHeader("styles/a.css", `/* ${SPDX_IDENTIFIER} */\nbody {}\n`)).toBe(
      true,
    );
    expect(hasSpdxHeader("styles/a.css", `${line}\nbody {}\n`)).toBe(false);
  });

  it("uses the HTML comment form for HTML", () => {
    expect(
      hasSpdxHeader("index.html", `<!-- ${SPDX_IDENTIFIER} -->\n<!doctype html>\n`),
    ).toBe(true);
    expect(hasSpdxHeader("index.html", `${line}\n<!doctype html>\n`)).toBe(false);
  });

  it("uses the line comment form for Rust", () => {
    expect(hasSpdxHeader("src/main.rs", `${line}\nfn main() {}\n`)).toBe(true);
  });

  it("matches the extension case-insensitively", () => {
    expect(hasSpdxHeader("SRC/A.TS", `${line}\n`)).toBe(true);
  });

  it("returns false for file types that do not need a header", () => {
    expect(hasSpdxHeader("README.md", `${line}\n`)).toBe(false);
  });

  it("expects the AGPL header under packages/server and GPL elsewhere", () => {
    const agpl = "// SPDX-License-Identifier: AGPL-3.0-or-later";
    expect(hasSpdxHeader("packages/server/src/index.ts", `${agpl}\n`)).toBe(true);
    expect(hasSpdxHeader("packages/server/src/index.ts", `${line}\n`)).toBe(false);
    expect(hasSpdxHeader("packages/core/src/index.ts", `${agpl}\n`)).toBe(false);
    expect(hasSpdxHeader("packages/server-tools/src/index.ts", `${line}\n`)).toBe(true);
    expect(expectedHeader("packages/server/public/index.html")).toBe(
      "<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->",
    );
  });
});
