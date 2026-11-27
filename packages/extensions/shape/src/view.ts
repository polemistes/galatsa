// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-shape/view: the viewing part of the shape extension, what
// the renderer and the player need to draw shapes. Nothing reachable from here
// imports editing code, Yjs or the document's operations.

import {
  EXTENSION_API_VERSION,
  defineElementView,
  defineViewExtension,
  type ElementTypeView,
  type ViewExtension,
} from "@galatsa/extension-api";
import { drawShape, hitShape, shapeBounds } from "./draw.ts";
import { shapeLabel, type ShapeKind } from "./kind.ts";
import { SHAPE_KINDS } from "./kinds/index.ts";
import { shapeMessages } from "./messages/index.ts";
import { kindTable, readShape, type KindTable, type ShapeModel } from "./model.ts";

export * from "./kind.ts";
export * from "./model.ts";
export * from "./outline.ts";
export { SHAPE_KINDS } from "./kinds/index.ts";
export { shapeMessages } from "./messages/index.ts";
export { drawShape, hitShape, shapeBounds, placedContext } from "./draw.ts";
export {
  GALLERY_CELL,
  shapeGallery,
  type GalleryCase,
  type GalleryStrip,
} from "./gallery.ts";

export const SHAPE_EXTENSION = "galatsa.shape";
/** The one element type of every shape; the data's `kind` says which shape. */
export const SHAPE_TYPE = `${SHAPE_EXTENSION}/shape`;

/** The element type and viewing extension for a list of kinds. */
export interface ShapeViewParts {
  readonly table: KindTable;
  readonly view: ElementTypeView<ShapeModel>;
  readonly extension: ViewExtension;
}

/**
 * Builds the viewing part for `kinds`. The program uses it once, with
 * SHAPE_KINDS; tests use it to show that a kind written in a file of its own
 * needs no change here.
 */
export function createShapeView(kinds: readonly ShapeKind[]): ShapeViewParts {
  const table = kindTable(kinds);
  const view = defineElementView<ShapeModel>({
    name: "shape",
    label: shapeLabel("name"),
    typeVersion: 1,
    read: (data, _typeVersion, report) => readShape(table, data, report),
    draw: (model, ctx, box) => drawShape(table, SHAPE_TYPE, model, ctx, box),
    bounds: (model, box) => shapeBounds(table, model, box),
    hitTest: (model, point, box, tolerance) =>
      hitShape(table, model, point, box, tolerance),
  });
  const extension = defineViewExtension({
    id: SHAPE_EXTENSION,
    version: "0.1.0",
    api: EXTENSION_API_VERSION,
    messages: [shapeMessages],
    elementTypes: [view],
  });
  return { table, view, extension };
}

/** The viewing part with the program's kinds. */
export const shapeViewParts: ShapeViewParts = createShapeView(SHAPE_KINDS);
/** The shape element type, with the program's kinds. */
export const shapeView: ElementTypeView<ShapeModel> = shapeViewParts.view;
/** The viewing part of the shape extension, with the program's kinds. */
export const shapeViewExtension: ViewExtension = shapeViewParts.extension;
/** The program's kinds, checked, with their parameters. */
export const shapeKinds: KindTable = shapeViewParts.table;
