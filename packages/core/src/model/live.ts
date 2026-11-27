// SPDX-License-Identifier: GPL-3.0-or-later

// The live resolver: one Resolver that is kept up to date as the document
// changes, instead of resolving everything anew, and that tells after each
// change which elements it concerned. Section 11 of
// docs/adr/0001-document-model-and-file-format.md.
//
// It knows nothing of Yjs. Whoever owns the document tells it which element
// records changed and which of their keys (`update`); the Yjs binding does that
// after every transaction (`liveResolver` in `@galatsa/core/ydoc`).
//
// How an update works. Resolution of an element depends on its own record and
// on other records: its stored ancestors (the effective parent, cycles), its
// effective ancestors (position, deletes, gone containers, locks), the
// containers a position written in another space is converted through (rule 3
// of section 5.3), and, for the bounds of groups and gone containers, its
// descendants. From the changed records, the update collects every element
// whose resolution may differ (a superset), drops what the Resolver cached
// about them, resolves them again and compares the result with what it had.

import { Resolver, type ElementLookup, type Point } from "./resolve.ts";
import { GROUP_TYPE, type ElementId, type OrderKey, type Rect } from "./types.ts";

/**
 * What one change of the document did to its elements, as the live resolver
 * reports it. Each id is in at most one of `added`, `changed` and `removed`.
 */
export interface ResolvedChanges {
  /** Elements that exist now and did not before. */
  readonly added: ReadonlySet<ElementId>;
  /**
   * Elements that exist before and after, and that someone who draws the
   * document has to read again: anything the Resolver answers about them may be
   * different (effective and logical parent, local and world position, size,
   * rotation, order key, deleted or gone, locked, bounds), or their record
   * changed in another way (data, ext, name, references, type version). This
   * includes elements that changed only because something above them did: the
   * children of a frame that moved (their world position changed), everything
   * inside a deleted container (now gone), and groups whose bounds changed with
   * their members. A container whose children (or logical children) changed is
   * listed too. A deleted element is changed, not removed: it is still in the
   * document, gone.
   */
  readonly changed: ReadonlySet<ElementId>;
  /** Elements that existed before and do not now (deleted from the document by tidy up, or no longer valid records). */
  readonly removed: ReadonlySet<ElementId>;
  /**
   * Containers whose children or logical children changed (membership or
   * order), null standing for the root.
   */
  readonly containers: ReadonlySet<ElementId | null>;
  /** Whether the drawing order (`drawOrder`) may have changed. */
  readonly drawOrder: boolean;
}

/**
 * Keys of an element record whose change can alter how other elements resolve,
 * by what they alter. A change of any other key concerns the element alone.
 * A change of `rev` or `deleted` alone is bookkeeping and not reported unless
 * it changes what is shown.
 */
const KEY_KINDS: ReadonlyMap<
  string,
  "structure" | "deleted" | "rev" | "position" | "view"
> = new Map([
  ["type", "structure"],
  ["parent", "structure"],
  ["deleted", "deleted"],
  ["rev", "rev"],
  ["pos", "position"],
  ["rebase", "position"],
  ["dissolved", "view"],
  ["purged", "view"],
  ["locked", "view"],
]);

/** What the live resolver remembers of one element, to compare after a change. */
interface Resolved {
  readonly type: string;
  /** The stored parent and the space of the stored position (for the indexes). */
  readonly storedParent: ElementId | null;
  readonly space: ElementId | null;
  readonly parent: ElementId | null;
  readonly logicalParent: ElementId | null;
  readonly order: OrderKey;
  readonly local: Point;
  readonly world: Point;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  readonly deleted: boolean;
  /** The deletes that hide it, as text (what is inside depends on them). */
  readonly deleters: string;
  readonly gone: boolean;
  readonly locked: boolean;
  /** A group or gone container: its bounds come from its descendants. */
  readonly derived: boolean;
  readonly bounds: Rect | null;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function sameResolved(a: Resolved, b: Resolved): boolean {
  return (
    a.type === b.type &&
    a.parent === b.parent &&
    a.logicalParent === b.logicalParent &&
    a.order === b.order &&
    a.local.x === b.local.x &&
    a.local.y === b.local.y &&
    a.world.x === b.world.x &&
    a.world.y === b.world.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.rot === b.rot &&
    a.deleted === b.deleted &&
    a.gone === b.gone &&
    a.locked === b.locked &&
    sameRect(a.bounds, b.bounds)
  );
}

function addTo(
  index: Map<ElementId, Set<ElementId>>,
  key: ElementId,
  id: ElementId,
): void {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(id);
}

function removeFrom(
  index: Map<ElementId, Set<ElementId>>,
  key: ElementId,
  id: ElementId,
): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) index.delete(key);
}

/**
 * A Resolver that stays up to date. It reads the document through `lookup`,
 * which must always show the current state; after each change of that state,
 * `update` is told which records changed. Between updates it answers exactly
 * as a new Resolver over the same state would.
 */
export class LiveResolver extends Resolver {
  readonly #resolved = new Map<ElementId, Resolved>();
  /** Elements by stored parent, whether or not that parent exists. */
  readonly #storedChildren = new Map<ElementId, Set<ElementId>>();
  /** Elements by the space their stored position was written in. */
  readonly #spaceUsers = new Map<ElementId, Set<ElementId>>();
  readonly #listeners = new Set<(changes: ResolvedChanges) => void>();

  constructor(lookup: ElementLookup) {
    super(lookup);
    this.indexChildren();
    for (const id of lookup.ids()) {
      if (!this.get(id)) continue;
      const resolved = this.#resolve(id);
      this.#resolved.set(id, resolved);
      this.#index(id, undefined, resolved);
    }
  }

  /**
   * Calls `listener` after every update that concerned at least one element.
   * Returns a function that stops it.
   */
  subscribe(listener: (changes: ResolvedChanges) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Takes in a change of the document. `touched` lists every element record
   * that changed, with the keys of the record that changed, or null if the
   * record as a whole was added, replaced or removed. Returns what changed for
   * those who draw, and tells the subscribers if anything did.
   */
  update(touched: ReadonlyMap<ElementId, ReadonlySet<string> | null>): ResolvedChanges {
    // `invalid`: what the Resolver may have cached wrongly, to be forgotten.
    // `dirty`: what may resolve differently, to be resolved again and compared
    // (it holds `invalid`).
    const invalid = new Set<ElementId>();
    const dirty = new Set<ElementId>();
    const content = new Set<ElementId>();
    const structure: ElementId[] = [];
    const deletes: ElementId[] = [];
    const revisions: ElementId[] = [];
    const moves: ElementId[] = [];
    const views: ElementId[] = [];
    for (const [id, keys] of touched) {
      invalid.add(id);
      dirty.add(id);
      if (keys === null) {
        structure.push(id);
        content.add(id);
        continue;
      }
      for (const key of keys) {
        const kind = KEY_KINDS.get(key);
        if (kind === "structure") structure.push(id);
        else if (kind === "deleted") deletes.push(id);
        else if (kind === "rev") revisions.push(id);
        else if (kind === "position") moves.push(id);
        else if (kind === "view") views.push(id);
        if (kind !== "deleted" && kind !== "rev") content.add(id);
      }
    }
    // A new revision matters to what is inside only if it changes which
    // deletes hide the element (recording work after every local change makes
    // this the common case: nothing to do beyond the element itself).
    if (revisions.length > 0) {
      this.forget(new Set(revisions));
      for (const id of revisions) {
        if (!this.get(id) || this.#deletersKey(id) !== this.#resolved.get(id)?.deleters)
          deletes.push(id);
      }
    }
    // Parent or type changed, or the record came or went: the effective parent
    // of everything below by stored parent may change (whether that parent
    // exists or not; cycles follow stored parents too), and with it anything
    // cached about them. A position written in one of them (rule 3 of section
    // 5.3) may convert differently. An element that joins a container is in the
    // set already: its parent changed.
    for (const id of this.#below(structure, (at) => this.#storedChildren.get(at))) {
      invalid.add(id);
      dirty.add(id);
      for (const user of this.#spaceUsers.get(id) ?? []) moves.push(user);
    }
    // Delete marks changed: which deletes hide what is inside may change.
    for (const id of this.#below(deletes, (at) => this.children(at))) {
      invalid.add(id);
      dirty.add(id);
    }
    // Position changed: everything inside is elsewhere in the world, and a
    // position converted through this container (rule 3) changes. Only the
    // element's own cached position depends on its record; a converted one
    // depends on the container positions on its way, so elements that may be
    // converted are forgotten (inside: their parent's chain passes here; and
    // with a position written in a container in here).
    for (const id of moves) invalid.add(id);
    for (const id of this.#below(moves, (at) => this.children(at))) {
      dirty.add(id);
      if (this.#mayConvert(id)) invalid.add(id);
      for (const user of this.#spaceUsers.get(id) ?? []) {
        if (!this.#mayConvert(user)) continue;
        invalid.add(user);
        for (const inside of this.#below([user], (at) => this.children(at)))
          dirty.add(inside);
      }
    }
    // Gone or locked changed: what is inside sees other logical parents and
    // locks, and groups other bounds; nothing cached about it changes.
    for (const id of this.#below(views, (at) => this.children(at))) dirty.add(id);
    // Groups and gone containers above take their bounds from what is inside:
    // those above anything that changed, as the tree was.
    for (const id of [...dirty])
      this.#addBoundsHolders(id, dirty, (at) => this.#resolved.get(at));

    this.forget(invalid);

    const now = new Map<ElementId, Resolved | undefined>();
    for (const id of dirty) now.set(id, this.get(id) ? this.#resolve(id) : undefined);
    // And as the tree is now.
    const holders: ElementId[] = [];
    for (const id of dirty) {
      this.#addBoundsHolders(id, dirty, (at) => {
        if (!now.has(at)) {
          holders.push(at);
          now.set(at, this.get(at) ? this.#resolve(at) : undefined);
        }
        return now.get(at);
      });
    }
    for (const id of holders) dirty.add(id);

    const added = new Set<ElementId>();
    const changed = new Set<ElementId>();
    const removed = new Set<ElementId>();
    const containers = new Set<ElementId | null>();
    let drawOrder = false;
    const resolvedBefore = (id: ElementId) => this.#resolved.get(id);
    const resolvedAfter = (id: ElementId) =>
      now.has(id) ? now.get(id) : this.#resolved.get(id);
    for (const id of dirty) {
      const before = this.#resolved.get(id);
      const after = now.get(id);
      if (!before && !after) continue;
      if (!before) added.add(id);
      else if (!after) removed.add(id);
      else if (content.has(id) || !sameResolved(before, after)) changed.add(id);
      if (
        before?.parent !== after?.parent ||
        before?.logicalParent !== after?.logicalParent ||
        before?.gone !== after?.gone ||
        before?.order !== after?.order
      ) {
        if (before) this.#addHolders(id, containers, resolvedBefore);
        if (after) this.#addHolders(id, containers, resolvedAfter);
      }
      if (before?.gone !== after?.gone) drawOrder = true;
    }
    for (const id of dirty) {
      const before = this.#resolved.get(id);
      const after = now.get(id);
      this.#index(id, before, after);
      if (after) this.#resolved.set(id, after);
      else this.#resolved.delete(id);
    }
    if (containers.size > 0) drawOrder = true;
    for (const container of containers) {
      if (container !== null && this.#resolved.has(container) && !added.has(container))
        changed.add(container);
    }
    const changes: ResolvedChanges = { added, changed, removed, containers, drawOrder };
    if (added.size + changed.size + removed.size + containers.size > 0) {
      for (const listener of [...this.#listeners]) listener(changes);
    }
    return changes;
  }

  /** The given elements and everything below them by `children`. */
  #below(
    from: readonly ElementId[],
    children: (id: ElementId) => Iterable<ElementId> | undefined,
  ): Set<ElementId> {
    const out = new Set<ElementId>();
    const stack = [...from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const child of children(id) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Whether the element's position may be converted from another space (rule 3
   * of section 5.3): only if it was not written in its parent's space.
   */
  #mayConvert(id: ElementId): boolean {
    const resolved = this.#resolved.get(id);
    return resolved !== undefined && resolved.space !== resolved.parent;
  }

  #deletersKey(id: ElementId): string {
    return this.deleters(id)
      .map((d) => `${d.root} ${d.action}`)
      .join(",");
  }

  /**
   * Adds the containers whose children or logical children list `id`: its
   * parent, and the containers above up to the first that is not gone (gone
   * containers are transparent, section 5.5), or the root.
   */
  #addHolders(
    id: ElementId,
    containers: Set<ElementId | null>,
    resolved: (id: ElementId) => Resolved | undefined,
  ): void {
    let at = resolved(id)?.parent ?? null;
    for (;;) {
      containers.add(at);
      if (at === null) return;
      const holder = resolved(at);
      if (!holder?.gone) return;
      at = holder.parent;
    }
  }

  /**
   * Adds to `dirty` the groups and gone containers whose bounds depend on `id`:
   * the ancestors up to the first one that is neither.
   */
  #addBoundsHolders(
    id: ElementId,
    dirty: Set<ElementId>,
    resolved: (id: ElementId) => Resolved | undefined,
  ): void {
    for (let at = resolved(id)?.parent ?? null; at !== null;) {
      const holder = resolved(at);
      if (!holder?.derived) return;
      dirty.add(at);
      at = holder.parent;
    }
  }

  #index(id: ElementId, before: Resolved | undefined, after: Resolved | undefined): void {
    if (before?.storedParent !== after?.storedParent) {
      if (before?.storedParent) removeFrom(this.#storedChildren, before.storedParent, id);
      if (after?.storedParent) addTo(this.#storedChildren, after.storedParent, id);
    }
    if (before?.space !== after?.space) {
      if (before?.space) removeFrom(this.#spaceUsers, before.space, id);
      if (after?.space) addTo(this.#spaceUsers, after.space, id);
    }
  }

  #resolve(id: ElementId): Resolved {
    const element = this.get(id)!;
    const gone = this.isGone(id);
    const derived = element.type === GROUP_TYPE || (gone && this.isContainer(id));
    return {
      type: element.type,
      storedParent: element.parent,
      space: element.pos.space,
      parent: this.parentOf(id),
      logicalParent: this.logicalParentOf(id),
      order: element.order,
      local: this.localPosition(id),
      world: this.worldOrigin(id),
      w: element.size?.w ?? -1,
      h: element.size?.h ?? -1,
      rot: element.rot ?? 0,
      deleted: this.isDeleted(id),
      deleters: this.#deletersKey(id),
      gone,
      locked: this.isLocked(id),
      derived,
      bounds: derived ? this.bounds(id) : null,
    };
  }
}
