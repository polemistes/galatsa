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
//                  locked, rev, deleted, dissolved, refs (JSON values, last writer
//                  wins per key); ext and data (Y.Map: JSON values or nested
//                  shared types)
//   stop Y.Map:    name, view, transition, rev, removed (JSON); notes (Y.Text);
//                  visibility (Y.Map: ElementId -> {action}); ext (Y.Map)
//   route Y.Map:   name, order, rev, removed (JSON); entries (Y.Map: EntryId ->
//                  {stop, order}); ext (Y.Map)

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
  "removed",
  "ext",
] as const;
export const ROUTE_KEYS = ["name", "order", "entries", "rev", "removed", "ext"] as const;

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
 * Transaction origins (section 10). Undo (Y.UndoManager) tracks only `local`, so
 * it never undoes remote changes, loading, record creation or tidying.
 */
export const ORIGIN = {
  /** A change made by the local user through a command. Undoable. */
  local: "galatsa:local",
  /** Creating records (they are created removed, then restored by a local change). */
  create: "galatsa:create",
  /** Building a document from a snapshot (loading a file). */
  load: "galatsa:load",
  /** Purging removed records ("tidy up"). Not undoable. */
  tidy: "galatsa:tidy",
} as const;

/** The undo manager configuration that keeps the guarantees of section 10. */
export function createUndoManager(doc: Y.Doc, captureTimeout = 500): Y.UndoManager {
  const r = roots(doc);
  return new Y.UndoManager([r.elements, r.stops, r.routes, r.settings, r.meta], {
    trackedOrigins: new Set([ORIGIN.local]),
    captureTimeout,
  });
}
