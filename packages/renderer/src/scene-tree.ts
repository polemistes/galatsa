// SPDX-License-Identifier: GPL-3.0-or-later

// The renderer's copy of what it needs from the document: one node per element,
// grouped by container, with the bounds of what each draws in its container's
// local space and a spatial index per container. It is kept up to date from sets
// of changed element ids, never from document events.
//
// Bounds are local to the container, so a container that moves changes only its
// own entry in its parent's index, and the numbers in each index stay small however
// far the container is from the world origin. Culling walks down the containers
// whose bounds meet the view, asking each for the view in its own space.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  unionRect,
  type ElementId,
  type Rect,
} from "@galatsa/core";
import type { SceneElement, SceneSource } from "./scene.ts";
import { SpatialIndex } from "./spatial.ts";

/** Containers with more children than this get a spatial index. */
const INDEX_THRESHOLD = 24;

export type NodeKind = "element" | "frame" | "group";

export interface SceneNode {
  readonly id: ElementId;
  readonly kind: NodeKind;
  /** Effective parent. */
  parent: ElementId | null;
  /** Position among the parent's children (drawing order). */
  rank: number;
  gone: boolean;
  record: SceneElement;
  /** Origin in the parent's space. */
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  /**
   * What the node draws in its parent's space (a container: with everything it
   * shows inside it). Null when it draws nothing.
   */
  bounds: Rect | null;
  /** Children, for containers. */
  container: Container | null;
}

export class Container {
  ids: ElementId[] = [];
  index: SpatialIndex<ElementId> | null = null;
}

/** How the tree learns the drawn area of an extension element. */
export type AreaFn = (node: SceneNode) => Rect;

function frameClips(record: SceneElement): boolean {
  return record.data["clip"] === true;
}

export class SceneTree {
  source: SceneSource;
  readonly nodes = new Map<ElementId, SceneNode>();
  readonly root = new Container();
  readonly #area: AreaFn;

  constructor(source: SceneSource, area: AreaFn) {
    this.source = source;
    this.#area = area;
    this.rebuild(source);
  }

  /** Reads everything again. */
  rebuild(source: SceneSource): void {
    this.source = source;
    this.nodes.clear();
    this.root.ids = [];
    this.root.index = null;
    this.#fillContainer(null, this.root);
  }

  container(id: ElementId | null): Container | null {
    return id === null ? this.root : (this.nodes.get(id)?.container ?? null);
  }

  /** Creates the nodes of a container's children (and below), then the container's index. */
  #fillContainer(id: ElementId | null, container: Container): void {
    const ids = [...this.source.children(id)];
    container.ids = ids;
    ids.forEach((child, rank) => {
      const node = this.#makeNode(child, id, rank);
      if (node?.container) this.#fillContainer(child, node.container);
      if (node) node.bounds = this.#bounds(node);
    });
    this.#reindex(container);
  }

  #makeNode(id: ElementId, parent: ElementId | null, rank: number): SceneNode | null {
    const record = this.source.element(id);
    if (!record) return null;
    const kind: NodeKind =
      record.type === FRAME_TYPE
        ? "frame"
        : record.type === GROUP_TYPE
          ? "group"
          : "element";
    const pos = this.source.localPosition(id);
    const node: SceneNode = {
      id,
      kind,
      parent,
      rank,
      gone: this.source.isGone(id),
      record,
      x: pos.x,
      y: pos.y,
      w: record.size?.w ?? 0,
      h: record.size?.h ?? 0,
      rot: kind === "element" ? (record.rot ?? 0) : 0,
      bounds: null,
      container: kind === "element" ? null : new Container(),
    };
    this.nodes.set(id, node);
    return node;
  }

  /** Bounds of a node in its parent's space, from its own fields and its children's bounds. */
  #bounds(node: SceneNode): Rect | null {
    if (node.kind === "element") {
      if (node.gone) return null;
      const area = this.#area(node);
      if (node.rot === 0)
        return { x: node.x + area.x, y: node.y + area.y, w: area.w, h: area.h };
      // The drawn area is in the local box, rotated about the box centre.
      const cx = node.w / 2;
      const cy = node.h / 2;
      const cos = Math.cos(node.rot);
      const sin = Math.sin(node.rot);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of [
        [area.x, area.y],
        [area.x + area.w, area.y],
        [area.x, area.y + area.h],
        [area.x + area.w, area.y + area.h],
      ] as const) {
        const dx = px - cx;
        const dy = py - cy;
        const x = cx + dx * cos - dy * sin;
        const y = cy + dx * sin + dy * cos;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { x: node.x + minX, y: node.y + minY, w: maxX - minX, h: maxY - minY };
    }
    let result: Rect | null = null;
    const own = node.kind === "frame" && !node.gone;
    if (own) result = { x: node.x, y: node.y, w: node.w, h: node.h };
    if (!(own && frameClips(node.record))) {
      for (const child of node.container!.ids) {
        const b = this.nodes.get(child)?.bounds;
        if (!b) continue;
        const shifted = { x: b.x + node.x, y: b.y + node.y, w: b.w, h: b.h };
        result = result ? unionRect(result, shifted) : shifted;
      }
    }
    return result;
  }

  #reindex(container: Container): void {
    container.ids.forEach((id, rank) => {
      const node = this.nodes.get(id);
      if (node) node.rank = rank;
    });
    if (container.ids.length <= INDEX_THRESHOLD) {
      container.index = null;
      return;
    }
    const index = new SpatialIndex<ElementId>();
    for (const id of container.ids) {
      const b = this.nodes.get(id)?.bounds;
      if (b) index.set(id, b);
    }
    container.index = index;
  }

  /**
   * Removes a node and everything below it that still counts it as parent and
   * has no record any more. Returns the children that still have a record: they
   * now resolve elsewhere and must be read again.
   */
  #remove(id: ElementId, survivors: ElementId[] = []): ElementId[] {
    const node = this.nodes.get(id);
    if (!node) return survivors;
    this.nodes.delete(id);
    if (node.container) {
      for (const child of node.container.ids) {
        if (this.nodes.get(child)?.parent !== id) continue;
        if (this.source.element(child)) survivors.push(child);
        else this.#remove(child, survivors);
      }
    }
    return survivors;
  }

  /**
   * Reads the given elements again from `source` (the same source, or a new one
   * for the new state) and updates nodes, children lists, bounds and indexes.
   *
   * `ids` must be every element whose resolution changed: added, changed or
   * removed records, and every element whose effective parent, position, order
   * or gone state changed because of them (descendants included), as a live
   * resolver reports them. Ids of the transaction alone are not enough in
   * general (a delete can hide a whole subtree). A caller without such a
   * resolver passes every id. The one case handled beyond that: the surviving
   * children of a removed container are read again.
   */
  apply(ids: Iterable<ElementId>, source: SceneSource = this.source): void {
    this.source = source;
    const dirty = new Set<ElementId | null>();
    const touched = new Set<ElementId>();
    const queue = [...ids];
    const queued = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      const old = this.nodes.get(id);
      const record = source.element(id);
      if (!record) {
        if (old) {
          dirty.add(old.parent);
          // Children of a removed container that are still there: read them too,
          // even if the caller did not list them.
          for (const survivor of this.#remove(id)) {
            if (queued.has(survivor)) continue;
            queued.add(survivor);
            queue.push(survivor);
          }
        }
        continue;
      }
      const parent = source.parentOf(id);
      if (old) {
        if (old.parent !== parent) dirty.add(old.parent);
        const pos = source.localPosition(id);
        const wasGone = old.gone;
        old.parent = parent;
        old.record = record;
        old.x = pos.x;
        old.y = pos.y;
        old.w = record.size?.w ?? 0;
        old.h = record.size?.h ?? 0;
        old.rot = old.kind === "element" ? (record.rot ?? 0) : 0;
        old.gone = source.isGone(id);
        if (old.container && wasGone !== old.gone) this.#refreshGone(old);
        if (old.container) dirty.add(id);
      } else {
        const node = this.#makeNode(id, parent, 0);
        if (node?.container) this.#fillContainer(id, node.container);
      }
      dirty.add(parent);
      touched.add(id);
    }
    // Children lists of the containers concerned, in the new drawing order.
    for (const parent of dirty) {
      const container = this.container(parent);
      if (!container) continue;
      const ids = [...source.children(parent)];
      for (const child of ids) {
        const node = this.nodes.get(child);
        if (!node) {
          const made = this.#makeNode(child, parent, 0);
          if (made?.container) this.#fillContainer(child, made.container);
          touched.add(child);
        } else if (node.parent !== parent) {
          node.parent = parent;
          touched.add(child);
        }
      }
      // Children that left and are not anywhere else any more.
      const kept = new Set(ids);
      for (const child of container.ids) {
        if (kept.has(child)) continue;
        const node = this.nodes.get(child);
        if (node && node.parent === parent && !source.element(child)) this.#remove(child);
      }
      container.ids = ids;
    }
    // Bounds of what changed and of every container above it, deepest first;
    // then the indexes.
    const pending = new Set<ElementId>(touched);
    for (const parent of dirty) if (parent !== null) pending.add(parent);
    this.#updateBounds(pending, dirty);
    for (const parent of dirty) {
      const container = this.container(parent);
      if (container) this.#reindex(container);
    }
  }

  /** Depth of a node in the effective tree (root children: 1). */
  #depth(id: ElementId): number {
    let d = 0;
    for (
      let at: ElementId | null = id;
      at !== null;
      at = this.nodes.get(at)?.parent ?? null
    )
      d++;
    return d;
  }

  /**
   * Recomputes the bounds of `pending` nodes, deepest first, and of each
   * container whose child's bounds changed. Index entries are updated in place,
   * except in `reindex` containers, which the caller rebuilds.
   */
  #updateBounds(pending: Set<ElementId>, reindex: ReadonlySet<ElementId | null>): void {
    const byDepth = new Map<number, Set<ElementId>>();
    let maxDepth = 0;
    for (const id of pending) {
      const d = this.#depth(id);
      let set = byDepth.get(d);
      if (!set) byDepth.set(d, (set = new Set()));
      set.add(id);
      if (d > maxDepth) maxDepth = d;
    }
    for (let d = maxDepth; d >= 1; d--) {
      for (const id of byDepth.get(d) ?? []) {
        const node = this.nodes.get(id);
        if (!node) continue;
        const before = node.bounds;
        const after = this.#bounds(node);
        node.bounds = after;
        const same =
          before === after ||
          (before !== null &&
            after !== null &&
            before.x === after.x &&
            before.y === after.y &&
            before.w === after.w &&
            before.h === after.h);
        if (!reindex.has(node.parent)) {
          const index = this.container(node.parent)?.index;
          if (index) {
            if (after) index.set(id, after);
            else index.delete(id);
          }
        }
        if (!same && node.parent !== null) {
          let set = byDepth.get(d - 1);
          if (!set) byDepth.set(d - 1, (set = new Set()));
          set.add(node.parent);
        }
      }
    }
  }

  /** Re-reads the gone flag below a container whose own flag changed. */
  #refreshGone(node: SceneNode): void {
    for (const child of node.container?.ids ?? []) {
      const c = this.nodes.get(child);
      if (!c) continue;
      c.gone = this.source.isGone(child);
      if (c.container) this.#refreshGone(c);
      c.bounds = this.#bounds(c);
    }
    if (node.container) this.#reindex(node.container);
  }

  /**
   * Children of a container whose bounds meet `rect` and are at least `minSize`
   * on their larger side, in drawing order (back to front).
   */
  visibleChildren(container: Container, rect: Rect, minSize: number): SceneNode[] {
    const out: SceneNode[] = [];
    const take = (id: ElementId): void => {
      const node = this.nodes.get(id);
      if (node?.bounds) out.push(node);
    };
    if (container.index) container.index.query(rect, take, minSize);
    else {
      for (const id of container.ids) {
        const node = this.nodes.get(id);
        const b = node?.bounds;
        if (
          b &&
          b.x <= rect.x + rect.w &&
          rect.x <= b.x + b.w &&
          b.y <= rect.y + rect.h &&
          rect.y <= b.y + b.h &&
          Math.max(b.w, b.h) >= minSize
        )
          out.push(node);
      }
      return out;
    }
    out.sort((a, b) => a.rank - b.rank);
    return out;
  }
}
