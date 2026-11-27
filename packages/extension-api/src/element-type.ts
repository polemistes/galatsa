// SPDX-License-Identifier: GPL-3.0-or-later

// Element types: what an extension tells the program about the elements it
// defines. See docs/adr/0005-extension-interface.md, section 3.

import type { AssetId, ElementData, ElementId, Point, Rect } from "@galatsa/core";
import type { DrawContext, TextStyle } from "./draw.ts";
import type { FieldDefinition } from "./fields.ts";
import type { Label } from "./ids.ts";

/**
 * Called by `read` for each part of the data that does not fit and was read as
 * a default: `path` names the key ("fontSize", "crop.w"), `problem` says what was
 * wrong. Reading the same data again must report the same things.
 */
export type DataReport = (path: string, problem: string) => void;

/** The envelope facts an element type needs to draw and hit-test an element. */
export interface ElementBox {
  readonly id: ElementId;
  /** Size of the unrotated box, in world units. */
  readonly w: number;
  readonly h: number;
}

/** What the user may do to an element besides moving, stacking, grouping and deleting it. */
export interface ElementCapabilities {
  /** Change the size of the box. */
  readonly resize: boolean;
  /** Change the rotation. */
  readonly rotate: boolean;
  /** Change the content (data), through the type's commands, fields and text editing. */
  readonly editContent: boolean;
}

/**
 * Where in-place text editing happens for a text-like element: the renderer's
 * beginTextEdit lays an editable browser element over `box`, styled with
 * `style`, bound to the shared text at data key `key`, using the same line
 * breaks as the drawn text.
 */
export interface TextEditTarget {
  /** Data key of the Y.Text being edited. */
  readonly key: string;
  readonly style: TextStyle;
  /** The text area, in the element's local box. */
  readonly box: Rect;
  /**
   * The box height follows the text: the editor resizes the element (one undo
   * step with the typing it belongs to) when the laid-out height changes.
   */
  readonly autoHeight?: boolean;
}

/**
 * An element type. `M` is the type's model: the data as the type understands
 * it, produced by `read` and handed to every other method. Methods that take
 * `M` are written as methods, so a definition for a specific model can be
 * listed with definitions for other models.
 */
export interface ElementTypeDefinition<M> {
  /** Type name; the element type id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  /**
   * The newest layout of `data` this definition writes, an integer >= 1. It is
   * raised when the layout changes; `read` keeps reading every older version.
   */
  readonly typeVersion: number;

  /**
   * Reads an element's data into the model. Total: it never throws, whatever
   * the data holds (a peer, an old version or a damaged file may have written
   * it). What does not fit is read as a default and reported. `typeVersion` is
   * at most this definition's; newer elements never reach `read` (they are
   * drawn as placeholders). Data that reads without reports is valid: the host
   * uses this to check data before a command writes it. Pure, so the host may
   * cache the result until the element's data changes.
   */
  read(data: ElementData, typeVersion: number, report: DataReport): M;

  /**
   * The data writes that bring data written in layout `from` up to the current
   * layout: keys to set, in their new values. Called only as part of a user's
   * edit of the element, never on load; the host applies the writes, the edit
   * and the new type version in one transaction. Prefer adding keys to
   * rewriting them, so two users upgrading at the same time converge. Needed
   * only when `typeVersion` > 1.
   */
  upgrade?(data: ElementData, from: number): ElementData;

  /**
   * The ids of elements and stops the data refers to. The host keeps the
   * envelope's `refs` equal to this whenever a command writes data, so copy
   * and paste remap the references (docs/adr/0001, section 3.5). References
   * are stored as complete string values equal to the id.
   */
  references?(model: M): readonly string[];

  /**
   * The assets the element shows. Informational (for "missing image" notices):
   * the document finds asset references by scanning for asset ids, so nothing
   * is lost if this is incomplete. A command that writes an asset reference
   * registers the asset with `addAsset` in the same command.
   */
  assets?(model: M): readonly AssetId[];

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

  /** For text-like types: where in-place editing happens, or null if not now. */
  textEditing?(model: M, box: ElementBox): TextEditTarget | null;

  /** Limits on what the user may do; the default allows resizing and rotating. */
  readonly capabilities?: Partial<Pick<ElementCapabilities, "resize" | "rotate">>;

  /**
   * The element's adjustable properties, for the editor's properties panel. A
   * field marked `quick` is shown in quick mode too.
   */
  readonly properties?: readonly FieldDefinition<M>[];
}

/** An element type of any model, as the host stores it. */
export type AnyElementType = ElementTypeDefinition<unknown>;

/** Identity function that infers the model type of a definition. */
export function defineElementType<M>(
  definition: ElementTypeDefinition<M>,
): ElementTypeDefinition<M> {
  return definition;
}
