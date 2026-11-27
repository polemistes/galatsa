// SPDX-License-Identifier: GPL-3.0-or-later

// What the renderer reads: the document's live resolver, with the preview of a
// gesture laid over it. The renderer never sees Yjs (docs/adr/0004); it reads
// this source, and is told which ids to read again, both when the document
// changes (the live resolver's report) and when a preview changes.
//
// A preview gives positions, sizes, rotations and data values for some
// elements, positions in each element's effective parent space
// (docs/adr/0005, section 4.7). The document is not changed: only this source
// answers differently. A previewed container moves what is inside it, because
// every offset through it is shifted by the same amount.

import {
  Problems,
  envelopeField,
  type ElementData,
  type ElementId,
  type LiveResolver,
  type Point,
} from "@galatsa/core";
import { roots } from "@galatsa/core/ydoc";
import {
  readData,
  type ElementPreview,
  type PreviewChanges,
} from "@galatsa/extension-api/editing";
import type { SceneElement, SceneSource } from "@galatsa/renderer";
import * as Y from "yjs";

export class EditorScene implements SceneSource {
  readonly #doc: Y.Doc;
  readonly #live: LiveResolver;
  #preview: ReadonlyMap<ElementId, ElementPreview> = new Map();

  constructor(doc: Y.Doc, live: LiveResolver) {
    this.#doc = doc;
    this.#live = live;
  }

  /** The preview shown now (empty when there is none). */
  get preview(): ReadonlyMap<ElementId, ElementPreview> {
    return this.#preview;
  }

  /**
   * Replaces the preview (null clears it) and returns the ids the renderer must
   * read again: those previewed before or now, and everything inside them.
   */
  setPreview(changes: PreviewChanges | null): Set<ElementId> {
    const next = new Map<ElementId, ElementPreview>();
    if (changes !== null) {
      for (const id of Object.keys(changes)) {
        const preview = changes[id];
        if (preview !== undefined && this.#live.get(id) !== undefined)
          next.set(id, preview);
      }
    }
    const touched = new Set<ElementId>();
    for (const id of [...this.#preview.keys(), ...next.keys()]) {
      if (touched.has(id)) continue;
      touched.add(id);
      if (this.#live.get(id) !== undefined && this.#live.isContainer(id))
        for (const inner of this.#live.descendants(id)) touched.add(inner);
    }
    this.#preview = next;
    return touched;
  }

  children(parent: ElementId | null): readonly ElementId[] {
    return this.#live.children(parent);
  }

  parentOf(id: ElementId): ElementId | null {
    return this.#live.parentOf(id);
  }

  isGone(id: ElementId): boolean {
    return this.#live.isGone(id);
  }

  isContainer(id: ElementId | null): boolean {
    return this.#live.isContainer(id);
  }

  localPosition(id: ElementId): Point {
    const at = this.#live.localPosition(id);
    const preview = this.#preview.get(id);
    if (preview === undefined) return at;
    return { x: preview.x ?? at.x, y: preview.y ?? at.y };
  }

  /** How far the preview moves the origin of a space, in root units. */
  #shift(space: ElementId | null): Point {
    let x = 0;
    let y = 0;
    if (this.#preview.size === 0) return { x, y };
    for (let at = space; at !== null; at = this.#live.parentOf(at)) {
      const preview = this.#preview.get(at);
      if (preview === undefined) continue;
      const real = this.#live.localPosition(at);
      x += (preview.x ?? real.x) - real.x;
      y += (preview.y ?? real.y) - real.y;
    }
    return { x, y };
  }

  offset(from: ElementId | null, to: ElementId | null): Point {
    const base = this.#live.offset(from, to);
    if (this.#preview.size === 0) return base;
    // Containers only translate, so a shift of an ancestor shifts the space by
    // the same amount; ancestors the two share cancel out.
    const a = this.#shift(from);
    const b = this.#shift(to);
    return { x: base.x + a.x - b.x, y: base.y + a.y - b.y };
  }

  element(id: ElementId): SceneElement | undefined {
    const envelope = this.#live.get(id);
    if (envelope === undefined) return undefined;
    const map = roots(this.#doc).elements.get(id);
    if (!(map instanceof Y.Map)) return undefined;
    let data: ElementData;
    try {
      data = readData({ doc: this.#doc }, id);
    } catch {
      data = {};
    }
    const record: SceneElement = {
      type: envelope.type,
      typeVersion: envelopeField.typeVersion(map.get("typeVersion"), new Problems(0)),
      data,
      size: envelope.size,
      rot: envelope.rot,
    };
    const preview = this.#preview.get(id);
    if (preview === undefined) return record;
    return {
      ...record,
      data: preview.data !== undefined ? { ...data, ...preview.data } : data,
      size:
        record.size !== undefined && (preview.w !== undefined || preview.h !== undefined)
          ? { w: preview.w ?? record.size.w, h: preview.h ?? record.size.h }
          : record.size,
      rot:
        record.rot !== undefined && preview.rot !== undefined ? preview.rot : record.rot,
    };
  }
}
