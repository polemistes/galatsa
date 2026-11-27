// SPDX-License-Identifier: GPL-3.0-or-later

// A test helper: checks a document's live resolver after every transaction
// against a new resolution of the whole document, and checks that what it
// reported covers everything that changed. Used by the property tests.

import type * as Y from "yjs";
import type { ResolvedChanges } from "../model/live.ts";
import { Resolver } from "../model/resolve.ts";
import type { ElementId } from "../model/types.ts";
import { liveResolver } from "./live.ts";
import { toSnapshot, yLookup } from "./snapshot.ts";

const ROOT = "(root)";

/** Everything a Resolver answers, per element and per container, as text. */
export interface ResolvedState {
  readonly elements: Map<ElementId, string>;
  /** Children and logical children, by container id or "(root)". */
  readonly children: Map<string, string>;
  readonly drawOrder: string;
}

function point(p: { x: number; y: number }): string {
  return `${p.x},${p.y}`;
}

/** Reads everything the Resolver offers about every element. */
export function resolvedState(r: Resolver): ResolvedState {
  const elements = new Map<ElementId, string>();
  const children = new Map<string, string>();
  const list = (container: ElementId | null) => {
    const effective = r.children(container);
    const logical = r.logicalChildren(container);
    if (effective.length > 0 || logical.length > 0)
      children.set(container ?? ROOT, `${effective.join(" ")} | ${logical.join(" ")}`);
  };
  list(null);
  for (const id of r.ids()) {
    const e = r.get(id);
    if (!e) continue;
    const bounds = r.bounds(id);
    elements.set(
      id,
      [
        e.type,
        r.parentOf(id),
        r.logicalParentOf(id),
        e.order,
        point(r.localPosition(id)),
        point(r.worldOrigin(id)),
        e.size ? `${e.size.w}x${e.size.h}` : "-",
        e.rot ?? "-",
        r.isDeleted(id),
        r.isGone(id),
        r.isLocked(id),
        bounds ? `${bounds.x},${bounds.y},${bounds.w},${bounds.h}` : "-",
      ].join(" "),
    );
    if (r.isContainer(id)) list(id);
  }
  return { elements, children, drawOrder: r.drawOrder().join(" ") };
}

/** Element records as stored, without the bookkeeping keys, as text. */
function contents(doc: Y.Doc): Map<ElementId, string> {
  const out = new Map<ElementId, string>();
  const { elements } = toSnapshot(doc);
  for (const id of Object.keys(elements)) {
    const { rev: _rev, deleted: _deleted, ...rest } = elements[id]!;
    out.set(id, JSON.stringify(rest));
  }
  return out;
}

function compare(
  a: ResolvedState,
  b: ResolvedState,
  report: (message: string) => void,
): boolean {
  let same = true;
  const differ = (message: string) => {
    if (same) report(message);
    same = false;
  };
  for (const [id, text] of b.elements) {
    if (a.elements.get(id) !== text)
      differ(`${id}: live "${a.elements.get(id)}", anew "${text}"`);
  }
  for (const id of a.elements.keys())
    if (!b.elements.has(id)) differ(`${id} exists only in the live resolver`);
  for (const key of new Set([...a.children.keys(), ...b.children.keys()])) {
    if (a.children.get(key) !== b.children.get(key))
      differ(
        `children of ${key}: live "${a.children.get(key)}", anew "${b.children.get(key)}"`,
      );
  }
  if (a.drawOrder !== b.drawOrder) differ("drawing order differs");
  return same;
}

/**
 * Watches a document's live resolver. After every transaction it compares the
 * live resolver with a new Resolver of the whole document, and the state before
 * the transaction with the state after it: every element whose answers or
 * stored content changed must have been reported, and so must every container
 * whose children changed. `where` names the moment for failure messages.
 * Returns a function that stops watching.
 */
export function watchLiveResolver(
  doc: Y.Doc,
  fail: (message: string) => void,
  where: () => string = () => "",
): () => void {
  const live = liveResolver(doc);
  let before = resolvedState(new Resolver(yLookup(doc)));
  let content = contents(doc);
  let reported: ResolvedChanges | null = null;
  const stop = live.subscribe((changes) => {
    if (reported !== null) fail(`${where()}: two reports for one transaction`);
    reported = changes;
  });
  let failed = 0;
  const report = (message: string) => {
    if (failed++ < 3) fail(`${where()}: ${message}`);
  };
  const check = (tr: Y.Transaction) => {
    const changes: ResolvedChanges = reported ?? {
      added: new Set(),
      changed: new Set(),
      removed: new Set(),
      containers: new Set(),
      drawOrder: false,
    };
    reported = null;
    const after = resolvedState(new Resolver(yLookup(doc)));
    const afterContent = contents(doc);
    const origin = String(tr.origin);
    compare(resolvedState(live), after, (m) => report(`(${origin}) ${m}`));
    for (const [id, text] of after.elements) {
      const was = before.elements.get(id);
      if (was === undefined) {
        if (!changes.added.has(id)) report(`(${origin}) ${id} added, not reported`);
      } else if (was !== text || content.get(id) !== afterContent.get(id)) {
        if (!changes.changed.has(id))
          report(`(${origin}) ${id} changed, not reported: "${was}" -> "${text}"`);
      }
    }
    for (const id of before.elements.keys()) {
      if (!after.elements.has(id) && !changes.removed.has(id))
        report(`(${origin}) ${id} removed, not reported`);
    }
    for (const key of new Set([...before.children.keys(), ...after.children.keys()])) {
      if (before.children.get(key) === after.children.get(key)) continue;
      const container = key === ROOT ? null : key;
      if (!changes.containers.has(container))
        report(
          `(${origin}) children of ${key} changed, not reported: "${before.children.get(key)}" -> "${after.children.get(key)}"`,
        );
      if (
        container !== null &&
        after.elements.has(container) &&
        before.elements.has(container) &&
        !changes.changed.has(container)
      )
        report(`(${origin}) container ${key} not reported as changed`);
    }
    if (before.drawOrder !== after.drawOrder && !changes.drawOrder)
      report(`(${origin}) drawing order changed, not reported`);
    for (const id of [...changes.added, ...changes.changed, ...changes.removed]) {
      const n =
        Number(changes.added.has(id)) +
        Number(changes.changed.has(id)) +
        Number(changes.removed.has(id));
      if (n !== 1) report(`(${origin}) ${id} reported in ${n} sets`);
    }
    before = after;
    content = afterContent;
  };
  doc.on("afterTransaction", check);
  return () => {
    stop();
    doc.off("afterTransaction", check);
  };
}
