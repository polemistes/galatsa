// SPDX-License-Identifier: GPL-3.0-or-later

// Layout of a Galatsa document in a Y.Doc. Section 2 of
// docs/adr/0001-document-model-and-file-format.md.
//
//   Y.Doc
//   ├─ "meta"      Y.Map   schemaVersion, minReaderVersion, id, title, lineage
//   ├─ "settings"  Y.Map   "<owner>.<name>" -> JSON
//   ├─ "elements"  Y.Map   ElementId -> Y.Map (one per element, below)
//   ├─ "stops"     Y.Map   StopId -> Y.Map (one per stop, below)
//   ├─ "routes"    Y.Map   RouteId -> Y.Map (one per route, below)
//   └─ "assets"    Y.Map   AssetId -> AssetInfo (JSON)
//
//   element Y.Map: type, typeVersion, parent, order, pos, rebase, size, rot, name,
//                  locked, dissolved, refs (JSON values, last writer wins per
//                  key); ext and data (Y.Map: JSON values or nested shared
//                  types); rev and deleted (below)
//   stop Y.Map:    name, view, transition (JSON); notes (Y.Text); visibility
//                  (Y.Map: ElementId -> {action}); ext (Y.Map); rev, deleted
//   route Y.Map:   name, order (JSON); entries (Y.Map: EntryId -> {stop, order});
//                  ext (Y.Map); rev, deleted
//   rev:           Y.Map: writer key -> Y.Array whose length is the counter
//   deleted:       Y.Map: action id -> Y.Map { seen: JSON, id -> revision digest }
//   refs:          Y.Map: id -> true (a set)
//
//   meta also holds "schemaVersion:<n>" and "minReaderVersion:<n>" keys (value
//   true): the way to raise a version. The version in effect is the highest one
//   named, so concurrent raises never lower it (section 9.4).

import * as Y from "yjs";

export const ROOT = {
  meta: "meta",
  settings: "settings",
  elements: "elements",
  stops: "stops",
  routes: "routes",
  assets: "assets",
} as const;

export const ROOT_NAMES: readonly string[] = Object.values(ROOT);
export const META_KEYS = [
  "schemaVersion",
  "minReaderVersion",
  "id",
  "title",
  "lineage",
] as const;
export const ELEMENT_KEYS = [
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
  "purged",
  "refs",
  "ext",
  "data",
] as const;
export const STOP_KEYS = [
  "name",
  "view",
  "notes",
  "visibility",
  "transition",
  "rev",
  "deleted",
  "ext",
] as const;
export const ROUTE_KEYS = ["name", "order", "entries", "rev", "deleted", "ext"] as const;

/** Typed access to the root maps of a document. */
export interface DocRoots {
  meta: Y.Map<unknown>;
  settings: Y.Map<unknown>;
  elements: Y.Map<Y.Map<unknown>>;
  stops: Y.Map<Y.Map<unknown>>;
  routes: Y.Map<Y.Map<unknown>>;
  assets: Y.Map<unknown>;
}

export function roots(doc: Y.Doc): DocRoots {
  return {
    meta: doc.getMap(ROOT.meta),
    settings: doc.getMap(ROOT.settings),
    elements: doc.getMap(ROOT.elements),
    stops: doc.getMap(ROOT.stops),
    routes: doc.getMap(ROOT.routes),
    assets: doc.getMap(ROOT.assets),
  };
}

/**
 * Transaction origins (sections 5.5 and 10). Every local transaction counts as
 * work on the records it changes and can be undone, whatever its origin, except
 * the ones listed here.
 */
export const ORIGIN = {
  /** A change made by the local user through an operation. */
  local: "galatsa:local",
  /** Creating records (they are created removed, then restored by a local change). */
  create: "galatsa:create",
  /** Building a document from a snapshot (loading a file). */
  load: "galatsa:load",
  /** Purging removed records ("tidy up"). Not undoable. */
  tidy: "galatsa:tidy",
  /** Recording work: revisions and refreshed delete marks (section 5.5). */
  track: "galatsa:track",
  /** Re-keying the children of a container whose order keys grew long (section 4.1). */
  rebalance: "galatsa:rebalance",
  /**
   * An extension bringing an element's data up to a newer layout before a user's
   * edit of it (section 9.4). Work like any local change, but the undo manager
   * does not track it: an upgrade keeps the meaning of the data, so undoing the
   * edit leaves the element in the newer layout.
   */
  upgrade: "galatsa:upgrade",
} as const;

/** Origins whose transactions are neither work nor undoable. */
export const INTERNAL_ORIGINS: ReadonlySet<unknown> = new Set([
  ORIGIN.create,
  ORIGIN.load,
  ORIGIN.tidy,
  ORIGIN.track,
  ORIGIN.rebalance,
]);

/** Raised when a document needs a newer version of the format than this code reads. */
export class NewerVersionError extends Error {
  readonly needed: number;
  readonly supported: number;

  constructor(needed: number, supported: number) {
    super(
      `The document needs format version ${needed}; this version reads up to ${supported}.`,
    );
    this.name = "NewerVersionError";
    this.needed = needed;
    this.supported = supported;
  }
}

const VERSION_KEY = /^(schemaVersion|minReaderVersion):([1-9][0-9]{0,8})$/;

/** True for the meta keys that raise a version ("minReaderVersion:2"). */
export function isVersionKey(key: string): boolean {
  return VERSION_KEY.test(key);
}

/**
 * The versions in effect (section 9.4): for each of the two, the highest value
 * the document names, in the base key or in a raising key. A version is raised
 * by adding a key and never lowered, so two clients that raise it concurrently
 * end with the higher value whichever write Yjs lets win.
 */
export function versionsOf(doc: Y.Doc): {
  schemaVersion: number;
  minReaderVersion: number;
} {
  const meta = roots(doc).meta;
  const base = (key: string): number => {
    const value = meta.get(key);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
      ? value
      : 1;
  };
  let schemaVersion = base("schemaVersion");
  let minReaderVersion = base("minReaderVersion");
  for (const key of meta.keys()) {
    const match = VERSION_KEY.exec(key);
    if (!match) continue;
    const n = Number(match[2]);
    if (match[1] === "schemaVersion") schemaVersion = Math.max(schemaVersion, n);
    else minReaderVersion = Math.max(minReaderVersion, n);
  }
  // A document cannot need a newer reader than the version that wrote it.
  return {
    schemaVersion: Math.max(schemaVersion, minReaderVersion),
    minReaderVersion,
  };
}

/**
 * Raises the document's versions to at least the given ones. This is the only
 * way versions change after a document is created; they are never lowered.
 */
export function raiseVersions(
  doc: Y.Doc,
  to: { schemaVersion?: number; minReaderVersion?: number },
  origin: unknown = ORIGIN.load,
): void {
  const now = versionsOf(doc);
  const meta = roots(doc).meta;
  doc.transact(() => {
    for (const name of ["schemaVersion", "minReaderVersion"] as const) {
      const wanted = to[name];
      if (wanted !== undefined && Number.isSafeInteger(wanted) && wanted > now[name]) {
        meta.set(`${name}:${wanted}`, true);
      }
    }
  }, origin);
}
