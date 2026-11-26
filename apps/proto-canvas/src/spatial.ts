// SPDX-License-Identifier: GPL-3.0-or-later

// A static uniform grid over axis-aligned bounding boxes. Elements are stored in
// every cell their box touches; a query collects the cells under a rectangle,
// removes duplicates and returns the indices in ascending order, which is paint
// order. Good enough for a fixed scene of a few thousand elements; a document that
// changes would need a dynamic structure (or rebuilding on change).

export class GridIndex {
  private readonly boxes: Float64Array;
  private readonly count: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Compressed rows: items of cell c are cellItems[cellStart[c] .. cellStart[c + 1]). */
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly stamp: Uint32Array;
  private stampValue = 0;
  private readonly result: Int32Array;

  /** `boxes` holds minX, minY, maxX, maxY for each item, in paint order. */
  constructor(boxes: Float64Array, cellSize: number) {
    this.boxes = boxes;
    this.count = boxes.length / 4;
    this.cellSize = cellSize;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.count; i++) {
      minX = Math.min(minX, boxes[i * 4]!);
      minY = Math.min(minY, boxes[i * 4 + 1]!);
      maxX = Math.max(maxX, boxes[i * 4 + 2]!);
      maxY = Math.max(maxY, boxes[i * 4 + 3]!);
    }
    if (this.count === 0) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    this.originX = minX;
    this.originY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    this.rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
    const cells = this.cols * this.rows;
    const counts = new Int32Array(cells + 1);
    this.forEachCell((cell) => {
      counts[cell + 1]!++;
    });
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts.slice();
    this.cellItems = new Int32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    this.forEachCell((cell, item) => {
      this.cellItems[fill[cell]!++] = item;
    });
    this.stamp = new Uint32Array(this.count);
    this.result = new Int32Array(this.count);
  }

  private cellRange(minX: number, minY: number, maxX: number, maxY: number) {
    const c0 = Math.max(0, Math.floor((minX - this.originX) / this.cellSize));
    const r0 = Math.max(0, Math.floor((minY - this.originY) / this.cellSize));
    const c1 = Math.min(this.cols - 1, Math.floor((maxX - this.originX) / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.floor((maxY - this.originY) / this.cellSize));
    return { c0, r0, c1, r1 };
  }

  private forEachCell(visit: (cell: number, item: number) => void): void {
    const b = this.boxes;
    for (let i = 0; i < this.count; i++) {
      const { c0, r0, c1, r1 } = this.cellRange(
        b[i * 4]!,
        b[i * 4 + 1]!,
        b[i * 4 + 2]!,
        b[i * 4 + 3]!,
      );
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) visit(r * this.cols + c, i);
      }
    }
  }

  /**
   * Indices of the items whose box intersects the rectangle, in ascending order.
   * The returned array is reused by the next call.
   */
  query(minX: number, minY: number, maxX: number, maxY: number): Int32Array {
    const b = this.boxes;
    const out = this.result;
    let n = 0;
    const { c0, r0, c1, r1 } = this.cellRange(minX, minY, maxX, maxY);
    const cellsInRange = Math.max(0, c1 - c0 + 1) * Math.max(0, r1 - r0 + 1);
    const hit = (i: number) =>
      b[i * 4]! <= maxX &&
      b[i * 4 + 2]! >= minX &&
      b[i * 4 + 1]! <= maxY &&
      b[i * 4 + 3]! >= minY;
    if (cellsInRange * 4 >= this.cols * this.rows) {
      // Most of the grid is in view: a straight scan is cheaper and already sorted.
      for (let i = 0; i < this.count; i++) if (hit(i)) out[n++] = i;
      return out.subarray(0, n);
    }
    if (++this.stampValue === 0xffffffff) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    const s = this.stampValue;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c;
        for (let k = this.cellStart[cell]!; k < this.cellStart[cell + 1]!; k++) {
          const i = this.cellItems[k]!;
          if (this.stamp[i] === s) continue;
          this.stamp[i] = s;
          if (hit(i)) out[n++] = i;
        }
      }
    }
    return out.subarray(0, n).sort();
  }
}
