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
//   deleted:       Y.Map: action id -> Y.Map { seen: JSON }

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
} as const;

/** Origins whose transactions are neither work nor undoable. */
export const INTERNAL_ORIGINS: ReadonlySet<unknown> = new Set([
  ORIGIN.create,
  ORIGIN.load,
  ORIGIN.tidy,
  ORIGIN.track,
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
