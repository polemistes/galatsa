// SPDX-License-Identifier: GPL-3.0-or-later

// Which route the editor shows and which of its steps is chosen, per
// document. Not document content: it is not saved, not shared with other
// users and not undone. The panel and the route line read it; the commands
// that add a route or a stop choose what they made.

import type { RouteEntryId, RouteId } from "@galatsa/core";
import type * as Y from "yjs";
import { entryOrder, isLiveRoute, liveRoutes, type StopsAndRoutes } from "./model.ts";

export interface RouteChoice {
  readonly route: RouteId | null;
  readonly entry: RouteEntryId | null;
}

interface Slot {
  choice: RouteChoice;
  readonly listeners: Set<() => void>;
}

const slots = new WeakMap<Y.Doc, Slot>();

function slot(doc: Y.Doc): Slot {
  let found = slots.get(doc);
  if (!found) {
    found = { choice: { route: null, entry: null }, listeners: new Set() };
    slots.set(doc, found);
  }
  return found;
}

/** What was chosen, as stored (it may name a route that is gone since). */
export function storedChoice(doc: Y.Doc): RouteChoice {
  return slot(doc).choice;
}

/** Chooses a route and one of its entries (null for none). */
export function choose(doc: Y.Doc, choice: RouteChoice): void {
  const s = slot(doc);
  if (s.choice.route === choice.route && s.choice.entry === choice.entry) return;
  s.choice = { route: choice.route, entry: choice.entry };
  for (const listener of [...s.listeners]) {
    try {
      listener();
    } catch (error) {
      console.error(error);
    }
  }
}

/** Calls `listener` when the choice changes; returns how to stop. */
export function watchChoice(doc: Y.Doc, listener: () => void): () => void {
  const s = slot(doc);
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/**
 * The route the editor shows: the chosen one while it is there, otherwise the
 * first route, or null when there is none. The entry is the chosen one if it
 * is still an entry of that route.
 */
export function currentChoice(doc: Y.Doc, sr: StopsAndRoutes): RouteChoice {
  const stored = storedChoice(doc);
  const route = isLiveRoute(sr, stored.route)
    ? stored.route
    : (liveRoutes(sr)[0] ?? null);
  if (route === null) return { route: null, entry: null };
  const entry =
    route === stored.route &&
    stored.entry !== null &&
    entryOrder(sr, route).includes(stored.entry)
      ? stored.entry
      : null;
  return { route, entry };
}
