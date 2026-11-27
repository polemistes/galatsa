// SPDX-License-Identifier: GPL-3.0-or-later

// What a shape kind is. Every shape is an element of one type,
// "galatsa.shape/shape", whose data names its kind; a kind is a plain object
// that draws an outline in the element's box. Everything else (reading and
// checking the data, drawing with fill, outline and opacity, hit testing,
// bounds, the drawing tool and its preview, the properties and the commands)
// is the framework's, and works from this description. Adding a shape is
// adding one file that exports a ShapeKind, and listing it in kinds/index.ts.
// See README.md for the recipe and docs/adr/0010-shapes.md for the reasons.

import type { Label, Path, Shortcut, StrokeStyle } from "@galatsa/extension-api";
import { messageKey } from "@galatsa/extension-api";
import type { BundleKey } from "@galatsa/i18n";
import { shapeMessages } from "./messages/index.ts";
import type { ShapeStyle } from "./model.ts";

/** A label in the shape extension's own bundle; a typo is a type error. */
export function shapeLabel(key: BundleKey<typeof shapeMessages>): Label {
  return messageKey(shapeMessages, key);
}

/** The value of a kind-specific property. */
export type ParamValue = number | string | boolean;

/**
 * A property that only some kinds have (the size of an arrowhead, where a
 * speech bubble's tail points). Its value is stored under `key` in the
 * element's data, next to the common style keys, and offered as a field for
 * the kinds that list it. Several kinds may list the same parameter object.
 *
 * Positions MUST be fractions of the box (0 to 1, or beyond for something
 * that reaches outside it), never world units, so that resizing an element
 * never has to change its data. Sizes that should not grow with the box (an
 * arrowhead) are in world units, like the outline width.
 */
export type ShapeParam =
  | {
      readonly type: "number";
      readonly key: string;
      readonly label: Label;
      /** Offered in quick mode too. */
      readonly quick?: boolean;
      readonly min: number;
      readonly max: number;
      readonly step?: number;
      readonly default: number;
    }
  | {
      readonly type: "choice";
      readonly key: string;
      readonly label: Label;
      readonly quick?: boolean;
      readonly options: readonly { readonly value: string; readonly label: Label }[];
      readonly default: string;
    }
  | {
      readonly type: "toggle";
      readonly key: string;
      readonly label: Label;
      readonly quick?: boolean;
      readonly default: boolean;
    };

/** What a kind draws its outline from. */
export interface ShapeGeometry {
  /** The element's box, in world units. The outline is drawn in (0, 0) to (w, h). */
  readonly w: number;
  readonly h: number;
  /** The corner rounding, already limited to half the shorter side (0 for kinds without corners). */
  readonly cornerRadius: number;
  /** The outline width, 0 when the shape has no outline. For marks that scale with it. */
  readonly strokeWidth: number;
  /** Values of the kind's parameters, by key, read and checked. */
  readonly params: Readonly<Record<string, ParamValue>>;
}

/**
 * Where a kind draws. `body` is the outline: filled with the fill colour if the
 * kind is closed, and stroked with the outline style. `marks` is filled with
 * the outline colour (arrowheads, dots); it is drawn only when the shape has
 * an outline, and created on first use.
 */
export interface ShapeOutline {
  readonly body: Path;
  readonly marks: Path;
}

/** How the drawing tool makes a shape of this kind from a drag. */
export type DrawingMode =
  /** A box from corner to corner; Shift makes it square, Alt draws from the centre. */
  | "box"
  /**
   * A line from where the drag starts to where it ends: a box as long as the
   * drag and 0 high, turned in the drag's direction (the element's rotation).
   * The kind draws along the middle of its box, from left to right. Shift
   * keeps the angle to steps of 15 degrees.
   */
  | "line";

export interface ShapeKind {
  /**
   * The value of the data's `kind` key, and the name of the kind's drawing
   * tool ("galatsa.shape/<kind>"). Lowercase letters, digits and hyphens,
   * starting with a letter, at most 32 characters. Stored in documents: never
   * rename a kind.
   */
  readonly kind: string;
  /** Name of the kind and its tool: shapeLabel("kind.<kind>"). */
  readonly label: Label;
  /** Key that picks the drawing tool. */
  readonly shortcut?: Shortcut;
  /** The drawing tool is offered in quick mode too (default true). */
  readonly quick?: boolean;
  /** True if the body is a closed area that the fill colour fills. */
  readonly closed: boolean;
  /** True if the kind has corners that the corner rounding rounds. */
  readonly corners?: boolean;
  /** How the drawing tool makes it (default "box"). */
  readonly drawing?: DrawingMode;
  /** How the outline's corners and ends are drawn (default "round" for both). */
  readonly join?: StrokeStyle["join"];
  readonly cap?: StrokeStyle["cap"];
  /**
   * Style a new shape of this kind gets instead of the common defaults
   * (DEFAULT_STYLE), as a speech bubble's rounded corners. Lengths
   * (`strokeWidth`, `cornerRadius`) are world units at zoom 1, that is screen
   * pixels: the drawing tool scales them so that a new shape looks the same
   * at whatever zoom it is drawn. Only new shapes are written with these;
   * data without a key always means the common default.
   */
  readonly defaults?: Partial<ShapeStyle>;
  /** Properties only this kind (or a few kinds) has. */
  readonly params?: readonly ShapeParam[];
  /**
   * Adds the outline for `shape` to `out`. A pure function of its argument,
   * drawn in the element's local box; the framework draws it with the shape's
   * style, uses it for hit testing and bounds, and turns it for previews. May
   * reach outside the box (a speech bubble's tail); bounds follow.
   */
  outline(out: ShapeOutline, shape: ShapeGeometry): void;
}

/** The form of a kind name (and so of a tool name). */
export const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Checks a kind with its type; returns it unchanged. */
export function defineShapeKind(kind: ShapeKind): ShapeKind {
  return kind;
}
