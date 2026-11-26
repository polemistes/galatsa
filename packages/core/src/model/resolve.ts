// SPDX-License-Identifier: GPL-3.0-or-later

// Resolution: the pure function from the raw, merged document state to what is
// shown. Concurrent edits can leave states that no single editor wrote: parent
// cycles, parents that no longer exist, positions written in another space,
// children of dissolved groups. Every replica resolves them the same way, without
// writing anything, so all replicas show the same picture. Section 5 of
// docs/adr/0001-document-model-and-file-format.md.

import { rotatedBounds, unionRect } from "./geometry.ts";
import { compareOrdered } from "./order.ts";
import {
  FRAME_TYPE,
  GROUP_TYPE,
  type Element,
  type ElementId,
  type OrderKey,
  type Position,
  type Rect,
  type Removal,
  type Size,
} from "./types.ts";

/** The fields of an element that resolution needs. Every Element satisfies it. */
export interface ElementEnvelope {
  readonly type: string;
  readonly parent: ElementId | null;
  readonly order: OrderKey;
  readonly pos: Position;
  readonly locked: boolean;
  readonly removed: Removal | null;
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

function isContainerType(type: string): boolean {
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
  readonly #world = new Map<ElementId, Point>();
  readonly #rawWorld = new Map<ElementId, Point>();

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

  /** The stored parent if it exists and is a container; otherwise null. */
  #validParent(id: ElementId): ElementId | null {
    const parent = this.#lookup.get(id)?.parent ?? null;
    if (parent === null) return null;
    const element = this.#lookup.get(parent);
    return element && isContainerType(element.type) ? parent : null;
  }

  /**
   * Effective parents (section 5.1): a missing or non-container parent means the
   * root, and each parent cycle is broken at the member with the smallest id,
   * which is moved to the root. The result does not depend on iteration order.
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

  /** Nearest effective ancestor that is not dissolved: the parent the user sees. */
  logicalParentOf(id: ElementId): ElementId | null {
    let parent = this.parentOf(id);
    while (parent !== null && this.#lookup.get(parent)?.removed === "dissolve") {
      parent = this.parentOf(parent);
    }
    return parent;
  }

  /** True if `id` is `ancestor` or lies inside it. */
  isWithin(id: ElementId, ancestor: ElementId): boolean {
    for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) {
      if (at === ancestor) return true;
    }
    return false;
  }

  /** Children in the effective tree, back to front, removed ones included. */
  children(parent: ElementId | null): readonly ElementId[] {
    return this.#children.get(parent) ?? [];
  }

  /** World position of a container's origin, ignoring position tags. */
  #rawWorldOrigin(id: ElementId | null): Point {
    if (id === null) return { x: 0, y: 0 };
    const cached = this.#rawWorld.get(id);
    if (cached) return cached;
    const base = this.#rawWorldOrigin(this.parentOf(id));
    const pos = this.#lookup.get(id)?.pos;
    const point = { x: base.x + (pos?.x ?? 0), y: base.y + (pos?.y ?? 0) };
    this.#rawWorld.set(id, point);
    return point;
  }

  /**
   * Position in the effective parent's space (section 5.3). A position written in
   * another space is converted through world coordinates, using the stored
   * positions of that space's ancestors as they are. If the space is gone, is not
   * a container, or lies inside the element itself, x and y are used as they are.
   */
  localPosition(id: ElementId): Point {
    const element = this.#lookup.get(id);
    if (!element) return { x: 0, y: 0 };
    const { x, y, space } = element.pos;
    const parent = this.parentOf(id);
    if (space === parent) return { x, y };
    if (space !== null) {
      const spaceElement = this.#lookup.get(space);
      if (
        !spaceElement ||
        !isContainerType(spaceElement.type) ||
        this.isWithin(space, id)
      ) {
        return { x, y };
      }
    }
    const from = this.#rawWorldOrigin(space);
    const to = this.#rawWorldOrigin(parent);
    return { x: from.x + x - to.x, y: from.y + y - to.y };
  }

  /** World position of the element's origin (top-left corner before rotation). */
  worldOrigin(id: ElementId): Point {
    const cached = this.#world.get(id);
    if (cached) return cached;
    const base = this.spaceOrigin(this.parentOf(id));
    const local = this.localPosition(id);
    const point = { x: base.x + local.x, y: base.y + local.y };
    this.#world.set(id, point);
    return point;
  }

  /** World position of a container's local origin; (0, 0) for the root. */
  spaceOrigin(space: ElementId | null): Point {
    return space === null ? { x: 0, y: 0 } : this.worldOrigin(space);
  }

  /** Removed with "delete", or inside something that is. */
  isDeleted(id: ElementId): boolean {
    for (let at: ElementId | null = id; at !== null; at = this.parentOf(at)) {
      if (this.#lookup.get(at)?.removed === "delete") return true;
    }
    return false;
  }

  /** Locked, or inside a locked container the user still sees (not dissolved). */
  isLocked(id: ElementId): boolean {
    if (this.#lookup.get(id)?.locked) return true;
    for (let at = this.logicalParentOf(id); at !== null; at = this.logicalParentOf(at)) {
      if (this.#lookup.get(at)?.locked) return true;
    }
    return false;
  }

  /**
   * Elements to draw, back to front (section 4.2). A container's subtree is drawn
   * in the container's slot among its siblings. Deleted subtrees are skipped;
   * dissolved containers are not drawn, but their children are, in their slot.
   */
  drawOrder(): ElementId[] {
    const out: ElementId[] = [];
    const visit = (parent: ElementId | null): void => {
      for (const id of this.children(parent)) {
        const element = this.#lookup.get(id);
        if (!element || element.removed === "delete") continue;
        if (element.removed !== "dissolve") out.push(id);
        if (isContainerType(element.type)) visit(id);
      }
    };
    visit(null);
    return out;
  }

  /**
   * World bounds: the rotated box for sized elements, the union of the children
   * for groups (null when empty). Deleted elements have no bounds.
   */
  bounds(id: ElementId): Rect | null {
    const element = this.#lookup.get(id);
    if (!element || this.isDeleted(id)) return null;
    if (element.type === GROUP_TYPE || element.removed === "dissolve") {
      let result: Rect | null = null;
      for (const child of this.children(id)) {
        const b = this.bounds(child);
        if (b) result = result ? unionRect(result, b) : b;
      }
      return result;
    }
    const origin = this.worldOrigin(id);
    const size = element.size ?? { w: 0, h: 0 };
    return rotatedBounds(
      { x: origin.x, y: origin.y, w: size.w, h: size.h },
      element.rot ?? 0,
    );
  }
}
