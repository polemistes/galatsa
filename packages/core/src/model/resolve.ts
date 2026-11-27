// SPDX-License-Identifier: GPL-3.0-or-later

// Resolution: the pure function from the raw, merged document state to what is
// shown. Concurrent edits can leave states that no single editor wrote: parent
// cycles, parents that no longer exist, positions written in another space,
// children of deleted or dissolved containers. Every replica resolves them the
// same way, without writing anything, so all replicas show the same picture.
// Section 5 of docs/adr/0001-document-model-and-file-format.md.

import { rotatedBounds, unionRect } from "./geometry.ts";
import { compareOrdered } from "./order.ts";
import { revisionDigest } from "./digest.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  type DeleteMarks,
  type Element,
  type ElementId,
  type OrderKey,
  type Position,
  type Rebase,
  type Rect,
  type Revision,
  type Size,
} from "./types.ts";

/** The fields of an element that resolution needs. Every Element satisfies it. */
export interface ElementEnvelope {
  readonly type: string;
  readonly parent: ElementId | null;
  readonly order: OrderKey;
  readonly pos: Position;
  readonly rebase?: Rebase | null;
  readonly locked: boolean;
  readonly rev?: Revision;
  readonly deleted?: DeleteMarks;
  readonly dissolved?: boolean;
  readonly purged?: boolean;
  readonly size?: Size | undefined;
  readonly rot?: number | undefined;
}

/** Read access to elements, implemented over snapshots and over a Y.Doc. */
export interface ElementLookup {
  get(id: ElementId): ElementEnvelope | undefined;
  ids(): Iterable<ElementId>;
}

/** Lookup over the `elements` record of a snapshot. */
export function lookupFromRecord(elements: {
  readonly [id: ElementId]: Element;
}): ElementLookup {
  return {
    get: (id) => (Object.hasOwn(elements, id) ? elements[id] : undefined),
    ids: () => Object.keys(elements),
  };
}

export interface Point {
  x: number;
  y: number;
}

export function isContainerType(type: string): boolean {
  return type === FRAME_TYPE || type === GROUP_TYPE;
}

/** One delete that hides an element: the action, and the element it is stored on. */
export interface Deleter {
  root: ElementId;
  action: string;
}

const NO_DELETERS: readonly Deleter[] = [];

/** Steps a walk up the tree takes before it starts to look for a loop. */
const LOOP_CHECK = 256;

/**
 * Watches one walk up the tree. Parents as resolved never form a loop, but a
 * Resolver whose cache is kept up to date (the live resolver) could hold an
 * inconsistent cache after a defect; this turns a walk that would never end
 * into a detected loop. Costs nothing for the first steps.
 */
class Ascent {
  #steps = 0;
  #seen: Set<ElementId> | null = null;

  /** True if the walk reached `id` before. */
  again(id: ElementId): boolean {
    if (++this.#steps <= LOOP_CHECK) return false;
    this.#seen ??= new Set();
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    return false;
  }
}

const LOOPED: unique symbol = Symbol("looped");
const NO_CHILDREN: readonly ElementId[] = [];
const NO_REVISION: Revision = {};

/** A lookup that does not see the given delete marks ("root action" keys). */
export function withoutMarks(
  lookup: ElementLookup,
  ignored: ReadonlySet<string>,
): ElementLookup {
  if (ignored.size === 0) return lookup;
  return {
    ids: () => lookup.ids(),
    get(id) {
      const element = lookup.get(id);
      if (!element?.deleted) return element;
      const actions = Object.keys(element.deleted);
      if (!actions.some((action) => ignored.has(`${id} ${action}`))) return element;
      const deleted: DeleteMarks = {};
      for (const action of actions) {
        if (!ignored.has(`${id} ${action}`)) deleted[action] = element.deleted[action]!;
      }
      // Copied key by key: an envelope may compute its keys when asked.
      return {
        type: element.type,
        parent: element.parent,
        order: element.order,
        pos: element.pos,
        rebase: element.rebase ?? null,
        locked: element.locked,
        rev: element.rev ?? NO_REVISION,
        deleted,
        dissolved: element.dissolved === true,
        purged: element.purged === true,
        size: element.size,
        rot: element.rot,
      };
    },
  };
}

/**
 * Resolves one state of the document. Results are cached, so create a new
 * Resolver after the document changes (or use the live resolver, which is kept
 * up to date). Everything is computed on demand: asking about one element reads
 * only that element and the containers above it, unless the question is about
 * children.
 */
export class Resolver {
  readonly #lookup: ElementLookup;
  readonly #envelope = new Map<ElementId, ElementEnvelope | undefined>();
  readonly #parent = new Map<ElementId, ElementId | null>();
  readonly #children = new Map<ElementId | null, ElementId[]>();
  /** True once every container's children are in `#children`. */
  #indexed = false;
  #asked = 0;
  readonly #local = new Map<ElementId, Point>();
  readonly #simpleLocal = new Map<ElementId, Point>();
  readonly #deleters = new Map<ElementId, readonly Deleter[]>();
  readonly #digest = new Map<ElementId, string>();

  constructor(lookup: ElementLookup) {
    this.#lookup = lookup;
  }

  get(id: ElementId): ElementEnvelope | undefined {
    if (this.#envelope.has(id)) return this.#envelope.get(id);
    const envelope = this.#lookup.get(id);
    this.#envelope.set(id, envelope);
    return envelope;
  }

  ids(): Iterable<ElementId> {
    return this.#lookup.ids();
  }

  isContainer(id: ElementId | null): boolean {
    if (id === null) return true;
    const element = this.get(id);
    return element !== undefined && isContainerType(element.type);
  }

  // -------------------------------------------------------------------------
  // The effective tree (section 5.1)
  // -------------------------------------------------------------------------

  /** The stored parent if it exists and is a container; otherwise null. */
  #validParent(id: ElementId): ElementId | null {
    const parent = this.get(id)?.parent ?? null;
    if (parent === null) return null;
    const element = this.get(parent);
    return element && isContainerType(element.type) ? parent : null;
  }

  /**
   * Effective parent: the container whose space the element is in. A missing or
   * non-container parent means the root, and each parent cycle is broken at the
   * member with the smallest id, which is moved to the root. The result does not
   * depend on the order in which elements are asked about.
   */
  parentOf(id: ElementId): ElementId | null {
    const known = this.#parent.get(id);
    if (known !== undefined) return known;
    if (!this.get(id)) return null;
    const path: ElementId[] = [];
    const onPath = new Map<ElementId, number>();
    let current: ElementId | null = id;
    while (current !== null && !this.#parent.has(current)) {
      const seenAt = onPath.get(current);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt);
        const breaker = cycle.reduce((min, member) => (member < min ? member : min));
        for (const member of cycle) {
          this.#parent.set(member, member === breaker ? null : this.#validParent(member));
        }
        break;
      }
      onPath.set(current, path.length);
      path.push(current);
      current = this.#validParent(current);
    }
    for (const member of path) {
      if (!this.#parent.has(member)) this.#parent.set(member, this.#validParent(member));
    }
    return this.#parent.get(id) ?? null;
  }

  /** True if `id` is `ancestor` or lies inside it (effective tree). */
  isWithin(id: ElementId | null, ancestor: ElementId): boolean {
    return this.#ascend((ascent) => {
      for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) {
        if (ascent.again(at)) return LOOPED;
        if (at === ancestor) return true;
      }
      return false;
    });
  }

  /**
   * Runs a walk up the tree. If it finds a loop (only an inconsistent cache can
   * make one), `cacheLoop` is told, and the walk runs once more.
   */
  #ascend<T>(walk: (ascent: Ascent) => T | typeof LOOPED): T {
    const first = walk(new Ascent());
    if (first !== LOOPED) return first;
    this.cacheLoop();
    const second = walk(new Ascent());
    if (second === LOOPED) throw new Error("The resolved parents form a loop");
    return second;
  }

  /**
   * Called when a walk up the tree found a loop in the cached parents. A
   * Resolver that is never updated cannot have one, so this throws; the live
   * resolver drops its cache instead and resolves again.
   */
  protected cacheLoop(): void {
    throw new Error("The resolved parents form a loop");
  }

  /** Drops everything cached, as if the Resolver were new. */
  protected reset(): void {
    this.#envelope.clear();
    this.#parent.clear();
    this.#children.clear();
    this.#indexed = false;
    this.#asked = 0;
    this.#local.clear();
    this.#simpleLocal.clear();
    this.#deleters.clear();
    this.#digest.clear();
  }

  #sortSiblings(list: ElementId[]): ElementId[] {
    return list.sort((a, b) =>
      compareOrdered(
        { id: a, order: this.get(a)?.order ?? "" },
        { id: b, order: this.get(b)?.order ?? "" },
      ),
    );
  }

  /** Children in the effective tree, back to front, removed ones included. */
  children(parent: ElementId | null): readonly ElementId[] {
    const known = this.#children.get(parent);
    if (known) return known;
    if (this.#indexed) return NO_CHILDREN;
    if (this.#asked++ < 2) {
      // One or two containers: look only for their children. An element is in
      // a container only if its stored parent says so.
      const list: ElementId[] = [];
      for (const id of this.#lookup.ids()) {
        const element = this.get(id);
        if (!element || (parent !== null && element.parent !== parent)) continue;
        if (this.parentOf(id) === parent) list.push(id);
      }
      this.#children.set(parent, this.#sortSiblings(list));
      return list;
    }
    this.indexChildren();
    return this.#children.get(parent) ?? NO_CHILDREN;
  }

  /**
   * Builds the children of every container at once (and with it the effective
   * parent of every element). `children` does this by itself when asked about a
   * third container.
   */
  protected indexChildren(): void {
    if (this.#indexed) return;
    const index = new Map<ElementId | null, ElementId[]>();
    for (const id of this.#lookup.ids()) {
      if (!this.get(id)) continue;
      const key = this.parentOf(id);
      let list = index.get(key);
      if (!list) index.set(key, (list = []));
      list.push(id);
    }
    this.#children.clear();
    for (const [key, list] of index) this.#children.set(key, this.#sortSiblings(list));
    this.#indexed = true;
  }

  /**
   * Drops everything cached about the given elements after the lookup's content
   * changed, so that the next question reads them again. Only for a subclass that
   * keeps one Resolver up to date (the live resolver): `ids` must hold every
   * element whose resolution can differ from what is cached, which takes knowing
   * what depends on what. Everybody else creates a new Resolver.
   *
   * With a full children index, the index is updated (each list that changes is
   * replaced, never changed in place, so a list handed out earlier stays as it
   * was); without one, children are looked up anew.
   */
  protected forget(forgotten: ReadonlySet<ElementId>): void {
    const ids = new Set(forgotten);
    const touched = new Set<ElementId | null>();
    const drop = (id: ElementId) => {
      const parent = this.#parent.get(id);
      if (parent !== undefined) touched.add(parent);
      this.#envelope.delete(id);
      this.#parent.delete(id);
      this.#local.delete(id);
      this.#simpleLocal.delete(id);
      this.#deleters.delete(id);
      this.#digest.delete(id);
    };
    const breakers: ElementId[] = [];
    for (const id of ids) {
      if (this.#parent.get(id) === null) breakers.push(id);
      drop(id);
    }
    // A parent cycle is resolved as a whole: the member that breaks it, asked
    // about alone, would get its stored parent. So the other members of a cycle
    // broken at an element in the set are forgotten with it.
    for (const id of breakers) {
      const members: ElementId[] = [];
      const seen = new Set<ElementId>([id]);
      let at = this.#validParent(id);
      while (at !== null && !seen.has(at)) {
        seen.add(at);
        members.push(at);
        at = this.#validParent(at);
      }
      if (at !== id) continue;
      for (const member of members) {
        if (ids.has(member)) continue;
        ids.add(member);
        drop(member);
      }
    }
    if (!this.#indexed) {
      this.#children.clear();
      this.#asked = 0;
      return;
    }
    const lists = new Map<ElementId | null, ElementId[]>();
    for (const parent of touched) {
      const list = this.#children.get(parent);
      if (list)
        lists.set(
          parent,
          list.filter((id) => !ids.has(id)),
        );
    }
    const added = new Map<ElementId | null, ElementId[]>();
    for (const id of ids) {
      if (!this.get(id)) continue;
      const parent = this.parentOf(id);
      let list = added.get(parent);
      if (!list) added.set(parent, (list = []));
      list.push(id);
    }
    const key = (id: ElementId) => ({ id, order: this.get(id)?.order ?? "" });
    for (const [parent, newcomers] of added) {
      let list = lists.get(parent);
      if (!list) lists.set(parent, (list = [...(this.#children.get(parent) ?? [])]));
      if (newcomers.length > 8) {
        list.push(...newcomers);
        this.#sortSiblings(list);
        continue;
      }
      for (const id of newcomers) {
        const item = key(id);
        let low = 0;
        let high = list.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compareOrdered(key(list[mid]!), item) < 0) low = mid + 1;
          else high = mid;
        }
        list.splice(low, 0, id);
      }
    }
    for (const [parent, list] of lists) {
      if (list.length > 0) this.#children.set(parent, list);
      else this.#children.delete(parent);
    }
  }

  /**
   * Walks the effective tree below `root` in drawing order without recursion.
   * `enter` is called for each element and says whether to go into it.
   */
  #walk(root: ElementId | null, enter: (id: ElementId) => boolean): void {
    const stack = [...this.children(root)].reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (!enter(id)) continue;
      const children = this.children(id);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }

  /** Everything inside `id` in the effective tree, in drawing order. */
  descendants(id: ElementId): ElementId[] {
    const out: ElementId[] = [];
    this.#walk(id, (child) => {
      out.push(child);
      return true;
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Removal (section 5.5)
  // -------------------------------------------------------------------------

  /**
   * The deletes that hide an element. A delete stored on element R hides element
   * E while E and every container between E and R (R included) still have
   * exactly the revision the delete lists for them. So work on E, or on anything
   * E is inside up to the deleted element, done without knowing about the delete,
   * keeps E; and anything the delete does not list (it was added or moved in
   * meanwhile) is never hidden by it.
   */
  deleters(id: ElementId): readonly Deleter[] {
    const chain = this.#ascend((ascent) => {
      const out: ElementId[] = [];
      for (
        let at: ElementId | null = id;
        at !== null && !this.#deleters.has(at);
        at = this.parentOf(at)
      ) {
        if (ascent.again(at)) return LOOPED;
        out.push(at);
      }
      return out;
    });
    for (let i = chain.length - 1; i >= 0; i--) {
      this.#deleters.set(chain[i]!, this.#computeDeleters(chain[i]!));
    }
    return this.#deleters.get(id) ?? NO_DELETERS;
  }

  /** The digest of the element's current revision (what marks list). */
  digestOf(id: ElementId): string {
    let digest = this.#digest.get(id);
    if (digest === undefined) {
      digest = revisionDigest(this.get(id)?.rev);
      this.#digest.set(id, digest);
    }
    return digest;
  }

  #computeDeleters(id: ElementId): readonly Deleter[] {
    const element = this.get(id);
    if (!element) return NO_DELETERS;
    let out: Deleter[] | null = null;
    const marks = element.deleted;
    if (marks) {
      for (const action of Object.keys(marks)) {
        const seen = marks[action]!.seen;
        if (Object.hasOwn(seen, id) && seen[id] === this.digestOf(id)) {
          (out ??= []).push({ root: id, action });
        }
      }
    }
    const parent = this.parentOf(id);
    if (parent !== null) {
      for (const deleter of this.#deleters.get(parent) ?? NO_DELETERS) {
        const seen = this.get(deleter.root)?.deleted?.[deleter.action]?.seen;
        if (seen && Object.hasOwn(seen, id) && seen[id] === this.digestOf(id)) {
          (out ??= []).push(deleter);
        }
      }
    }
    return out ?? NO_DELETERS;
  }

  /**
   * What a delete of `id` made now lists: the element and everything inside it,
   * each with the digest of its current revision. If the element is already
   * gone, the visible elements inside it are not part of it for the user (they
   * survived an earlier removal), so they and what is inside them are left out.
   */
  coverage(id: ElementId): { [id: ElementId]: string } {
    const seen: { [id: ElementId]: string } = {};
    const list = (element: ElementId) => {
      Object.defineProperty(seen, element, {
        value: this.digestOf(element),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    if (!this.get(id)) return seen;
    list(id);
    const gone = this.isGone(id);
    this.#walk(id, (child) => {
      if (gone && !this.isGone(child)) return false;
      list(child);
      return true;
    });
    return seen;
  }

  /** Deleted: hidden by at least one delete (see `deleters`). */
  isDeleted(id: ElementId): boolean {
    return this.deleters(id).length > 0;
  }

  /** A container that was ungrouped or removed with "keep contents". */
  isDissolved(id: ElementId): boolean {
    const element = this.get(id);
    return (
      element !== undefined && element.dissolved === true && isContainerType(element.type)
    );
  }

  /** A place marker: a removed container that tidy up emptied (section 5.8). */
  isPurged(id: ElementId): boolean {
    const element = this.get(id);
    return (
      element !== undefined && element.purged === true && isContainerType(element.type)
    );
  }

  /**
   * Gone: deleted, dissolved, or a place marker. A gone element is not drawn and
   * cannot be selected. A gone container is transparent: it keeps its position
   * and its slot in the z-order for any children that are not gone themselves.
   */
  isGone(id: ElementId): boolean {
    return this.isPurged(id) || this.isDissolved(id) || this.isDeleted(id);
  }

  /** Nearest effective ancestor that is not gone: the parent the user sees. */
  logicalParentOf(id: ElementId): ElementId | null {
    return this.#ascend((ascent) => {
      let parent = this.parentOf(id);
      while (parent !== null && this.isGone(parent)) {
        if (ascent.again(parent)) return LOOPED;
        parent = this.parentOf(parent);
      }
      return parent;
    });
  }

  /**
   * Children the user sees in a container (or the root), back to front: gone
   * containers are replaced by their own visible children, in their slot.
   */
  logicalChildren(parent: ElementId | null): ElementId[] {
    const out: ElementId[] = [];
    this.#walk(parent, (id) => {
      if (this.isGone(id)) return this.isContainer(id);
      out.push(id);
      return false;
    });
    return out;
  }

  /**
   * The direct child of `ancestor` (effective tree) that contains `id`, or `id`
   * itself if it is a direct child. Undefined if `id` is not inside `ancestor`.
   */
  slotIn(id: ElementId, ancestor: ElementId | null): ElementId | undefined {
    return this.#ascend((ascent) => {
      let at: ElementId | null = id;
      while (at !== null) {
        if (ascent.again(at)) return LOOPED;
        const parent = this.parentOf(at);
        if (parent === ancestor) return at;
        at = parent;
      }
      return undefined;
    });
  }

  /** Locked, or inside a locked container the user still sees (not gone). */
  isLocked(id: ElementId): boolean {
    if (this.get(id)?.locked) return true;
    return this.#ascend((ascent) => {
      for (
        let at = this.logicalParentOf(id);
        at !== null;
        at = this.logicalParentOf(at)
      ) {
        if (ascent.again(at)) return LOOPED;
        if (this.get(at)?.locked) return true;
      }
      return false;
    });
  }

  /**
   * Elements to draw, back to front (section 4.2). A container's subtree is drawn
   * in the container's slot among its siblings. Gone elements are not drawn; the
   * children of gone containers are, in the container's slot.
   */
  drawOrder(): ElementId[] {
    const out: ElementId[] = [];
    this.#walk(null, (id) => {
      if (!this.isGone(id)) out.push(id);
      return this.isContainer(id);
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Positions (section 5.3) and precision (section 7)
  // -------------------------------------------------------------------------

  /**
   * Local position from the element's own record (rules 1 and 2 of section 5.3),
   * or null if neither applies.
   */
  #ownLocal(id: ElementId): Point | null {
    const element = this.get(id);
    if (!element) return null;
    const { x, y, space } = element.pos;
    const parent = this.parentOf(id);
    const rebase = element.rebase;
    if (rebase && rebase.to === parent) {
      if (space === parent) {
        const base = rebase.base;
        if (base && base.x === x && base.y === y)
          return { x: x + base.dx, y: y + base.dy };
        return { x, y };
      }
      const shift = rebase.shifts.find((s) => s.from === space);
      return shift ? { x: x + shift.dx, y: y + shift.dy } : null;
    }
    return space === parent ? { x, y } : null;
  }

  /** Own local position, or the raw stored numbers (used only by rule 3). */
  #simple(id: ElementId): Point {
    const cached = this.#simpleLocal.get(id);
    if (cached) return cached;
    const pos = this.get(id)?.pos;
    const point = this.#ownLocal(id) ?? { x: pos?.x ?? 0, y: pos?.y ?? 0 };
    this.#simpleLocal.set(id, point);
    return point;
  }

  /**
   * Position in the effective parent's space (section 5.3):
   * 1. written in the parent's space: as stored (shifted by the rebase base if the
   *    stored position is exactly the one the rebase was made for);
   * 2. written in a space the rebase has a shift for: shifted;
   * 3. otherwise (only after conflicting concurrent writes, or a broken cycle):
   *    converted from `space` to the parent with container offsets computed by
   *    rules 1 and 2 alone; x and y as they are if `space` is gone from the
   *    document, not a container, or inside the element.
   */
  localPosition(id: ElementId): Point {
    const cached = this.#local.get(id);
    if (cached) return cached;
    const element = this.get(id);
    let point: Point;
    if (!element) point = { x: 0, y: 0 };
    else {
      point = this.#ownLocal(id) ?? this.#rule3(id, element.pos);
    }
    this.#local.set(id, point);
    return point;
  }

  #rule3(id: ElementId, pos: Position): Point {
    const { x, y, space } = pos;
    if (space !== null && (!this.isContainer(space) || this.isWithin(space, id)))
      return { x, y };
    const d = this.#offsetWith(space, this.parentOf(id), (n) => this.#simple(n));
    return { x: x + d.x, y: y + d.y };
  }

  /** Effective ancestors from `id` (inclusive) to the root, root as null last. */
  #chain(id: ElementId | null): (ElementId | null)[] {
    return this.#ascend((ascent) => {
      const out: (ElementId | null)[] = [];
      for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) {
        if (ascent.again(at)) return LOOPED;
        out.push(at);
      }
      out.push(null);
      return out;
    });
  }

  #offsetWith(
    from: ElementId | null,
    to: ElementId | null,
    local: (id: ElementId) => Point,
  ): Point {
    if (from === to) return { x: 0, y: 0 };
    const a = this.#chain(from);
    const b = this.#chain(to);
    const inB = new Set(b);
    const lca = a.find((n) => inB.has(n)) ?? null;
    // Sum from the deepest container upwards: small numbers first.
    const sum = (path: (ElementId | null)[]): Point => {
      let x = 0;
      let y = 0;
      for (const n of path) {
        if (n === lca) break;
        const p = local(n as ElementId);
        x += p.x;
        y += p.y;
      }
      return { x, y };
    };
    const sa = sum(a);
    const sb = sum(b);
    return { x: sa.x - sb.x, y: sa.y - sb.y };
  }

  /**
   * Offset from the origin of space `to` to the origin of space `from`: a point at
   * p in `from` is at p + offset in `to`. Computed through the lowest common
   * ancestor, so it stays precise far from the world origin (section 7.3).
   */
  offset(from: ElementId | null, to: ElementId | null): Point {
    return this.#offsetWith(from, to, (n) => this.localPosition(n));
  }

  /** The element's origin (top-left corner before rotation) in the space `space`. */
  positionIn(id: ElementId, space: ElementId | null): Point {
    const local = this.localPosition(id);
    const d = this.offset(this.parentOf(id), space);
    return { x: local.x + d.x, y: local.y + d.y };
  }

  /** World position of the element's origin. Loses precision far from the origin. */
  worldOrigin(id: ElementId): Point {
    return this.positionIn(id, null);
  }

  /** World position of a container's local origin; (0, 0) for the root. */
  spaceOrigin(space: ElementId | null): Point {
    return space === null ? { x: 0, y: 0 } : this.worldOrigin(space);
  }

  /**
   * Bounds in the space `space`: the rotated box for sized elements, the union of
   * the visible descendants for groups and gone containers (null when empty).
   * Gone elements other than containers have no bounds.
   */
  boundsIn(id: ElementId, space: ElementId | null): Rect | null {
    if (!this.get(id)) return null;
    let result: Rect | null = null;
    const visit = (at: ElementId): boolean => {
      const element = this.get(at);
      if (!element) return false;
      const gone = this.isGone(at);
      if (element.type === GROUP_TYPE || (gone && this.isContainer(at))) return true;
      if (gone) return false;
      const origin = this.positionIn(at, space);
      const size = element.size ?? { w: 0, h: 0 };
      const box = rotatedBounds(
        { x: origin.x, y: origin.y, w: size.w, h: size.h },
        element.rot ?? 0,
      );
      result = result ? unionRect(result, box) : box;
      return false;
    };
    if (visit(id)) this.#walk(id, visit);
    return result;
  }

  /** World bounds; see boundsIn. */
  bounds(id: ElementId): Rect | null {
    return this.boundsIn(id, null);
  }
}
