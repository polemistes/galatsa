// SPDX-License-Identifier: GPL-3.0-or-later

// A spatial index for the children of one container, in that container's local
// coordinates: a hierarchy of uniform grids. An entry goes into the level whose
// cell is at least as large as the entry (so it touches at most four cells), and
// levels are a factor of four apart. That handles the mix of sizes a canvas has
// (fine print of 2 units next to backdrops of 10,000) without rebuilding, and
// insertion, removal and moves cost the same whatever the scene holds.
//
// Two shortcuts make culling cheap at both ends of the zoom range:
// - a query that would visit more cells of a level than the level has entries
//   scans the level's entries instead (zoomed far out);
// - a query can skip every level whose largest entry is smaller than a given size
//   (elements under half a device pixel are not drawn).

import type { Rect } from "@galatsa/core";

const LEVEL_FACTOR = 4;
/** Cell size of level 0, in local units. Smaller entries all go there. */
const BASE_CELL = 64;
const MAX_LEVEL = 24;

interface Entry<T> {
  readonly value: T;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  level: number;
  /** Keys of the cells it is in. */
  cells: string[];
}

interface Level<T> {
  readonly cell: number;
  readonly cells: Map<string, Set<Entry<T>>>;
  readonly entries: Set<Entry<T>>;
  /** Largest side of an entry here; may be stale-high after removals (safe). */
  maxSize: number;
}

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

export class SpatialIndex<T> {
  readonly #levels: (Level<T> | undefined)[] = [];
  readonly #entries = new Map<T, Entry<T>>();

  get size(): number {
    return this.#entries.size;
  }

  #levelFor(size: number): number {
    let level = 0;
    let cell = BASE_CELL;
    while (cell < size && level < MAX_LEVEL) {
      cell *= LEVEL_FACTOR;
      level++;
    }
    return level;
  }

  #level(index: number): Level<T> {
    let level = this.#levels[index];
    if (!level) {
      level = {
        cell: BASE_CELL * LEVEL_FACTOR ** index,
        cells: new Map(),
        entries: new Set(),
        maxSize: 0,
      };
      this.#levels[index] = level;
    }
    return level;
  }

  /** Adds or moves `value` to `rect`. A rectangle with a non-finite side is kept at the top level. */
  set(value: T, rect: Rect): void {
    this.delete(value);
    const finite =
      Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      Number.isFinite(rect.w) &&
      Number.isFinite(rect.h);
    const size = finite ? Math.max(rect.w, rect.h, 0) : Infinity;
    const index = finite ? this.#levelFor(size) : MAX_LEVEL;
    const level = this.#level(index);
    const entry: Entry<T> = {
      value,
      minX: rect.x,
      minY: rect.y,
      maxX: rect.x + rect.w,
      maxY: rect.y + rect.h,
      level: index,
      cells: [],
    };
    if (finite && index < MAX_LEVEL) {
      const c = level.cell;
      const x0 = Math.floor(entry.minX / c);
      const x1 = Math.floor(entry.maxX / c);
      const y0 = Math.floor(entry.minY / c);
      const y1 = Math.floor(entry.maxY / c);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = cellKey(ix, iy);
          let set = level.cells.get(key);
          if (!set) level.cells.set(key, (set = new Set()));
          set.add(entry);
          entry.cells.push(key);
        }
      }
    }
    level.entries.add(entry);
    if (size > level.maxSize) level.maxSize = size;
    this.#entries.set(value, entry);
  }

  delete(value: T): void {
    const entry = this.#entries.get(value);
    if (!entry) return;
    const level = this.#levels[entry.level]!;
    for (const key of entry.cells) {
      const set = level.cells.get(key);
      set?.delete(entry);
      if (set?.size === 0) level.cells.delete(key);
    }
    level.entries.delete(entry);
    if (level.entries.size === 0) level.maxSize = 0;
    this.#entries.delete(value);
  }

  clear(): void {
    this.#levels.length = 0;
    this.#entries.clear();
  }

  /**
   * Calls `visit` once for every entry that overlaps `rect` and whose larger side
   * is at least `minSize`. The order is unspecified.
   */
  query(rect: Rect, visit: (value: T) => void, minSize = 0): void {
    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.w;
    const maxY = rect.y + rect.h;
    const hit = (e: Entry<T>): boolean =>
      e.maxX >= minX &&
      e.minX <= maxX &&
      e.maxY >= minY &&
      e.minY <= maxY &&
      Math.max(e.maxX - e.minX, e.maxY - e.minY) >= minSize;
    for (let index = 0; index < this.#levels.length; index++) {
      const level = this.#levels[index];
      if (!level || level.entries.size === 0) continue;
      if (level.maxSize < minSize) continue;
      const c = level.cell;
      const x0 = Math.floor(minX / c);
      const x1 = Math.floor(maxX / c);
      const y0 = Math.floor(minY / c);
      const y1 = Math.floor(maxY / c);
      const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (
        index === MAX_LEVEL ||
        !Number.isFinite(cellCount) ||
        cellCount >= level.entries.size
      ) {
        for (const e of level.entries) if (hit(e)) visit(e.value);
        continue;
      }
      // An entry can be in up to four cells; report it once.
      const seen = new Set<Entry<T>>();
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const set = level.cells.get(cellKey(ix, iy));
          if (!set) continue;
          for (const e of set) {
            if (e.cells.length > 1) {
              if (seen.has(e)) continue;
              seen.add(e);
            }
            if (hit(e)) visit(e.value);
          }
        }
      }
    }
  }
}
