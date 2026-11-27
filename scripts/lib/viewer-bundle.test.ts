// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing parts of the extension interface stay free of editing code: a
// bundle of what a player imports (the viewing host, the comfort guard, the
// placeholder, the built-in transitions with their comfort settings, and the
// viewing parts of the example extensions) contains no Yjs and none of the
// document's operations, and stays small. A bundle of the
// editing entry is built the same way as a control. See section 10 of
// docs/adr/0005-extension-interface.md.

import { join } from "node:path";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { workspaceConfig } from "../../vite.shared.ts";

const root = join(import.meta.dirname, "..", "..");
const API = join(root, "packages/extension-api/src");
const EXAMPLES = join(root, "packages/extensions/examples/src");
const TRANSITIONS = join(root, "packages/extensions/transitions/src");

/** Builds a virtual entry with the workspace settings and returns the code. */
async function bundle(entry: string): Promise<string> {
  const id = "\0viewer-entry";
  const result = await build({
    configFile: false,
    ...workspaceConfig({
      logLevel: "silent",
      root,
      plugins: [
        {
          name: "viewer-entry",
          enforce: "pre",
          resolveId: (source) => (source.endsWith("viewer-entry") ? id : null),
          load: (source) => (source === id ? entry : null),
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: { entry: "viewer-entry", formats: ["es"], fileName: "viewer" },
        rollupOptions: { treeshake: true },
      },
    }),
  });
  const outputs = (
    Array.isArray(result) ? result : [result]
  ) as Rolldown.RolldownOutput[];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => ("code" in chunk ? chunk.code : ""))
    .join("\n");
}

/** Marks of code that only editing needs. */
const EDITING_MARKS = [
  "UndoManager",
  "encodeStateAsUpdate",
  "Records cannot be created",
  "CommandRegistry",
];

describe("viewer bundle", () => {
  it("has no Yjs, no document operations and no editing code", async () => {
    const code = await bundle(`
      import { ViewHost, guardComfort, drawPlaceholder } from ${JSON.stringify(join(API, "index.ts"))};
      import { exampleViewExtensions } from ${JSON.stringify(join(EXAMPLES, "view.ts"))};
      import { transitionsExtension, resolveComfort, readComfortPreferences, watchSystemReducedMotion } from ${JSON.stringify(join(TRANSITIONS, "index.ts"))};
      const host = new ViewHost();
      host.load([transitionsExtension, ...exampleViewExtensions]);
      globalThis.viewer = [host, guardComfort, drawPlaceholder, resolveComfort, readComfortPreferences, watchSystemReducedMotion];
    `);
    for (const mark of EDITING_MARKS) expect(code, mark).not.toContain(mark);
    // The examples' drawing code and the flight path are there.
    expect(code).toContain("roundRect");
    expect(code).toContain("Math.asinh");
    expect(code).toContain("prefers-reduced-motion");
    expect(code.length).toBeLessThan(80_000);
  }, 60_000);

  it("is much smaller than the editing entry with the same extensions", async () => {
    const code = await bundle(`
      import { EditorHost } from ${JSON.stringify(join(API, "editing.ts"))};
      import { exampleExtensions } from ${JSON.stringify(join(EXAMPLES, "index.ts"))};
      const host = new EditorHost();
      host.load(exampleExtensions);
      globalThis.editor = host;
    `);
    expect(code).toContain("Records cannot be created");
    expect(code).toContain("CommandRegistry");
    expect(code.length).toBeGreaterThan(200_000);
  }, 60_000);
});
