// SPDX-License-Identifier: GPL-3.0-or-later

// Test helpers: an editor host with the basics extension, the shape sketch and
// a few fixtures (frames, an element of a missing extension, and a type that
// may be neither resized nor rotated), over a real document with its undo
// manager. Exported as "@galatsa/extension-basics/testing"; not part of the
// program.

import {
  FRAME_TYPE,
  Resolver,
  purgeSnapshot,
  type DocumentSnapshot,
  type ElementId,
  type ExtensionElement,
} from "@galatsa/core";
import {
  addElement,
  createUndoManager,
  initDocument,
  toSnapshot,
  yLookup,
} from "@galatsa/core/ydoc";
import {
  EditorHost,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  defineElementView,
  type CommandEnvironment,
  type CommandOutcome,
  type Mode,
} from "@galatsa/extension-api/editing";
import { createTestServices } from "@galatsa/extension-api/testing";
import { SHAPE_INSERT, shapeExtension } from "@galatsa/extension-examples";
import { createI18n, memoryLocaleStorage } from "@galatsa/i18n";
import * as Y from "yjs";
import { basicsExtension } from "./index.ts";

export { SHAPE_INSERT, SHAPE_TYPE } from "@galatsa/extension-examples";

export const FIXTURES = "test.fixtures";
/** Inserts a frame: { x, y, w, h, parent? }. */
export const INSERT_FRAME = `${FIXTURES}/insert-frame`;
/** Inserts an element of a type no loaded extension defines: { x, y, w, h, parent? }. */
export const INSERT_MISSING = `${FIXTURES}/insert-missing`;
/** Inserts an element of a type that may be neither resized nor rotated: { x, y, w, h, parent? }. */
export const INSERT_RIGID = `${FIXTURES}/insert-rigid`;
export const MISSING_TYPE = "test.missing/thing";
export const RIGID_TYPE = `${FIXTURES}/rigid`;

export interface BoxArgs {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly parent?: ElementId | null;
}

const rigidView = defineElementView<Record<string, never>>({
  name: "rigid",
  label: "common:action.ok",
  typeVersion: 1,
  read: () => ({}),
  draw: () => {},
});

function inserter(name: string, type: string) {
  return defineCommand<BoxArgs, ElementId>({
    name,
    label: "common:action.ok",
    quick: true,
    execute: (ctx, a) =>
      addElement(ctx.doc, {
        type,
        x: a.x,
        y: a.y,
        size: { w: a.w, h: a.h },
        parent: a.parent ?? null,
        data: type === MISSING_TYPE ? { secret: "kept as it is" } : {},
      }),
  });
}

/** Fixtures: frames, an element of a missing extension, and a rigid type. */
export const fixturesExtension = defineEditExtension({
  view: {
    id: FIXTURES,
    version: "0.0.0",
    api: { major: 1, minor: 0 },
    elementTypes: [rigidView],
  },
  contributes: {
    elementTypes: [
      defineElementEditing(rigidView, { capabilities: { resize: false, rotate: false } }),
    ],
    commands: [
      inserter("insert-frame", FRAME_TYPE),
      inserter("insert-missing", MISSING_TYPE),
      inserter("insert-rigid", RIGID_TYPE),
    ],
  },
});

/** True if the document has not been initialized yet. */
function blank(doc: Y.Doc): boolean {
  return doc.getMap("meta").size === 0;
}

/**
 * A document with an editor host around it. Pass a document to share one
 * between several hosts, or a replica made with forkDoc.
 */
export function setupBasics(
  options: { readonly mode?: Mode; readonly doc?: Y.Doc } = {},
) {
  const doc = options.doc ?? new Y.Doc();
  if (blank(doc)) initDocument(doc);
  const undo = createUndoManager(doc);
  const i18n = createI18n({ dev: false, locale: "en", storage: memoryLocaleStorage() });
  const host = new EditorHost({ i18n });
  const problems = host.load([basicsExtension, shapeExtension, fixturesExtension]);
  if (problems.length > 0) throw new Error(`load problems: ${JSON.stringify(problems)}`);
  const services = createTestServices(doc, { mode: options.mode ?? "advanced" });
  const env = (): CommandEnvironment => ({ doc, undo, services });
  const run = <R = unknown>(id: string, args?: unknown): CommandOutcome<R> =>
    host.commands.execute<R>(id, env(), args);
  /** Runs a command that must succeed, and returns its value. */
  const must = <R = unknown>(id: string, args?: unknown): R => {
    const outcome = run<R>(id, args);
    if (!outcome.ok)
      throw new Error(`${id} ${outcome.reason}: ${String(outcome.error ?? "")}`);
    return outcome.value;
  };
  const resolver = () => new Resolver(yLookup(doc));
  const element = (id: ElementId) => toSnapshot(doc).elements[id] as ExtensionElement;
  const shape = (x: number, y: number, w = 10, h = 10, parent: ElementId | null = null) =>
    must<ElementId>(SHAPE_INSERT, { kind: "rect", x, y, w, h, parent });
  const frame = (
    x: number,
    y: number,
    w = 100,
    h = 100,
    parent: ElementId | null = null,
  ) => must<ElementId>(INSERT_FRAME, { x, y, w, h, parent });
  const missing = (x: number, y: number, w = 10, h = 10) =>
    must<ElementId>(INSERT_MISSING, { x, y, w, h });
  const rigid = (x: number, y: number, w = 10, h = 10) =>
    must<ElementId>(INSERT_RIGID, { x, y, w, h });
  return {
    doc,
    undo,
    i18n,
    host,
    services,
    env,
    run,
    must,
    resolver,
    element,
    shape,
    frame,
    missing,
    rigid,
  };
}

export type BasicsSetup = ReturnType<typeof setupBasics>;

/** What the user sees: the document purged as for sharing (no revisions, marks or removed records). */
export function visibleState(doc: Y.Doc): DocumentSnapshot {
  return purgeSnapshot(toSnapshot(doc));
}
