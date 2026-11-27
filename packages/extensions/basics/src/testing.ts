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
  roots,
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
  [BASICS.frame, 3],
  ["frame-rect", 1],
  [BASICS.removeFrame, 2],
  [BASICS.rename, 2],
  [BASICS.moveIntoFrame, 2],
  [BASICS.moveOutOfFrame, 2],
  ["move-into", 3],
  [BASICS.group, 6],
  [BASICS.ungroup, 3],
  [BASICS.lock, 2],
  [BASICS.unlock, 3],
  [BASICS.delete, 5],
  [BASICS.duplicate, 4],
  ["copy-paste", 4],
  ["paste-again", 2],
  ["reparent-at", 2],
  ["lock-container", 1],
  ["group-all", 1],
  ["into-descendant", 1],
  [BASICS.undo, 7],
  [BASICS.redo, 4],
  [BASICS.selectAll, 1],
];
const TOTAL = WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

/** What a random scenario remembers between commands: the last fragment copied. */
export interface RandomMemory {
  fragment?: unknown;
}

/**
 * A random command for the document as it is now, with arguments drawn from
 * what the user sees: valid ones mostly, but locked elements, elements of a
 * missing extension and rigid types are drawn too, so commands are refused as
 * well. "copy-paste" is two commands; the paste gets the copy's result. Also:
 * pasting an older fragment again (its source may be gone or changed by now),
 * moving into a container at a stacking index, locking a container, grouping
 * everything in a container, and moving a container into its own descendant.
 */
export function randomCommands(
  t: BasicsSetup,
  random: RandomSource,
  memory: RandomMemory = {},
): RandomCommand[] {
  const r = t.resolver();
  const visible = r.drawOrder();
  const containers = visible.filter((id) => r.isContainer(id));
  const groups = visible.filter((id) => r.get(id)?.type === GROUP_TYPE);
  const frames = visible.filter((id) => r.get(id)?.type === FRAME_TYPE);
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
    case BASICS.frame: {
      const first = pick(random, visible);
      if (first === undefined) return [{ id: kind, args: { ids: [] } }];
      const siblings = r.logicalChildren(r.logicalParentOf(first));
      return [{ id: kind, args: { ids: some(random, siblings, 3) } }];
    }
    case "frame-rect": {
      const { parent, ...rect } = box();
      const inside = r.logicalChildren(parent);
      return [
        {
          id: BASICS.frame,
          args: { rect, parent, ids: random() < 0.5 ? [] : some(random, inside, 2) },
        },
      ];
    }
    case BASICS.removeFrame:
      return [{ id: kind, args: { ids: some(random, frames, 2) } }];
    case BASICS.rename:
      return [
        {
          id: kind,
          args: {
            id: pick(random, visible),
            name: pick(random, [
              "",
              "A",
              "Ramme",
              `Ramme ${Math.floor(random() * 100)}`,
            ])!,
          },
        },
      ];
    case BASICS.moveOutOfFrame: {
      // Some of what one frame holds, so that it is mostly accepted.
      const frame = pick(random, frames);
      const inside = frame === undefined ? [] : r.logicalChildren(frame);
      return [
        { id: kind, args: { ids: inside.length > 0 ? some(random, inside, 2) : ids() } },
      ];
    }
    case BASICS.moveIntoFrame:
      return [
        {
          id: kind,
          args:
            random() < 0.5
              ? { ids: ids() }
              : { ids: ids(), target: pick(random, frames) },
        },
      ];
    case "move-into":
      return [
        {
          id: BASICS.move,
          args: {
            ids: ids(),
            dx: random() < 0.3 ? 0 : coordinate(random),
            dy: 3,
            target: anyContainer(),
          },
        },
      ];
    case BASICS.unlock:
      return [{ id: kind, args: { ids: some(random, locked, 2) } }];
    case BASICS.duplicate:
      return [{ id: kind, args: { ids: ids(), dx: 10, dy: 10 } }];
    case "copy-paste":
      return [
        { id: BASICS.copy, args: { ids: ids() } },
        { id: BASICS.paste, args: { parent: anyContainer(), dx: 15, dy: -5 } },
      ];
    case "paste-again":
      return [
        {
          id: BASICS.paste,
          args: { fragment: memory.fragment, parent: anyContainer(), dx: 3, dy: 3 },
        },
      ];
    case "reparent-at":
      return [
        {
          id: BASICS.reparent,
          args: { ids: ids(), target: anyContainer(), index: Math.floor(random() * 4) },
        },
      ];
    case "lock-container":
      return [{ id: BASICS.lock, args: { ids: some(random, containers, 1) } }];
    case "group-all": {
      const first = pick(random, visible);
      const all = first === undefined ? [] : r.logicalChildren(r.logicalParentOf(first));
      return [{ id: BASICS.group, args: { ids: all } }];
    }
    case "into-descendant": {
      const outer = pick(random, containers);
      const inside = containers.filter(
        (id) => outer !== undefined && id !== outer && r.isWithin(id, outer),
      );
      return [
        {
          id: BASICS.reparent,
          args: {
            ids: outer === undefined ? [] : [outer],
            target: pick(random, inside) ?? null,
          },
        },
      ];
    }
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
 * outcomes. A copy's fragment is remembered; a paste without a fragment of its
 * own gets the one remembered.
 */
export function runRandom(
  t: BasicsSetup,
  commands: readonly RandomCommand[],
  memory: RandomMemory = {},
): CommandOutcome[] {
  const outcomes: CommandOutcome[] = [];
  for (const command of commands) {
    const given = command.args as { fragment?: unknown } | undefined;
    const args =
      command.id === BASICS.paste && !Object.hasOwn(given ?? {}, "fragment")
        ? { ...given, fragment: memory.fragment }
        : command.args;
    const outcome = t.run(command.id, args);
    if (command.id === BASICS.copy && outcome.ok) memory.fragment = outcome.value;
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

// ---------------------------------------------------------------------------
// Settings from the environment, and counting how undos are finished
// ---------------------------------------------------------------------------

function env(name: string): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env[name];
}

/**
 * A list of numbers from an environment variable ("1,2,5" or "1-40"), for
 * running the random tests with more seeds than by default.
 */
export function envList(name: string, fallback: readonly number[]): number[] {
  const raw = env(name);
  if (!raw) return [...fallback];
  const range = /^(\d+)-(\d+)$/.exec(raw);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return raw.split(",").map(Number);
}

/** A number from an environment variable. */
export function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  return raw ? Number(raw) : fallback;
}

/** How often the undo manager had to finish an undo or redo (docs/adr/0001, section 10). */
export interface SettleStats {
  /** Holes filled. */
  holes: number;
  /** Other writes: changes of container held back, or done with a rebase that keeps the place. */
  settled: number;
}

/** Counts the transactions that finish the undos and redos of `t`'s undo manager. */
export function watchSettle(t: BasicsSetup): SettleStats {
  const stats: SettleStats = { holes: 0, settled: 0 };
  const elements = roots(t.doc).elements;
  t.doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.origin !== t.undo.settleOrigin) return;
    let hole = false;
    let other = false;
    for (const [type, keys] of tr.changed) {
      const item = type._item;
      if (!(type instanceof Y.Map) || item === null || item.parent !== elements) continue;
      const changes = new Y.YMapEvent(type as Y.Map<unknown>, tr, keys as Set<string>)
        .changes.keys;
      for (const change of changes.values()) {
        if (change.action === "add") hole = true;
        else other = true;
      }
    }
    if (hole) stats.holes += 1;
    if (other) stats.settled += 1;
  });
  return stats;
}
