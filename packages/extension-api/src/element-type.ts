// SPDX-License-Identifier: GPL-3.0-or-later

// Element types, viewing part: what the renderer and the player need to draw an
// element and find it under the pointer. The editing part (upgrades, references,
// properties, text editing, capabilities) is in element-editing.ts, in the
// editing entry. See docs/adr/0005-extension-interface.md, section 3.

import type { AssetId, ElementData, ElementId, Point, Rect } from "@galatsa/core";
import type { DrawContext } from "./draw.ts";
import type { Label } from "./ids.ts";

/**
 * Called by `read` for each part of the data that does not fit and was read as
 * a default: `path` names the key ("fontSize", "crop.w"), `problem` says what was
 * wrong. Reading the same data again must report the same things. A key that is
 * missing is not a problem: it reads as its default (section 3.8).
 */
export type DataReport = (path: string, problem: string) => void;

/** The envelope facts an element type needs to draw and hit-test an element. */
export interface ElementBox {
  readonly id: ElementId;
  /** Size of the unrotated box, in world units. */
  readonly w: number;
  readonly h: number;
}

/**
 * The viewing part of an element type. `M` is the type's model: the data as the
 * type understands it, produced by `read` and handed to every other method.
 * Methods that take `M` are written as methods, so a definition for a specific
 * model can be listed with definitions for other models.
 */
export interface ElementTypeView<M> {
  /** Type name; the element type id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  /**
   * The newest layout of `data` this definition reads and writes, an integer
   * >= 1. `read` keeps reading every older version.
   */
  readonly typeVersion: number;

  /**
   * Reads an element's data into the model. Total: it never throws, whatever
   * the data holds (a peer, an old version or a damaged file may have written
   * it). A missing key reads as its default without a report; a key whose value
   * does not fit reads as its default and is reported. `typeVersion` is at most
   * this definition's; newer elements never reach `read` (they are drawn as
   * placeholders). Data that reads without reports is valid: the editor uses
   * this to check data before a command writes it. Pure, so the result may be
   * cached until the element's data changes.
   */
  read(data: ElementData, typeVersion: number, report: DataReport): M;

  /** Draws the element in its local box. Pure: everything comes from the model and the box. */
  draw(model: M, ctx: DrawContext, box: ElementBox): void;

  /**
   * The area the drawing covers, in the local box, when it reaches beyond the
   * box (a thick stroke, a shadow). Used for culling and redraw regions.
   * Default: the box.
   */
  bounds?(model: M, box: ElementBox): Rect;

  /**
   * True if `point` (in the local box) hits the element, within `tolerance`
   * world units. The renderer has already found the point near the bounds.
   * Default: inside the box, grown by the tolerance.
   */
  hitTest?(model: M, point: Point, box: ElementBox, tolerance: number): boolean;

  /**
   * The assets the element shows, so a viewer can load them ahead and say which
   * are missing. Informational: the document finds asset references by scanning
   * for asset ids, so nothing is lost if this is incomplete.
   */
  assets?(model: M): readonly AssetId[];
}

/** An element type view of any model, as the host stores it. */
export type AnyElementView = ElementTypeView<unknown>;

/** Identity function that infers the model type of a view. */
export function defineElementView<M>(view: ElementTypeView<M>): ElementTypeView<M> {
  return view;
}
