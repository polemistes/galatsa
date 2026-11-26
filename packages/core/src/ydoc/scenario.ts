// SPDX-License-Identifier: GPL-3.0-or-later

// A randomized scenario for property tests: a random document, three replicas
// that apply random operations (through the reference operations, through an
// editor binding's own transactions, and through undo and redo), exchange state
// partially and at random, and tidy up now and then. The scenario keeps its own
// record of who knew what when, independent of the document's revisions, and
// uses it to check the rule of section 5.5 of
// docs/adr/0001-document-model-and-file-format.md:
//
//   Nothing is hidden by a delete whose user had not seen all the work done on
//   it, or on a container between it and the deleted element.
//
// Used by the property tests of this package and of @galatsa/format.

import * as Y from "yjs";
import { copyFragment } from "../model/fragment.ts";
import { validateSnapshot } from "../model/grammar.ts";
import { purgeSnapshot } from "../model/purge.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { isRemoved, routeSteps } from "../model/route.ts";
import {
  FRAME_TYPE,
  sameRevision,
  type DeleteMarks,
  type DocumentSnapshot,
  type Revision,
} from "../model/types.ts";
import { pasteFragment, tidyUp } from "./document-ops.ts";
import * as ops from "./ops.ts";
import { fromSnapshot, inspectDocument, toSnapshot, yLookup } from "./snapshot.ts";
import { forkDoc, syncDocs, syncInto } from "./sync.ts";
import { seededBytes, seededRandom } from "./seeded.ts";
import { createUndoManager } from "./track.ts";

/** The transaction origin the scenario's "editor binding" uses. */
export const BINDING_ORIGIN = "scenario-binding";

const TEXT_TYPE = "galatsa.text/text";
const SHAPE_TYPE = "galatsa.shapes/shape";

type Kind = "elements" | "stops" | "routes";
const KINDS: readonly Kind[] = ["elements", "stops", "routes"];

interface AnyRecord {
  rev: Revision;
  deleted: DeleteMarks;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      sorted[key] = (item as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/** A record's content, without the bookkeeping of section 5.5. */
function content(record: AnyRecord): string {
  const { rev: _rev, deleted: _deleted, ...rest } = record;
  return stable(rest);
}

function recordOf(
  snapshot: DocumentSnapshot,
  kind: Kind,
  id: string,
): AnyRecord | undefined {
  const table = snapshot[kind] as { [id: string]: AnyRecord };
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

function isDeletedIn(
  snapshot: DocumentSnapshot,
  view: Resolver,
  kind: Kind,
  id: string,
): boolean {
  if (kind === "elements") return view.isDeleted(id);
  const record = recordOf(snapshot, kind, id);
  return record !== undefined && isRemoved(id, record);
}

interface MarkEvent {
  seen: string;
  /** Work the user who wrote the mark had seen. */
  known: Set<number>;
}

/**
 * Who knew what when. Every piece of work on a record gets a number; each
 * replica has the set of numbers it has seen; each delete mark remembers the set
 * its writer had seen when writing it.
 */
class Oracle {
  /** Work per record ("kind id"), only work done on a record its user saw. */
  readonly work = new Map<string, number[]>();
  /** Marks per "kind id action", in the order they were written. */
  readonly marks = new Map<string, MarkEvent[]>();
  readonly known: Set<number>[];
  #next = 0;

  constructor(replicas: number) {
    this.known = Array.from({ length: replicas }, () => new Set<number>());
  }

  /** Records what one local step on replica `r` did, by comparing snapshots. */
  observe(
    r: number,
    before: DocumentSnapshot,
    after: DocumentSnapshot,
    alsoWorked: ReadonlyArray<readonly [Kind, string]>,
  ): void {
    const view = new Resolver(lookupFromRecord(after.elements));
    const worked: Array<readonly [Kind, string]> = [...alsoWorked];
    for (const kind of KINDS) {
      for (const id of Object.keys(after[kind])) {
        const was = recordOf(before, kind, id);
        if (was && content(was) !== content(recordOf(after, kind, id)!))
          worked.push([kind, id]);
      }
    }
    for (const [kind, id] of worked) {
      // Work on something its user sees as deleted is done knowingly and does
      // not have to bring it back.
      if (!recordOf(after, kind, id) || isDeletedIn(after, view, kind, id)) continue;
      const number = this.#next++;
      const key = `${kind} ${id}`;
      this.work.set(key, [...(this.work.get(key) ?? []), number]);
      this.known[r]!.add(number);
    }
    for (const kind of KINDS) {
      for (const id of Object.keys(after[kind])) {
        const now = recordOf(after, kind, id)!.deleted;
        const was = recordOf(before, kind, id)?.deleted;
        for (const action of Object.keys(now)) {
          const seen = stable(now[action]!.seen);
          if (was && Object.hasOwn(was, action) && stable(was[action]!.seen) === seen)
            continue;
          const key = `${kind} ${id} ${action}`;
          const events = this.marks.get(key) ?? [];
          events.push({ seen, known: new Set(this.known[r]) });
          this.marks.set(key, events);
        }
      }
    }
  }

  /** Replica `to` received everything replica `from` has. */
  delivered(to: number, from: number): void {
    for (const number of this.known[from]!) this.known[to]!.add(number);
  }

  /** Checks the rule on a converged state; returns what breaks it. */
  check(snapshot: DocumentSnapshot): string[] {
    const violations: string[] = [];
    const view = new Resolver(lookupFromRecord(snapshot.elements));
    const sawAll = (kind: Kind, root: string, action: string, path: string[]) => {
      const mark = recordOf(snapshot, kind, root)?.deleted[action];
      const event = mark
        ? this.marks
            .get(`${kind} ${root} ${action}`)
            ?.findLast((e) => e.seen === stable(mark.seen))
        : undefined;
      if (!event) return `the mark ${action} on ${root} was never written by a step`;
      for (const id of path) {
        for (const number of this.work.get(`${kind} ${id}`) ?? []) {
          if (!event.known.has(number)) return `it had not seen work ${number} on ${id}`;
        }
      }
      return null;
    };
    for (const id of Object.keys(snapshot.elements)) {
      const deleters = view.deleters(id);
      if (deleters.length === 0) continue;
      const reasons: string[] = [];
      for (const deleter of deleters) {
        const path: string[] = [];
        for (let at: string | null = id; at !== null; at = view.parentOf(at)) {
          path.push(at);
          if (at === deleter.root) break;
        }
        const reason = sawAll("elements", deleter.root, deleter.action, path);
        if (reason === null) {
          reasons.length = 0;
          break;
        }
        reasons.push(reason);
      }
      if (reasons.length > 0)
        violations.push(`element ${id} is deleted, but ${reasons.join("; ")}`);
    }
    for (const kind of ["stops", "routes"] as const) {
      for (const id of Object.keys(snapshot[kind])) {
        const record = recordOf(snapshot, kind, id)!;
        const inEffect = Object.keys(record.deleted).filter((action) =>
          sameRevision(record.deleted[action]!.seen[id], record.rev),
        );
        if (inEffect.length === 0) continue;
        const reasons = inEffect.map((action) => sawAll(kind, id, action, [id]));
        if (!reasons.includes(null))
          violations.push(`${kind} ${id} is removed, but ${reasons.join("; ")}`);
      }
    }
    return violations;
  }
}

export interface ScenarioOptions {
  /** Number of random steps (default 80). */
  steps?: number;
  /**
   * Called now and then during the run, and for every replica at the end, with a
   * document in whatever state it is in. For checks that need more than this
   * package has (writing a file, for example).
   */
  checkpoint?: (doc: Y.Doc) => void;
}

export interface ScenarioResult {
  /** The three replicas, fully synced. */
  replicas: Y.Doc[];
  /** The converged JSON form. */
  snapshot: DocumentSnapshot;
  /** Everything that went wrong; empty when all properties hold. */
  failures: string[];
  /** How often each kind of step ran. */
  steps: Map<string, number>;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Runs one scenario and checks the properties. Deterministic for a given seed. */
export function runScenario(seed: number, options: ScenarioOptions = {}): ScenarioResult {
  const rnd = seededRandom(seed);
  const o = { random: rnd, randomBytes: seededBytes(seed * 7919 + 1) };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const chance = (p: number) => rnd() < p;
  const int = (n: number) => Math.floor(rnd() * n);
  const failures: string[] = [];
  const counts = new Map<string, number>();
  const fail = (message: string) => failures.push(`seed ${seed}: ${message}`);

  // --- A random document -----------------------------------------------------
  const start = new Y.Doc();
  start.clientID = 1000;
  ops.initDocument(start, { id: `doc${seed}` }, o);
  const frames: string[] = [];
  for (let i = 0, n = 2 + int(4); i < n; i++) {
    const parent = frames.length > 0 && chance(0.3) ? pick(frames) : null;
    ops.addElement(
      start,
      {
        id: `F${i}`,
        type: FRAME_TYPE,
        parent,
        x: int(2000),
        y: int(2000),
        size: { w: 300 + int(500), h: 200 + int(400) },
      },
      o,
    );
    frames.push(`F${i}`);
  }
  for (let i = 0, n = 4 + int(6); i < n; i++) {
    const text = chance(0.35);
    ops.addElement(
      start,
      {
        id: `E${i}`,
        type: text ? TEXT_TYPE : SHAPE_TYPE,
        parent: chance(0.7) ? pick(frames) : null,
        x: int(300),
        y: int(300),
        size: { w: 5 + int(50), h: 5 + int(50) },
        data: text
          ? { text: { $y: "text", delta: [{ insert: `text ${i}` }] } }
          : { fill: "#fff" },
      },
      o,
    );
  }
  for (let i = 0, n = 2 + int(3); i < n; i++) {
    ops.addStop(
      start,
      {
        id: `S${i}`,
        view: chance(0.6)
          ? { kind: "frame", frame: pick(frames), padding: 0.1 }
          : {
              kind: "rect",
              space: chance(0.5) ? pick(frames) : null,
              x: 0,
              y: 0,
              w: 100,
              h: 80,
            },
        notes: [{ insert: `notes ${i}` }],
      },
      o,
    );
  }
  for (let i = 0, n = 1 + int(2); i < n; i++) {
    ops.addRoute(start, { id: `R${i}`, name: `route ${i}` }, o);
    for (let k = 0, m = 1 + int(3); k < m; k++)
      ops.insertRouteEntry(start, `R${i}`, `S${int(2)}`, o);
  }
  {
    const before = new Resolver(yLookup(start));
    const top = before.logicalChildren(null);
    if (top.length >= 2 && chance(0.5)) {
      ops.group(start, top.slice(0, 2), { ...o, id: "G0" });
    }
  }

  // --- Three replicas ---------------------------------------------------------
  const clients = seed % 2 === 0 ? [1, 2, 3] : [3, 2, 1];
  const replicas = clients.map((client) => forkDoc(start, client));
  const undo = replicas.map((doc) =>
    createUndoManager(doc, { captureTimeout: 0, origins: [BINDING_ORIGIN] }),
  );
  const oracle = new Oracle(replicas.length);
  let created = 0;

  const steps = options.steps ?? 80;
  for (let step = 0; step < steps; step++) {
    const r = int(replicas.length);
    const doc = replicas[r]!;
    const view = new Resolver(yLookup(doc));
    const all = [...view.ids()];
    const visible = all.filter((id) => !view.isGone(id));
    const containers = visible.filter((id) => view.isContainer(id));
    const stops = [...doc.getMap("stops").keys()];
    const routes = [...doc.getMap("routes").keys()];
    const before = toSnapshot(doc);
    const alsoWorked: Array<readonly [Kind, string]> = [];
    let name = "";
    // Syncing and tidying are not work of this replica's user.
    let local = true;
    const run = (label: string, fn: () => void) => {
      name = label;
      fn();
    };
    try {
      const id = all.length > 0 ? pick(all) : "";
      const roll = int(34);
      if (all.length === 0 && roll < 17) {
        run("add element", () =>
          ops.addElement(
            doc,
            {
              id: `N${r}_${created++}`,
              type: SHAPE_TYPE,
              x: 1,
              y: 1,
              size: { w: 4, h: 4 },
            },
            o,
          ),
        );
      } else if (roll === 0 || roll === 1) {
        run("move", () => ops.moveElement(doc, id, int(400), int(400), o));
      } else if (roll === 2) {
        const targets = containers.filter((c) => !view.isWithin(c, id));
        run("reparent", () =>
          ops.reparent(
            doc,
            id,
            chance(0.2) || targets.length === 0 ? null : pick(targets),
            o,
          ),
        );
      } else if (roll === 3) {
        if (!view.isGone(id)) {
          const members = view
            .logicalChildren(view.logicalParentOf(id))
            .filter((s) => s === id || chance(0.4));
          run("group", () => ops.group(doc, members, { ...o, id: `G${r}_${created++}` }));
        }
      } else if (roll === 4) {
        if (view.isContainer(id)) run("dissolve", () => ops.dissolve(doc, id, o));
      } else if (roll === 5 || roll === 6) {
        run("delete", () => ops.deleteElements(doc, [id], o));
      } else if (roll === 7) {
        run("restore", () => ops.restoreElement(doc, id, o));
      } else if (roll === 8) {
        if (!view.isGone(id)) run("to front", () => ops.bringToFront(doc, id, o));
      } else if (roll === 9) {
        if (!view.isGone(id)) run("backward", () => ops.sendBackward(doc, id, o));
      } else if (roll === 10) {
        run("rename", () => ops.renameElement(doc, id, `n${step}`, o));
      } else if (roll === 11) {
        if (view.get(id)?.size)
          run("resize", () => ops.resizeElement(doc, id, int(90), int(90), o));
      } else if (roll === 12) {
        run("set data", () => ops.setData(doc, id, "k", { step }, o));
      } else if (roll === 13) {
        run("lock", () => ops.setLocked(doc, id, chance(0.5), o));
      } else if (roll === 14 || roll === 15) {
        // Typing, as an editor binding does it: its own transaction and origin.
        const texts = all.filter((e) => view.get(e)?.type === TEXT_TYPE);
        if (texts.length > 0) {
          const text = ops.dataMap(doc, pick(texts)).get("text");
          if (text instanceof Y.Text) {
            run("type", () =>
              doc.transact(() => {
                if (text.length > 3 && chance(0.3)) text.delete(int(text.length - 1), 1);
                else text.insert(int(text.length + 1), pick(["a", "b", " ", "\n"]));
              }, BINDING_ORIGIN),
            );
          }
        }
      } else if (roll === 16) {
        // Into any container, also one that is gone here.
        const parents = all.filter((c) => view.isContainer(c));
        run("add element", () =>
          ops.addElement(
            doc,
            {
              id: `N${r}_${created++}`,
              type: chance(0.3) ? TEXT_TYPE : SHAPE_TYPE,
              parent: parents.length > 0 && chance(0.7) ? pick(parents) : null,
              x: int(100),
              y: int(100),
              size: { w: 4, h: 4 },
              data: { text: { $y: "text", delta: [{ insert: "new" }] } },
            },
            o,
          ),
        );
      } else if (roll === 17) {
        if (visible.length > 0) {
          const source = pick(visible);
          run("duplicate", () =>
            pasteFragment(
              doc,
              copyFragment(before, [source]),
              { parent: view.logicalParentOf(source), dx: 10, dy: 10 },
              o,
            ),
          );
        }
      } else if (roll === 18 && stops.length > 0) {
        run("rename stop", () => ops.renameStop(doc, pick(stops), `s${step}`, o));
      } else if (roll === 19 && stops.length > 0) {
        const notes = ops.stopNotes(doc, pick(stops));
        run("type notes", () =>
          doc.transact(() => notes.insert(int(notes.length + 1), "x"), BINDING_ORIGIN),
        );
      } else if (roll === 20 && stops.length > 0 && all.length > 0) {
        run("visibility", () =>
          ops.setVisibility(doc, pick(stops), id, pick(["show", "hide", null]), o),
        );
      } else if ((roll === 21 || roll === 22) && stops.length > 0) {
        run("remove stop", () => ops.removeStop(doc, pick(stops), o));
      } else if (roll === 23 && stops.length > 0) {
        run("restore stop", () => ops.restoreStop(doc, pick(stops), o));
      } else if (roll === 24 && stops.length > 0 && routes.length > 0) {
        const stop = pick(stops);
        alsoWorked.push(["stops", stop]);
        run("visit stop", () => ops.insertRouteEntry(doc, pick(routes), stop, o));
      } else if (roll === 25 && routes.length > 0) {
        const route = pick(routes);
        const entries = Object.keys(before.routes[route]?.entries ?? {});
        if (entries.length > 0) {
          const entry = pick(entries);
          if (chance(0.7)) {
            run("move visit", () => ops.moveRouteEntry(doc, route, entry, int(4), o));
          } else run("remove visit", () => ops.removeRouteEntry(doc, route, entry, o));
        }
      } else if (roll === 26 && routes.length > 0) {
        const route = pick(routes);
        if (chance(0.5)) run("remove route", () => ops.removeRoute(doc, route, o));
        else run("restore route", () => ops.restoreRoute(doc, route, o));
      } else if (roll === 27) {
        run("add stop", () =>
          ops.addStop(
            doc,
            {
              id: `S${r}_${created++}`,
              view: { kind: "rect", space: null, x: 0, y: 0, w: 10, h: 10 },
            },
            o,
          ),
        );
      } else if (roll === 28 || roll === 29) {
        run("undo", () => undo[r]!.undo());
      } else if (roll === 30) {
        run("redo", () => undo[r]!.redo());
      } else if (roll === 31 || roll === 32) {
        const other = (r + 1 + int(replicas.length - 1)) % replicas.length;
        if (chance(0.5)) {
          run("sync", () => syncDocs(doc, replicas[other]!));
          oracle.delivered(r, other);
          oracle.delivered(other, r);
        } else {
          run("sync one way", () => syncInto(doc, replicas[other]!));
          oracle.delivered(r, other);
        }
        local = false;
      } else if (roll === 33 && chance(0.25)) {
        run("tidy up", () => tidyUp(doc));
        local = false;
      }
    } catch (error) {
      fail(`step ${step} (${name}) threw: ${(error as Error).message}`);
    }
    if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name !== "" && local) oracle.observe(r, before, toSnapshot(doc), alsoWorked);
    if (options.checkpoint && chance(0.05)) options.checkpoint(doc);
  }

  // --- Convergence -------------------------------------------------------------
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [0, 2],
    [0, 1],
  ] as const) {
    syncDocs(replicas[a]!, replicas[b]!);
  }
  const snapshot = toSnapshot(replicas[0]!);
  for (const [i, doc] of replicas.entries()) {
    if (stable(toSnapshot(doc)) !== stable(snapshot))
      fail(`replica ${i} did not converge`);
    const { problems } = inspectDocument(doc);
    if (problems.length > 0)
      fail(`replica ${i} holds what the grammar does not: ${problems[0]}`);
  }
  const problems = validateSnapshot(snapshot);
  if (problems.length > 0) fail(`the snapshot is not valid: ${problems[0]}`);
  if (stable(toSnapshot(fromSnapshot(snapshot))) !== stable(snapshot)) {
    fail("the snapshot does not survive a round trip through a new document");
  }
  for (const violation of oracle.check(snapshot)) fail(violation);

  // --- What the user sees ------------------------------------------------------
  const view = new Resolver(lookupFromRecord(snapshot.elements));
  const order = view.drawOrder();
  const shown = Object.keys(snapshot.elements).filter((id) => !view.isGone(id));
  if (new Set(order).size !== order.length || order.length !== shown.length) {
    fail("the drawing order does not list each visible element once");
  }
  const places = new Map(order.map((id) => [id, view.worldOrigin(id)]));
  for (const [id, p] of places) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
      fail(`${id} has no finite position`);
    const parent = view.logicalParentOf(id);
    if (parent !== null && view.isGone(parent))
      fail(`${id} is shown inside a gone container`);
  }
  const sameView = (label: string, elements: DocumentSnapshot["elements"]) => {
    const other = new Resolver(lookupFromRecord(elements));
    if (stable(other.drawOrder()) !== stable(order))
      fail(`${label} changed the drawing order`);
    for (const [id, p] of places) {
      const q = other.worldOrigin(id);
      if (!close(p.x, q.x) || !close(p.y, q.y)) fail(`${label} moved ${id}`);
    }
  };
  // An export for sharing shows the same.
  const purged = purgeSnapshot(snapshot);
  if (validateSnapshot(purged).length > 0) fail("the purged snapshot is not valid");
  sameView("purging", purged.elements);
  // Tidy up on one replica shows the same, and the others follow.
  options.checkpoint?.(replicas[0]!);
  tidyUp(replicas[0]!);
  syncDocs(replicas[0]!, replicas[1]!);
  syncDocs(replicas[1]!, replicas[2]!);
  const tidy = toSnapshot(replicas[0]!);
  for (const doc of replicas) {
    if (stable(toSnapshot(doc)) !== stable(tidy))
      fail("the replicas differ after tidy up");
  }
  if (validateSnapshot(tidy).length > 0) fail("the snapshot after tidy up is not valid");
  sameView("tidy up", tidy.elements);
  for (const id of Object.keys(snapshot.routes)) {
    if (stable(routeSteps(tidy, id)) !== stable(routeSteps(snapshot, id)))
      fail(`tidy up changed what route ${id} plays`);
  }
  const leftovers = Object.keys(tidy.elements).filter((id) => {
    const element = tidy.elements[id]!;
    return Object.keys(element.deleted).length > 0;
  });
  if (leftovers.length > 0) fail("tidy up left delete marks behind");
  for (const doc of replicas) options.checkpoint?.(doc);

  return { replicas, snapshot: tidy, failures, steps: counts };
}

// ---------------------------------------------------------------------------
// Junk: what a faulty or hostile peer might write
// ---------------------------------------------------------------------------

/** Things a faulty or hostile peer might store anywhere. */
function junk(rnd: () => number, depth = 0): unknown {
  const value = anything(rnd, depth);
  // Yjs itself refuses these directly in a shared map or array, not nested.
  return typeof value === "function" || typeof value === "bigint" || value instanceof Date
    ? [value]
    : value;
}

function encodable(value: unknown): unknown {
  if (typeof value === "bigint") return 1;
  return Array.isArray(value) ? value.map(encodable) : value;
}

function anything(rnd: () => number, depth: number): unknown {
  const simple = [
    null,
    undefined,
    true,
    0,
    -0,
    -5,
    1.5,
    Number.NaN,
    Infinity,
    "",
    "a b",
    "__proto__",
    "a0",
    "x\uD800",
    10n,
    2n ** 80n,
    new Uint8Array([1, 2]),
    new Date(0),
    () => 1,
    "sha256-" + "f".repeat(64),
  ];
  const roll = Math.floor(rnd() * 16);
  if (depth > 3 || roll < 8) return simple[Math.floor(rnd() * simple.length)];
  if (roll === 8) return [junk(rnd, depth + 1), junk(rnd, depth + 1)];
  if (roll === 9) {
    return JSON.parse(
      `{"__proto__": 1, "$y": ${JSON.stringify(
        ["text", "map", "any", "json", "unsupported", "hologram", 5][
          Math.floor(rnd() * 7)
        ],
      )}, "delta": [], "note": "n", "value": {"u": 2}}`,
    );
  }
  if (roll === 10)
    return {
      x: junk(rnd, depth + 1),
      y: 1,
      w: junk(rnd, depth + 1),
      space: junk(rnd, depth + 1),
    };
  if (roll === 11) {
    const map = new Y.Map<unknown>();
    map.set(String(junk(rnd, 9)), junk(rnd, depth + 1));
    map.set("seen", junk(rnd, depth + 1));
    return map;
  }
  if (roll === 12) {
    const text = new Y.Text();
    text.applyDelta([
      { insert: "ab" },
      { insert: [1, { a: undefined }] as unknown as object },
      // (A big integer here cannot be encoded by Yjs at all, so no peer can send it.)
      { insert: "c", attributes: { k: encodable(junk(rnd, 9)) ?? 1 } },
    ]);
    return text;
  }
  if (roll === 13) {
    const array = new Y.Array<unknown>();
    // (Yjs refuses undefined directly in an array.)
    array.push([junk(rnd, depth + 1) ?? null, junk(rnd, depth + 1) ?? 0]);
    return array;
  }
  if (roll === 14) {
    const fragment = new Y.XmlFragment();
    const element = new Y.XmlElement(String(junk(rnd, 9) ?? ""));
    fragment.insert(0, [element, new Y.XmlText("t")]);
    element.setAttribute("a", junk(rnd, depth + 1) as string);
    return fragment;
  }
  return { nested: { deep: junk(rnd, depth + 1) } };
}

const KEYS = [
  "type",
  "typeVersion",
  "parent",
  "order",
  "pos",
  "rebase",
  "size",
  "rot",
  "name",
  "locked",
  "rev",
  "deleted",
  "dissolved",
  "refs",
  "ext",
  "data",
  "view",
  "notes",
  "visibility",
  "transition",
  "entries",
  "surprise",
  "__proto__",
];

/**
 * Writes random junk into a document, as a faulty or hostile peer could: odd
 * values under known and unknown keys of records, records under odd ids, odd
 * shared types. For tests of the rule that reading is total.
 */
export function scribbleJunk(doc: Y.Doc, seed: number, steps = 25): void {
  const rnd = seededRandom(seed * 31);
  const tables = ["elements", "stops", "routes", "assets", "settings", "meta"];
  for (let step = 0; step < steps; step++) {
    doc.transact(() => {
      const table = doc.getMap<unknown>(tables[Math.floor(rnd() * tables.length)]!);
      const ids = [...table.keys()];
      const roll = rnd();
      const key = KEYS[Math.floor(rnd() * KEYS.length)]!;
      if (roll < 0.15 || ids.length === 0) {
        table.set(rnd() < 0.5 ? `junk${step}` : String(junk(rnd, 9)), junk(rnd));
        return;
      }
      const record = table.get(ids[Math.floor(rnd() * ids.length)]!);
      if (!(record instanceof Y.Map)) return;
      const inner = (record as Y.Map<unknown>).get(key);
      if (inner instanceof Y.Map && rnd() < 0.6) {
        (inner as Y.Map<unknown>).set(
          rnd() < 0.5 ? "k" : String(junk(rnd, 9)),
          junk(rnd),
        );
      } else if (rnd() < 0.1) (record as Y.Map<unknown>).delete(key);
      else (record as Y.Map<unknown>).set(key, junk(rnd));
    }, "remote-peer");
  }
}
