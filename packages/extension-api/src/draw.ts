// SPDX-License-Identifier: GPL-3.0-or-later

// The drawing context the renderer hands to element types, tools and transitions
// that draw. See docs/adr/0005-extension-interface.md, section 3.3, and
// docs/adr/0004-rendering-engine.md.
//
// Nothing here is a DOM type. The renderer implements this over Canvas 2D; the
// player, a thumbnail or image export, or a test can implement it otherwise.

import type { AssetId, Rect, YTextValue } from "@galatsa/core";
import type { MessageValues } from "@galatsa/i18n";
import type { Label } from "./ids.ts";

/** A colour in CSS syntax, for example "#1e293b" or "rgb(30 41 59 / 50%)". */
export type Color = string;

export interface StrokeStyle {
  readonly color: Color;
  /** Line width in the coordinates being drawn (world units for elements). */
  readonly width: number;
  readonly dash?: readonly number[];
  readonly join?: "miter" | "round" | "bevel";
  readonly cap?: "butt" | "round" | "square";
}

/**
 * A path, built like a Canvas 2D path. The renderer converts every point itself,
 * in float64, relative to the camera, and clips geometry far outside the screen
 * before it reaches the canvas, so element types never deal with precision.
 */
export interface Path {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void;
  /** Angles in radians, clockwise on screen (y points down). */
  arc(
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    counterclockwise?: boolean,
  ): void;
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise?: boolean,
  ): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radius: number): void;
  closePath(): void;
}

/**
 * How much detail the renderer asks for. "full": draw everything. "reduced": the
 * element is small on screen or the camera is moving fast; skip fine detail
 * (thin strokes, shadows, small text may become bars). "box": the element is a
 * few device pixels; a filled box in its main colour is enough. Elements smaller
 * than half a device pixel are not drawn at all.
 */
export type DetailLevel = "full" | "reduced" | "box";

/** State of an image the renderer was asked to draw. */
export type ImageState = "drawn" | "loading" | "missing";

export interface TextStyle {
  readonly fontFamily: string;
  /** Font size in world units. The renderer draws text at its final size on screen. */
  readonly fontSize: number;
  readonly color: Color;
  readonly align: "left" | "center" | "right";
  /** Line height as a multiple of the font size. */
  readonly lineHeight?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/**
 * Text laid out by the renderer. Line breaks are computed once at a reference
 * size and scaled, so they do not change with zoom, and the in-place editor uses
 * the same breaks (docs/adr/0004). Opaque apart from its size.
 */
export interface TextLayout {
  /** Size of the laid-out text, in world units. */
  readonly width: number;
  readonly height: number;
  readonly lineCount: number;
}

/** Text content to lay out: plain text, or rich text in its JSON form. */
export type TextContent = string | YTextValue;

/**
 * What an element type, a tool overlay or a placeholder draws through. Element
 * types draw in the element's local, unrotated box: (0, 0) is the top-left
 * corner and (w, h) the bottom-right, in world units. The renderer applies the
 * element's position, rotation, containers and the camera.
 */
export interface DrawContext {
  /** Device pixels per unit of the coordinates being drawn, at the element. */
  readonly scale: number;
  readonly detail: DetailLevel;
  createPath(): Path;
  fill(path: Path, color: Color): void;
  stroke(path: Path, style: StrokeStyle): void;
  /** Runs `draw` with the opacity multiplied by `alpha` (0 to 1). */
  withOpacity(alpha: number, draw: () => void): void;
  /** Runs `draw` clipped to `path`. */
  withClip(path: Path, draw: () => void): void;
  /**
   * Runs `draw` with the origin moved to (x, y). Only translation: scaling and
   * rotation stay with the renderer, which keeps them precise.
   */
  withOffset(x: number, y: number, draw: () => void): void;
  /**
   * Draws an image asset into `dest`. The renderer picks the stored reduced
   * level that matches the size on screen and never decodes the original unless
   * it fills the view (docs/adr/0004). `crop` is a rectangle in the image's
   * pixels. When the result is not "drawn", the element type may draw its own
   * stand-in; the renderer redraws when a loading image arrives.
   */
  drawImage(asset: AssetId, dest: Rect, options?: { readonly crop?: Rect }): ImageState;
  /** Lays text out at `width` with the renderer's text engine. */
  layoutText(content: TextContent, style: TextStyle, width: number): TextLayout;
  /** Draws laid-out text with its top-left corner at (x, y). */
  drawText(layout: TextLayout, x: number, y: number): void;
  /** Looks up a message in the current language, for text an element draws itself. */
  t(label: Label, values?: MessageValues): string;
}
