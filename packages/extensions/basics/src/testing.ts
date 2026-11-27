// SPDX-License-Identifier: GPL-3.0-or-later

// Test helpers: an editor host with the basics extension, the shape sketch and
// a few fixtures (frames, an element of a missing extension, and a type that
// may be neither resized nor rotated), over a real document with its undo
// manager. Exported as "@galatsa/extension-basics/testing"; not part of the
// program.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  Resolver,
  purgeSnapshot,
  type DocumentSnapshot,
  type ElementId,
  type ExtensionElement,
  type RandomSource,
} from "@galatsa/core";
import { seededRandom } from "@galatsa/core/testing";
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
import { BASICS, basicsExtension } from "./index.ts";

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

// ---------------------------------------------------------------------------
// Random commands, for the property tests
// ---------------------------------------------------------------------------

/** One command as the random scenario runs it. */
export interface RandomCommand {
  readonly id: string;
  readonly args?: unknown;
}

function pick<T>(random: RandomSource, list: readonly T[]): T | undefined {
  return list.length === 0 ? undefined : list[Math.floor(random() * list.length)];
}

/** Up to `max` distinct items, in random order. */
function some<T>(random: RandomSource, list: readonly T[], max = 3): T[] {
  const pool = [...list];
  const out: T[] = [];
  const count = 1 + Math.floor(random() * max);
  while (out.length < count && pool.length > 0)
    out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return out;
}

function coordinate(random: RandomSource): number {
  return Math.round(random() * 400 - 100);
}

const WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["shape", 12],
  ["frame", 5],
  ["missing", 3],
  ["rigid", 2],
  [BASICS.move, 10],
  [BASICS.resize, 5],
  [BASICS.scale, 4],
  [BASICS.rotate, 4],
  [BASICS.reparent, 7],
  [BASICS.bringToFront, 2],
  [BASICS.sendToBack, 2],
  [BASICS.bringForward, 2],
  [BASICS.sendBackward, 2],
  [BASICS.group, 6],
  [BASICS.ungroup, 3],
  [BASICS.lock, 2],
  [BASICS.unlock, 3],
  [BASICS.delete, 5],
  [BASICS.duplicate, 4],
  ["copy-paste", 4],
  [BASICS.undo, 7],
  [BASICS.redo, 4],
  [BASICS.selectAll, 1],
];
const TOTAL = WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

/**
 * A random command for the document as it is now, with arguments drawn from
 * what the user sees: valid ones mostly, but locked elements, elements of a
 * missing extension and rigid types are drawn too, so commands are refused as
 * well. "copy-paste" is two commands; the second gets the first's result.
 */
export function randomCommands(t: BasicsSetup, random: RandomSource): RandomCommand[] {
  const r = t.resolver();
  const visible = r.drawOrder();
  const containers = visible.filter((id) => r.isContainer(id));
  const groups = visible.filter((id) => r.get(id)?.type === GROUP_TYPE);
  const locked = visible.filter((id) => r.get(id)?.locked === true);
  const anyContainer = () => (random() < 0.4 ? null : (pick(random, containers) ?? null));
  const box = () => ({
    x: coordinate(random),
    y: coordinate(random),
    w: 5 + Math.round(random() * 60),
    h: 5 + Math.round(random() * 60),
    parent: anyContainer(),
  });
  const ids = () => some(random, visible);
  let roll = random() * TOTAL;
  let kind = WEIGHTS[0]![0];
  for (const [name, weight] of WEIGHTS) {
    if ((roll -= weight) < 0) {
      kind = name;
      break;
    }
  }
  switch (kind) {
    case "shape":
      return [{ id: SHAPE_INSERT, args: { kind: "rect", ...box() } }];
    case "frame":
      return [{ id: INSERT_FRAME, args: box() }];
    case "missing":
      return [{ id: INSERT_MISSING, args: box() }];
    case "rigid":
      return [{ id: INSERT_RIGID, args: box() }];
    case BASICS.move:
      return [{ id: kind, args: { ids: ids(), dx: coordinate(random), dy: 7 } }];
    case BASICS.resize:
      return [
        {
          id: kind,
          args: {
            id: pick(random, visible),
            w: Math.round(random() * 80),
            h: Math.round(random() * 80),
            ...(random() < 0.5 ? { x: coordinate(random), y: coordinate(random) } : {}),
          },
        },
      ];
    case BASICS.scale:
      return [
        {
          id: kind,
          args: {
            ids: ids(),
            anchor: { x: coordinate(random), y: coordinate(random) },
            factor: pick(random, [0.5, 1.5, 2, 0.75])!,
          },
        },
      ];
    case BASICS.rotate:
      return [
        {
          id: kind,
          args:
            random() < 0.5
              ? { ids: ids(), rot: random() * 7 }
              : { ids: ids(), by: random() * 4 - 2 },
        },
      ];
    case BASICS.reparent:
      return [{ id: kind, args: { ids: ids(), target: anyContainer() } }];
    case BASICS.group: {
      const first = pick(random, visible);
      if (first === undefined) return [{ id: kind, args: { ids: [] } }];
      const siblings = r.logicalChildren(r.logicalParentOf(first));
      return [{ id: kind, args: { ids: some(random, siblings, 4) } }];
    }
    case BASICS.ungroup:
      return [{ id: kind, args: { ids: some(random, groups, 2) } }];
    case BASICS.unlock:
      return [{ id: kind, args: { ids: some(random, locked, 2) } }];
    case BASICS.duplicate:
      return [{ id: kind, args: { ids: ids(), dx: 10, dy: 10 } }];
    case "copy-paste":
      return [
        { id: BASICS.copy, args: { ids: ids() } },
        { id: BASICS.paste, args: { parent: anyContainer(), dx: 15, dy: -5 } },
      ];
    case BASICS.undo:
    case BASICS.redo:
    case BASICS.selectAll:
      return [{ id: kind }];
    default:
      return [{ id: kind, args: { ids: ids() } }];
  }
}

/**
 * Runs the commands of `randomCommands` through the registry. Returns the
 * outcomes; a paste gets the fragment the copy before it returned.
 */
export function runRandom(
  t: BasicsSetup,
  commands: readonly RandomCommand[],
): CommandOutcome[] {
  const outcomes: CommandOutcome[] = [];
  let fragment: unknown;
  for (const command of commands) {
    const args =
      command.id === BASICS.paste
        ? { ...(command.args as object), fragment }
        : command.args;
    const outcome = t.run(command.id, args);
    if (command.id === BASICS.copy && outcome.ok) fragment = outcome.value;
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Makes Math.random and crypto.getRandomValues (order keys, ids, writer keys)
 * deterministic while `fn` runs, so a seed reproduces a scenario exactly.
 */
export function withSeed<T>(seed: number, fn: () => T): T {
  const math = seededRandom(seed * 7919 + 1);
  const bytes = seededRandom(seed * 104729 + 2);
  // The package is environment-agnostic, so Web Crypto is described here.
  type Values = <A extends Uint8Array>(array: A) => A;
  const crypto = (globalThis as unknown as { crypto: { getRandomValues: Values } })
    .crypto;
  const originalRandom = Math.random;
  const ownValues = Object.hasOwn(crypto, "getRandomValues");
  const own = crypto.getRandomValues;
  Math.random = math;
  crypto.getRandomValues = <A extends Uint8Array>(array: A): A => {
    for (let i = 0; i < array.length; i++) array[i] = Math.floor(bytes() * 256);
    return array;
  };
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
    if (ownValues) crypto.getRandomValues = own;
    else delete (crypto as { getRandomValues?: unknown }).getRandomValues;
  }
}
