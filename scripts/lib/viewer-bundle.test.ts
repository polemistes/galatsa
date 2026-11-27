// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing parts of the extension interface, and the player
// (packages/player), stay free of editing code: a
// bundle of what a player imports (the viewing host, the comfort guard, the
// placeholder, the built-in transitions with their comfort settings, the
// shape and routes extensions' viewing parts, and the viewing parts of the example
// extensions) contains no Yjs and none of the
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
const SHAPE = join(root, "packages/extensions/shape/src");
const ROUTES = join(root, "packages/extensions/routes/src");
const PLAYER = join(root, "packages/player/src");
const RENDERER = join(root, "packages/renderer/src");
const I18N = join(root, "packages/i18n/src");

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

/** Marks of the editor and its interface, which a player must not carry. */
const EDITOR_MARKS = ["svelte", "galatsa-canvas", "EditorHost", "RoutesPanel", "Y.Doc"];

/**
 * The limit of the viewer bundle, for now: 100 kB unminified (the player's
 * real budget is decided in F2-02).
 */
const LIMIT = 100_000;

/**
 * The bundles that include packages/player are over that limit (measured
 * 2026-11-27, see docs/adr/0015-presentation.md): 156 kB with the player's
 * core, and 304 kB with the whole player, which brings the renderer (95 kB
 * alone, and never part of the measured bundle before) and the translation
 * runtime. The limit is not raised here: these two ceilings are not budgets,
 * only tripwires a little above what was measured, so that growth nobody
 * noticed fails the test until the budget is decided. Merged with the text
 * layout of docs/adr/0011-text.md the whole player measured 348 kB
 * (2026-11-27), so its tripwire moved to 370 kB.
 */
const PLAYER_CORE_CEILING = 165_000;
const PLAYER_CEILING = 370_000;

describe("viewer bundle", () => {
  it("has no Yjs, no document operations and no editing code", async () => {
    const code = await bundle(`
      import { ViewHost, guardComfort, drawPlaceholder } from ${JSON.stringify(join(API, "index.ts"))};
      import { exampleViewExtensions } from ${JSON.stringify(join(EXAMPLES, "view.ts"))};
      import { transitionsExtension, resolveComfort, readComfortPreferences, watchSystemReducedMotion } from ${JSON.stringify(join(TRANSITIONS, "index.ts"))};
      import { shapeViewExtension } from ${JSON.stringify(join(SHAPE, "view.ts"))};
      import { routesViewExtension } from ${JSON.stringify(join(ROUTES, "view.ts"))};
      const host = new ViewHost();
      host.load([transitionsExtension, shapeViewExtension, routesViewExtension, ...exampleViewExtensions]);
      globalThis.viewer = [host, guardComfort, drawPlaceholder, resolveComfort, readComfortPreferences, watchSystemReducedMotion];
    `);
    for (const mark of EDITING_MARKS) expect(code, mark).not.toContain(mark);
    // The examples' and the shapes' drawing code and the flight path are there.
    expect(code).toContain("roundRect");
    expect(code).toContain("galatsa.shape");
    expect(code).toContain("Math.asinh");
    expect(code).toContain("prefers-reduced-motion");
    // The routes extension's viewing part, without its panel or the editor.
    expect(code).toContain("galatsa.routes");
    expect(code).not.toContain("RoutesPanel");
    expect(code).not.toContain("svelte");
    console.info(`viewer bundle without the player: ${code.length} bytes`);
    expect(code.length).toBeLessThan(LIMIT);
  }, 60_000);

  it("covers the player's core: the presentation and its camera, without editing code", async () => {
    const code = await bundle(`
      import { ViewHost, drawPlaceholder } from ${JSON.stringify(join(API, "index.ts"))};
      import { exampleViewExtensions } from ${JSON.stringify(join(EXAMPLES, "view.ts"))};
      import { transitionsExtension, readComfortPreferences } from ${JSON.stringify(join(TRANSITIONS, "index.ts"))};
      import { shapeViewExtension } from ${JSON.stringify(join(SHAPE, "view.ts"))};
      import { routesViewExtension } from ${JSON.stringify(join(ROUTES, "view.ts"))};
      import { Presentation, sourceFromSnapshot } from ${JSON.stringify(join(PLAYER, "core.ts"))};
      const host = new ViewHost();
      host.load([transitionsExtension, shapeViewExtension, routesViewExtension, ...exampleViewExtensions]);
      globalThis.viewer = (snapshot, screen) => [drawPlaceholder, readComfortPreferences, new Presentation({
        source: sourceFromSnapshot(snapshot),
        screen,
        transitions: (id) => host.transition(id),
      })];
    `);
    for (const mark of [...EDITING_MARKS, ...EDITOR_MARKS])
      expect(code, mark).not.toContain(mark);
    // The presentation, breaking off a transition, and the comfort guard are there.
    expect(code).toContain("Presentation");
    expect(code).toContain('"roaming"');
    expect(code).toContain("breakOff");
    expect(code).toContain("guardComfort");
    // No stage and no renderer: the core draws nothing.
    expect(code).not.toContain("CanvasRenderer");
    expect(code).not.toContain("requestFullscreen");
    console.info(`viewer bundle with the player's core: ${code.length} bytes`);
    expect(code.length).toBeLessThan(PLAYER_CORE_CEILING);
  }, 60_000);

  it("covers the whole player: stage, input and notes, with the renderer and no editing code", async () => {
    const code = await bundle(`
      import { ViewHost } from ${JSON.stringify(join(API, "index.ts"))};
      import { exampleViewExtensions } from ${JSON.stringify(join(EXAMPLES, "view.ts"))};
      import { transitionsExtension, readComfortPreferences } from ${JSON.stringify(join(TRANSITIONS, "index.ts"))};
      import { shapeViewExtension } from ${JSON.stringify(join(SHAPE, "view.ts"))};
      import { routesViewExtension } from ${JSON.stringify(join(ROUTES, "view.ts"))};
      import { mountPlayer, sourceFromSnapshot } from ${JSON.stringify(join(PLAYER, "index.ts"))};
      import { assetsFromSnapshot, sceneFromSnapshot } from ${JSON.stringify(join(RENDERER, "index.ts"))};
      import { createI18n } from ${JSON.stringify(join(I18N, "index.ts"))};
      const i18n = createI18n({ dev: false });
      const host = new ViewHost({ i18n });
      host.load([transitionsExtension, shapeViewExtension, routesViewExtension, ...exampleViewExtensions]);
      globalThis.viewer = (parent, snapshot, stored) => mountPlayer(parent, {
        host,
        i18n,
        source: sourceFromSnapshot(snapshot),
        scene: sceneFromSnapshot(snapshot),
        assets: assetsFromSnapshot(snapshot),
        preferences: readComfortPreferences(stored),
      });
    `);
    for (const mark of [...EDITING_MARKS, ...EDITOR_MARKS])
      expect(code, mark).not.toContain(mark);
    // The player in a page: the stage with the renderer, full screen, the
    // laser pointer and the notes, in both languages.
    expect(code).toContain("Presentation");
    expect(code).toContain('"roaming"');
    expect(code).toContain("CanvasRenderer");
    expect(code).toContain("requestFullscreen");
    expect(code).toContain("gp-laser");
    expect(code).toContain("Notater for presentasjonen");
    expect(code).toContain("Presenter notes");
    console.info(`viewer bundle with the whole player: ${code.length} bytes`);
    expect(code.length).toBeLessThan(PLAYER_CEILING);
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
