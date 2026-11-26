// SPDX-License-Identifier: GPL-3.0-or-later

// Resolution: the pure function from the raw, merged document state to what is
// shown. Concurrent edits can leave states that no single editor wrote: parent
// cycles, parents that no longer exist, positions written in another space,
// children of deleted or dissolved containers. Every replica resolves them the
// same way, without writing anything, so all replicas show the same picture.
// Section 5 of docs/adr/0001-document-model-and-file-format.md.

import { rotatedBounds, unionRect } from "./geometry.ts";
import { compareOrdered } from "./order.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  type DeleteMark,
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
  readonly deleted?: DeleteMark | null;
  readonly dissolved?: boolean;
  readonly size?: Size;
  readonly rot?: number;
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

/**
 * Resolves one state of the document. Results are cached, so create a new
 * Resolver after the document changes.
 */
export class Resolver {
  readonly #lookup: ElementLookup;
  readonly #parent = new Map<ElementId, ElementId | null>();
  readonly #children = new Map<ElementId | null, ElementId[]>();
  readonly #local = new Map<ElementId, Point>();
  readonly #simpleLocal = new Map<ElementId, Point>();
  readonly #deleted = new Map<ElementId, boolean>();

  constructor(lookup: ElementLookup) {
    this.#lookup = lookup;
    this.#resolveParents();
    for (const id of lookup.ids()) {
      const parent = this.#parent.get(id) ?? null;
      let list = this.#children.get(parent);
      if (!list) this.#children.set(parent, (list = []));
      list.push(id);
    }
    for (const list of this.#children.values()) {
      list.sort((a, b) =>
        compareOrdered(
          { id: a, order: this.#lookup.get(a)?.order ?? "" },
          { id: b, order: this.#lookup.get(b)?.order ?? "" },
        ),
      );
    }
  }

  get(id: ElementId): ElementEnvelope | undefined {
    return this.#lookup.get(id);
  }

  ids(): Iterable<ElementId> {
    return this.#lookup.ids();
  }

  isContainer(id: ElementId | null): boolean {
    if (id === null) return true;
    const element = this.#lookup.get(id);
    return element !== undefined && isContainerType(element.type);
  }

  // -------------------------------------------------------------------------
  // The effective tree (section 5.1)
  // -------------------------------------------------------------------------

  /** The stored parent if it exists and is a container; otherwise null. */
  #validParent(id: ElementId): ElementId | null {
    const parent = this.#lookup.get(id)?.parent ?? null;
    if (parent === null) return null;
    const element = this.#lookup.get(parent);
    return element && isContainerType(element.type) ? parent : null;
  }

  /**
   * Effective parents: a missing or non-container parent means the root, and each
   * parent cycle is broken at the member with the smallest id, which is moved to
   * the root. The result does not depend on iteration order.
   */
  #resolveParents(): void {
    for (const start of this.#lookup.ids()) {
      if (this.#parent.has(start)) continue;
      const path: ElementId[] = [];
      const onPath = new Map<ElementId, number>();
      let current: ElementId | null = start;
      while (current !== null && !this.#parent.has(current)) {
        const seenAt = onPath.get(current);
        if (seenAt !== undefined) {
          const cycle = path.slice(seenAt);
          const breaker = cycle.reduce((min, id) => (id < min ? id : min));
          for (const id of cycle) {
            this.#parent.set(id, id === breaker ? null : this.#validParent(id));
          }
          break;
        }
        onPath.set(current, path.length);
        path.push(current);
        current = this.#validParent(current);
      }
      for (const id of path) {
        if (!this.#parent.has(id)) this.#parent.set(id, this.#validParent(id));
      }
    }
  }

  /** Effective parent: the container whose space the element is in. */
  parentOf(id: ElementId): ElementId | null {
    return this.#parent.get(id) ?? null;
  }

  /** True if `id` is `ancestor` or lies inside it (effective tree). */
  isWithin(id: ElementId | null, ancestor: ElementId): boolean {
    for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) {
      if (at === ancestor) return true;
    }
    return false;
  }

  /** Children in the effective tree, back to front, removed ones included. */
  children(parent: ElementId | null): readonly ElementId[] {
    return this.#children.get(parent) ?? [];
  }

  // -------------------------------------------------------------------------
  // Removal (section 5.5)
  // -------------------------------------------------------------------------

  /**
   * Deleted: the element carries a delete mark, its revision is unchanged since
   * the mark was written, and the delete is still in effect (its root carries the
   * same action with an unchanged revision and is not dissolved). Anything changed
   * concurrently with the delete, and anything added to a deleted container,
   * therefore survives.
   */
  isDeleted(id: ElementId): boolean {
    const cached = this.#deleted.get(id);
    if (cached !== undefined) return cached;
    const result = this.#computeDeleted(id);
    this.#deleted.set(id, result);
    return result;
  }

  #computeDeleted(id: ElementId): boolean {
    const element = this.#lookup.get(id);
    const mark = element?.deleted;
    if (!element || !mark || element.rev !== mark.rev) return false;
    const root = this.#lookup.get(mark.root);
    const rootMark = root?.deleted;
    if (!root || !rootMark || rootMark.action !== mark.action) return false;
    if (root.rev !== rootMark.rev) return false;
    return !(root.dissolved === true && isContainerType(root.type));
  }

  /** A container that was ungrouped or removed with "keep contents". */
  isDissolved(id: ElementId): boolean {
    const element = this.#lookup.get(id);
    return (
      element !== undefined && element.dissolved === true && isContainerType(element.type)
    );
  }

  /**
   * Gone: deleted or dissolved. A gone element is not drawn and cannot be
   * selected. A gone container is transparent: it keeps its position and its slot
   * in the z-order for any children that are not gone themselves.
   */
  isGone(id: ElementId): boolean {
    return this.isDeleted(id) || this.isDissolved(id);
  }

  /** Nearest effective ancestor that is not gone: the parent the user sees. */
  logicalParentOf(id: ElementId): ElementId | null {
    let parent = this.parentOf(id);
    while (parent !== null && this.isGone(parent)) parent = this.parentOf(parent);
    return parent;
  }

  /**
   * Children the user sees in a container (or the root), back to front: gone
   * containers are replaced by their own visible children, in their slot.
   */
  logicalChildren(parent: ElementId | null): ElementId[] {
    const out: ElementId[] = [];
    const visit = (at: ElementId | null): void => {
      for (const id of this.children(at)) {
        if (!this.isGone(id)) out.push(id);
        else if (this.isContainer(id)) visit(id);
      }
    };
    visit(parent);
    return out;
  }

  /**
   * The direct child of `ancestor` (effective tree) that contains `id`, or `id`
   * itself if it is a direct child. Undefined if `id` is not inside `ancestor`.
   */
  slotIn(id: ElementId, ancestor: ElementId | null): ElementId | undefined {
    let at: ElementId | null = id;
    while (at !== null) {
      const parent = this.parentOf(at);
      if (parent === ancestor) return at;
      at = parent;
    }
    return undefined;
  }

  /** Locked, or inside a locked container the user still sees (not gone). */
  isLocked(id: ElementId): boolean {
    if (this.#lookup.get(id)?.locked) return true;
    for (let at = this.logicalParentOf(id); at !== null; at = this.logicalParentOf(at)) {
      if (this.#lookup.get(at)?.locked) return true;
    }
    return false;
  }

  /**
   * Elements to draw, back to front (section 4.2). A container's subtree is drawn
   * in the container's slot among its siblings. Gone elements are not drawn; the
   * children of gone containers are, in the container's slot.
   */
  drawOrder(): ElementId[] {
    const out: ElementId[] = [];
    const visit = (parent: ElementId | null): void => {
      for (const id of this.children(parent)) {
        if (!this.isGone(id)) out.push(id);
        if (this.isContainer(id)) visit(id);
      }
    };
    visit(null);
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
    const element = this.#lookup.get(id);
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
    const pos = this.#lookup.get(id)?.pos;
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
    const element = this.#lookup.get(id);
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
    const out: (ElementId | null)[] = [];
    for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) out.push(at);
    out.push(null);
    return out;
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
    const element = this.#lookup.get(id);
    if (!element) return null;
    if (element.type === GROUP_TYPE || (this.isGone(id) && this.isContainer(id))) {
      let result: Rect | null = null;
      for (const child of this.children(id)) {
        const b = this.boundsIn(child, space);
        if (b) result = result ? unionRect(result, b) : b;
      }
      return result;
    }
    if (this.isGone(id)) return null;
    const origin = this.positionIn(id, space);
    const size = element.size ?? { w: 0, h: 0 };
    return rotatedBounds(
      { x: origin.x, y: origin.y, w: size.w, h: size.h },
      element.rot ?? 0,
    );
  }

  /** World bounds; see boundsIn. */
  bounds(id: ElementId): Rect | null {
    return this.boundsIn(id, null);
  }
}
