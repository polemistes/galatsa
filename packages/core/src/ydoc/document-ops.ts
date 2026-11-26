// SPDX-License-Identifier: GPL-3.0-or-later

// Operations on a whole Y.Doc: tidy up (purge removed content), paste a fragment
// with new ids, and import another copy of a document as new content. Sections
// 3.5, 5.8 and 9.3 of docs/adr/0001-document-model-and-file-format.md.

import * as Y from "yjs";
import { copyFragment, type Fragment } from "../model/fragment.ts";
import {
  ASSET_ID_PATTERN,
  ID_PATTERN,
  InvalidDocumentError,
  Problems,
  readAsset,
  readRouteEntry,
  readSnapshot,
} from "../model/grammar.ts";
import { newId } from "../model/ids.ts";
import { keysBetween, sortOrdered } from "../model/order.ts";
import { purgeSnapshot } from "../model/purge.ts";
import { Resolver, lookupFromRecord } from "../model/resolve.ts";
import { isRemoved, liveRoutes } from "../model/route.ts";
import {
  setOwn,
  type AssetId,
  type DocumentSnapshot,
  type Element,
  type ElementId,
  type Route,
  type RouteId,
  type Stop,
  type StopId,
} from "../model/types.ts";
import { referencedAssets, remapStrings } from "../model/walk.ts";
import { jsonFromY } from "./encode.ts";
import {
  addAsset,
  assertWritable,
  createTransact,
  makeRoom,
  slotsOf,
  type OpOptions,
} from "./ops.ts";
import { META_KEYS, ORIGIN, isVersionKey, roots } from "./schema.ts";
import {
  RECORD_KEYS,
  foreignRootContent,
  fromSnapshot,
  marksOf,
  revisionOf,
  toSnapshot,
  writeElement,
  writeRoute,
  writeStop,
  yLookup,
} from "./snapshot.ts";
import { trackWork } from "./track.ts";

export interface TidySummary {
  /** Removed elements whose records were deleted. */
  elements: number;
  /** Removed frames and groups that were emptied and are now place markers. */
  containers: number;
  stops: number;
  routes: number;
  assets: number;
  /** Records and keys that this version of the format does not define. */
  other: number;
}

/** The shared types directly inside a shared type. */
function childTypes(type: Y.AbstractType<unknown>): Y.AbstractType<unknown>[] {
  const out: unknown[] = [];
  if (type instanceof Y.Map) out.push(...(type as Y.Map<unknown>).values());
  else if (type instanceof Y.Array) out.push(...(type as Y.Array<unknown>).toArray());
  else if (type instanceof Y.XmlFragment) out.push(...type.toArray());
  if (type instanceof Y.Text) {
    for (const op of type.toDelta() as Array<{ insert: unknown }>) out.push(op.insert);
  }
  if (type instanceof Y.Text || type instanceof Y.XmlElement) {
    out.push(...Object.values(type.getAttributes() as Record<string, unknown>));
  }
  return out.filter((v): v is Y.AbstractType<unknown> => v instanceof Y.AbstractType);
}

/** Levels of nested shared types Yjs can safely delete in one go. */
const SAFE_DEPTH = 32;

/**
 * Empties a value that is about to be deleted, if it is nested deeper than Yjs
 * can delete at once. Yjs deletes and garbage-collects nested shared types by
 * recursion, and a structure nested thousands of levels deep (only a faulty peer
 * makes one) would overflow the stack. So such a value is emptied from the
 * deepest level upwards, a few levels per transaction.
 */
function emptyDeep(doc: Y.Doc, value: unknown): void {
  if (!(value instanceof Y.AbstractType)) return;
  const levels: Y.AbstractType<unknown>[][] = [];
  const stack: Array<[Y.AbstractType<unknown>, number]> = [
    [value as Y.AbstractType<unknown>, 0],
  ];
  while (stack.length > 0) {
    const [type, depth] = stack.pop()!;
    (levels[depth] ??= []).push(type);
    for (const child of childTypes(type)) stack.push([child, depth + 1]);
  }
  for (let top = levels.length; top > SAFE_DEPTH; top -= SAFE_DEPTH) {
    doc.transact(() => {
      for (let depth = top - 1; depth >= top - SAFE_DEPTH && depth > 0; depth--) {
        for (const type of levels[depth]!) {
          if (type instanceof Y.Map) for (const key of [...type.keys()]) type.delete(key);
          else if (type instanceof Y.Array) type.delete(0, type.length);
          else if (type instanceof Y.Text) type.delete(0, type.length);
          else if (type instanceof Y.XmlFragment) type.delete(0, type.length);
        }
      }
    }, ORIGIN.tidy);
  }
}

function unknownKeys(record: Y.Map<unknown>, known: readonly string[]): string[] {
  return [...record.keys()].filter((key) => !known.includes(key));
}

function dropUnknownKeys(record: Y.Map<unknown>, known: readonly string[]): number {
  const keys = unknownKeys(record, known);
  for (const key of keys) record.delete(key);
  return keys.length;
}

function clearMap(value: unknown): void {
  if (value instanceof Y.Map) for (const key of [...value.keys()]) value.delete(key);
}

/** Deletes everything a root type holds that the format has no place for. */
function clearForeign(
  tr: Y.Transaction,
  type: Y.AbstractType<unknown>,
  what: "all" | "list",
): void {
  for (let item = type._start; item !== null; item = item.right) {
    if (!item.deleted) item.delete(tr);
  }
  if (what === "list") return;
  for (const item of type._map.values()) if (!item.deleted) item.delete(tr);
}

/** The shared types directly in a root type, whatever kind of type it is. */
function typesIn(type: Y.AbstractType<unknown>): unknown[] {
  const out: unknown[] = [];
  const take = (item: Y.Item | null) => {
    if (item && !item.deleted && item.content instanceof Y.ContentType)
      out.push(item.content.type);
  };
  for (let item = type._start; item !== null; item = item.right) take(item);
  for (const item of type._map.values()) take(item);
  return out;
}

/**
 * Tidy up (section 5.8): permanently removes what the user no longer sees. What
 * the user sees does not change, and no value that is kept is rewritten
 * (positions, parents, order keys, sizes, content), so the purge conflicts with
 * no edit made elsewhere.
 *
 * - Removed elements are deleted, except frames and groups: those are emptied
 *   (name, data, ext, references and lock cleared) and stay as place markers
 *   (`purged`), gone for good, so that work done offline inside them still
 *   lands in the right place when it merges.
 * - Removed stops and routes are deleted, with route entries and visibility
 *   entries that point at deleted records.
 * - Asset descriptions nothing refers to, and everything this version of the
 *   format does not define (records, keys, the content of unknown root types),
 *   are deleted.
 * - Delete marks stay, without their entries for the records deleted here: a
 *   mark that hides nothing now may be waiting for work it lists that has not
 *   arrived yet. The work tracker removes a mark when it can never apply again.
 *
 * It cannot be undone, and edits that offline copies made to purged records are
 * lost when they merge, which is why it only runs on request.
 */
export function tidyUp(doc: Y.Doc): TidySummary {
  assertWritable(doc);
  const r = roots(doc);
  const summary: TidySummary = {
    elements: 0,
    containers: 0,
    stops: 0,
    routes: 0,
    assets: 0,
    other: 0,
  };
  // Decide everything on the state before the purge.
  const view = new Resolver(yLookup(doc));
  type Fate = "junk" | "delete" | "marker" | "keep";
  const fates = new Map<string, Fate>();
  for (const [id, record] of r.elements.entries()) {
    if (!(record instanceof Y.Map) || !ID_PATTERN.test(id) || !view.get(id)) {
      fates.set(id, "junk");
    } else if (!view.isGone(id)) fates.set(id, "keep");
    else fates.set(id, view.isContainer(id) ? "marker" : "delete");
  }
  const removed = (id: string, record: unknown): Fate => {
    if (!(record instanceof Y.Map) || !ID_PATTERN.test(id)) return "junk";
    const map = record as Y.Map<unknown>;
    return isRemoved(id, { rev: revisionOf(map), deleted: marksOf(map) })
      ? "delete"
      : "keep";
  };
  const stopFates = new Map<string, Fate>();
  for (const [id, record] of r.stops.entries()) stopFates.set(id, removed(id, record));
  const routeFates = new Map<string, Fate>();
  for (const [id, record] of r.routes.entries()) routeFates.set(id, removed(id, record));
  const foreign = [...doc.share].flatMap(([name, type]) => {
    const what = foreignRootContent(name, type as Y.AbstractType<unknown>);
    return what === null ? [] : [{ type: type as Y.AbstractType<unknown>, what }];
  });

  // What is about to be deleted is emptied first where it is nested too deep.
  const doomed = (
    table: Y.Map<unknown>,
    list: Map<string, Fate>,
    known: readonly string[],
  ) => {
    for (const [id, fate] of list) {
      const record = table.get(id);
      if (fate !== "keep" && fate !== "marker") emptyDeep(doc, record);
      else if (record instanceof Y.Map) {
        for (const key of unknownKeys(record as Y.Map<unknown>, known))
          emptyDeep(doc, (record as Y.Map<unknown>).get(key));
        if (fate === "marker") {
          emptyDeep(doc, (record as Y.Map<unknown>).get("data"));
          emptyDeep(doc, (record as Y.Map<unknown>).get("ext"));
        }
      }
    }
  };
  doomed(r.elements as Y.Map<unknown>, fates, RECORD_KEYS.elements);
  doomed(r.stops as Y.Map<unknown>, stopFates, RECORD_KEYS.stops);
  doomed(r.routes as Y.Map<unknown>, routeFates, RECORD_KEYS.routes);
  for (const { type } of foreign) for (const inner of typesIn(type)) emptyDeep(doc, inner);

  /** Takes the entries for records deleted here out of the marks that stay. */
  const trimMarks = (record: Y.Map<unknown>, gone: Map<string, Fate>) => {
    const marks = record.get("deleted");
    if (!(marks instanceof Y.Map)) return;
    for (const mark of (marks as Y.Map<unknown>).values()) {
      if (!(mark instanceof Y.Map)) continue;
      const seen = (mark as Y.Map<unknown>).get("seen");
      if (typeof seen !== "object" || seen === null) continue;
      const kept: Record<string, unknown> = {};
      let dropped = false;
      for (const id of Object.keys(seen)) {
        const fate = gone.get(id);
        if (fate === "delete" || fate === "junk") dropped = true;
        else setOwn(kept, id, (seen as Record<string, unknown>)[id]);
      }
      if (dropped) (mark as Y.Map<unknown>).set("seen", kept);
    }
  };

  doc.transact((tr) => {
    for (const [id, fate] of fates) {
      const record = r.elements.get(id) as Y.Map<unknown>;
      if (fate === "junk" || fate === "delete") {
        r.elements.delete(id);
        if (fate === "junk") summary.other++;
        else summary.elements++;
        continue;
      }
      summary.other += dropUnknownKeys(record, RECORD_KEYS.elements);
      trimMarks(record, fates);
      if (fate === "marker") {
        if (record.get("purged") !== true) {
          record.set("purged", true);
          summary.containers++;
        }
        if (record.get("name") !== "") record.set("name", "");
        if (record.get("locked") !== false) record.set("locked", false);
        clearMap(record.get("refs"));
        clearMap(record.get("data"));
        clearMap(record.get("ext"));
      }
    }
    for (const [id, fate] of stopFates) {
      if (fate !== "keep") {
        r.stops.delete(id);
        if (fate === "junk") summary.other++;
        else summary.stops++;
        continue;
      }
      const record = r.stops.get(id) as Y.Map<unknown>;
      summary.other += dropUnknownKeys(record, RECORD_KEYS.stops);
      const visibility = record.get("visibility");
      if (visibility instanceof Y.Map) {
        for (const element of [...visibility.keys()]) {
          if (!r.elements.has(element)) visibility.delete(element);
        }
      }
    }
    for (const [id, fate] of routeFates) {
      if (fate !== "keep") {
        r.routes.delete(id);
        if (fate === "junk") summary.other++;
        else summary.routes++;
        continue;
      }
      const record = r.routes.get(id) as Y.Map<unknown>;
      summary.other += dropUnknownKeys(record, RECORD_KEYS.routes);
      const entries = record.get("entries");
      if (entries instanceof Y.Map) {
        const quiet = new Problems(0);
        for (const [entry, value] of [...entries.entries()]) {
          const read = ID_PATTERN.test(entry)
            ? readRouteEntry(jsonFromY(value), quiet)
            : null;
          if (!read || !r.stops.has(read.stop)) entries.delete(entry);
        }
      }
    }
    for (const key of [...r.meta.keys()]) {
      if ((META_KEYS as readonly string[]).includes(key) || isVersionKey(key)) continue;
      r.meta.delete(key);
      summary.other++;
    }
    for (const { type, what } of foreign) {
      clearForeign(tr, type, what);
      summary.other++;
    }
    const used = referencedAssets(toSnapshot(doc));
    const quiet = new Problems(0);
    for (const [id, info] of [...r.assets.entries()]) {
      if (!ASSET_ID_PATTERN.test(id) || !readAsset(jsonFromY(info), quiet)) {
        r.assets.delete(id);
        summary.other++;
      } else if (!used.has(id as AssetId)) {
        r.assets.delete(id);
        summary.assets++;
      }
    }
  }, ORIGIN.tidy);
  return summary;
}

export interface PasteResult {
  /** Old id -> new id, for elements, stops and routes. */
  ids: Map<string, string>;
  /** Assets the pasted content refers to; copy their bytes into this document's store. */
  assets: AssetId[];
}

/** The digest of the revision of a record that was just created. */
const NEW = "";

/**
 * Pastes a fragment with new ids (section 3.5). Roots go into `parent` (default:
 * the root), moved by (dx, dy), in front of what is there. Inside each element,
 * strings equal to an id the element lists in `refs` are remapped if that id was
 * pasted too; so are parents, position spaces, frame stops, stop spaces,
 * visibility entries and route entries. Undo removes the pasted records softly.
 */
export function pasteFragment(
  doc: Y.Doc,
  fragment: Fragment,
  target: { parent?: ElementId | null; dx?: number; dy?: number } = {},
  options?: OpOptions,
): PasteResult {
  assertWritable(doc);
  trackWork(doc, options?.randomBytes);
  const parent = target.parent ?? null;
  const dx = target.dx ?? 0;
  const dy = target.dy ?? 0;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new InvalidDocumentError("offset", ["offset: must be finite numbers"]);
  }
  makeRoom(doc, parent);
  const r0 = roots(doc);
  const ids = new Map<string, string>();
  for (const id of [
    ...Object.keys(fragment.elements),
    ...Object.keys(fragment.stops),
    ...Object.keys(fragment.routes),
  ]) {
    ids.set(id, newId(options?.randomBytes));
  }
  const mapId = (id: string | null) => (id === null ? null : (ids.get(id) ?? id));

  // In front of everything the user sees in the target container.
  const front = slotsOf(new Resolver(yLookup(doc)), parent).pop();
  const rootKeys = keysBetween(front?.order ?? null, null, fragment.roots.length);
  const rootIndex = new Map(fragment.roots.map((id, i) => [id, i]));
  // Each root is created removed, with a mark that covers what is pasted inside it.
  const inside = new Map<ElementId, ElementId[]>();
  for (const oldId of Object.keys(fragment.elements)) {
    let at: ElementId | null = oldId;
    const seenOnWay = new Set<ElementId>();
    while (at !== null && !rootIndex.has(at) && !seenOnWay.has(at)) {
      seenOnWay.add(at);
      at = Object.hasOwn(fragment.elements, at) ? fragment.elements[at]!.parent : null;
    }
    if (at !== null && rootIndex.has(at)) {
      const list = inside.get(at) ?? [];
      list.push(oldId);
      inside.set(at, list);
    }
  }
  const actions = new Map<Y.Map<unknown> | string, string>();

  const elements: [ElementId, Element][] = [];
  for (const [oldId, element] of Object.entries(fragment.elements)) {
    const id = ids.get(oldId)!;
    const own = new Map([...ids].filter(([from]) => element.refs.includes(from)));
    const index = rootIndex.get(oldId);
    const next: Element = {
      ...element,
      parent: index !== undefined ? parent : mapId(element.parent),
      order: index !== undefined ? rootKeys[index]! : element.order,
      pos:
        index !== undefined
          ? { x: element.pos.x + dx, y: element.pos.y + dy, space: parent }
          : { ...element.pos, space: mapId(element.pos.space) },
      rebase: null,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [...new Set(element.refs.map((ref) => ids.get(ref) ?? ref))].sort(),
      ext: remapStrings(element.ext, own),
      data: remapStrings(element.data, own),
    };
    if (index !== undefined) {
      const seen: { [id: string]: string } = {};
      for (const member of inside.get(oldId) ?? [oldId]) setOwn(seen, ids.get(member)!, NEW);
      const action = newId(options?.randomBytes);
      actions.set(`elements ${id}`, action);
      next.deleted = { [action]: { seen } };
    }
    elements.push([id, next]);
  }
  const selfMark = (kind: string, id: string) => {
    const action = newId(options?.randomBytes);
    actions.set(`${kind} ${id}`, action);
    return { [action]: { seen: { [id]: NEW } } };
  };
  const stops: [StopId, Stop][] = [];
  for (const [oldId, stop] of Object.entries(fragment.stops)) {
    const id = ids.get(oldId)!;
    let view = stop.view;
    // A frame stop whose frame is not pasted, and was gone where it was copied,
    // shows the same place as a rectangle.
    const fallback = Object.hasOwn(fragment.fallbackViews, oldId)
      ? fragment.fallbackViews[oldId]
      : undefined;
    if (view.kind === "frame" && !ids.has(view.frame) && fallback) view = fallback;
    if (view.kind === "frame") view = { ...view, frame: mapId(view.frame)! };
    else if (view.space === null)
      view = { ...view, space: parent, x: view.x + dx, y: view.y + dy };
    else view = { ...view, space: mapId(view.space) };
    const visibility: Stop["visibility"] = {};
    for (const element of Object.keys(stop.visibility)) {
      if (ids.has(element))
        setOwn(visibility, ids.get(element)!, stop.visibility[element]!);
    }
    stops.push([
      id,
      { ...stop, view, visibility, rev: {}, deleted: selfMark("stops", id) },
    ]);
  }
  const routes: [RouteId, Route][] = [];
  const liveOrders = sortOrdered(
    [...r0.routes.entries()]
      .filter(
        ([id, record]) =>
          record instanceof Y.Map &&
          !isRemoved(id, { rev: revisionOf(record), deleted: marksOf(record) }),
      )
      .map(([id, record]) => {
        const order = (record as Y.Map<unknown>).get("order");
        return { id, order: typeof order === "string" ? order : "" };
      }),
  );
  const routeKeys = keysBetween(
    liveOrders[liveOrders.length - 1]?.order ?? null,
    null,
    Object.keys(fragment.routes).length,
  );
  Object.entries(fragment.routes).forEach(([oldId, route], i) => {
    const id = ids.get(oldId)!;
    const entries: Route["entries"] = {};
    for (const entry of Object.keys(route.entries)) {
      const stop = route.entries[entry]!.stop;
      // An entry is kept if its stop is pasted too or exists in this document.
      if (!ids.has(stop) && !r0.stops.has(stop)) continue;
      setOwn(entries, newId(options?.randomBytes), {
        ...route.entries[entry]!,
        stop: ids.get(stop) ?? stop,
      });
    }
    routes.push([
      id,
      {
        ...route,
        order: routeKeys[i]!,
        entries,
        rev: {},
        deleted: selfMark("routes", id),
      },
    ]);
  });

  for (const [id, info] of Object.entries(fragment.assets))
    addAsset(doc, id as AssetId, info);
  createTransact(doc, () => {
    for (const [id, element] of elements) {
      const map = new Y.Map<unknown>();
      r0.elements.set(id, map);
      writeElement(map, element);
    }
    for (const [id, stop] of stops) {
      const map = new Y.Map<unknown>();
      r0.stops.set(id, map);
      writeStop(map, stop);
    }
    for (const [id, route] of routes) {
      const map = new Y.Map<unknown>();
      r0.routes.set(id, map);
      writeRoute(map, route);
    }
  });
  doc.transact(() => {
    const restore = (kind: "elements" | "stops" | "routes", id: string) => {
      const action = actions.get(`${kind} ${id}`);
      const record = r0[kind].get(id);
      if (action === undefined || !(record instanceof Y.Map)) return;
      const marks = record.get("deleted") as unknown;
      if (marks instanceof Y.Map) marks.delete(action);
    };
    for (const [id] of elements) restore("elements", id);
    for (const [id] of stops) restore("stops", id);
    for (const [id] of routes) restore("routes", id);
  }, options?.origin ?? ORIGIN.local);
  return { ids, assets: Object.keys(fragment.assets) as AssetId[] };
}

/**
 * Imports everything visible in another copy of a document as new content with
 * new ids: its elements (in front of what is here, moved by an offset), stops
 * and routes. This is the way to bring work together when two copies no longer
 * share merge identity and cannot be synced (section 9.3): nothing is merged
 * record by record, so nothing is overwritten; the user removes what is double.
 */
export function importCopy(
  doc: Y.Doc,
  source: DocumentSnapshot,
  target: { parent?: ElementId | null; dx?: number; dy?: number } = {},
  options?: OpOptions,
): PasteResult {
  const snapshot = readSnapshot(source).snapshot;
  if (!snapshot) throw new InvalidDocumentError("document", ["must be an object"]);
  const r = new Resolver(lookupFromRecord(snapshot.elements));
  const stops = Object.keys(snapshot.stops).filter(
    (id) => !isRemoved(id, snapshot.stops[id]!),
  );
  const fragment = copyFragment(
    snapshot,
    r.logicalChildren(null),
    stops,
    liveRoutes(snapshot),
  );
  return pasteFragment(doc, fragment, target, options);
}

/**
 * A new document with the content of another: a new document id and a new
 * lineage, so the two are separate presentations from then on and never merge
 * ("save as a copy"). With `purge`, removed content is left behind.
 */
export function independentCopy(
  source: Y.Doc | DocumentSnapshot,
  options: OpOptions & { purge?: boolean } = {},
): Y.Doc {
  let snapshot = source instanceof Y.Doc ? toSnapshot(source) : readSnapshot(source).snapshot;
  if (!snapshot) throw new InvalidDocumentError("document", ["must be an object"]);
  if (options.purge) snapshot = purgeSnapshot(snapshot);
  return fromSnapshot(
    { ...snapshot, id: newId(options.randomBytes) },
    new Y.Doc(),
    options.randomBytes,
  );
}
