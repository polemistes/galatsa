// SPDX-License-Identifier: GPL-3.0-or-later

// Layout of a Galatsa document in a Y.Doc. Section 2 of
// docs/adr/0001-document-model-and-file-format.md.
//
//   Y.Doc
//   ├─ "meta"      Y.Map   schemaVersion, id, title
//   ├─ "settings"  Y.Map   "<owner>.<name>" -> JSON
//   ├─ "elements"  Y.Map   ElementId -> Y.Map (one per element, below)
//   ├─ "stops"     Y.Map   StopId -> Y.Map (one per stop, below)
//   ├─ "routes"    Y.Map   RouteId -> Y.Map (one per route, below)
//   └─ "assets"    Y.Map   AssetId -> AssetInfo (JSON)
//
//   element Y.Map: type, typeVersion, parent, order, pos, size, rot, name, locked,
//                  assets, removed (JSON values, last writer wins per key) and
//                  data (Y.Map: JSON values or nested shared types)
//   stop Y.Map:    name, view, transition, removed (JSON); notes (Y.Text);
//                  visibility (Y.Map: ElementId -> {action})
//   route Y.Map:   name, order, removed (JSON); entries (Y.Map: EntryId -> {stop, order})

import * as Y from "yjs";

export const ROOT = {
  meta: "meta",
  settings: "settings",
  elements: "elements",
  stops: "stops",
  routes: "routes",
  assets: "assets",
} as const;

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
 * Transaction origins. Undo (built on Y.UndoManager) tracks only LOCAL, so it
 * never undoes remote changes, loading or migrations.
 */
export const ORIGIN = {
  /** A change made by the local user through a command. */
  local: "galatsa:local",
  /** Building a document from a snapshot (loading a file). */
  load: "galatsa:load",
  /** A data migration run on load. */
  migration: "galatsa:migration",
} as const;
