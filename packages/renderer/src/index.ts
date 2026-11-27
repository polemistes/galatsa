// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/renderer: the Canvas 2D renderer. See docs/adr/0004-rendering-engine.md.

export * from "./renderer.ts";
export * from "./scene.ts";
export {
  type Viewport,
  type SpaceMap,
  type Matrix,
  spaceMap,
  elementMatrix,
  visibleRect,
} from "./transform.ts";
export {
  type ImageSource,
  type ImageLevel,
  type ImageCacheOptions,
  type ImageCacheStats,
  type DecoderKind,
  type Decoded,
  type DecodeFn,
  type Version,
  ImageCache,
  defaultDecoderKind,
  versionsOf,
  pickVersion,
  decodeSvg,
  svgAtSize,
  MAX_SCALABLE_SIDE,
  SVG_TYPE,
} from "./images.ts";
export {
  type MadePreview,
  type PreviewOptions,
  makeImagePreviews,
  previewSizes,
  PREVIEW_LARGEST,
  PREVIEW_MARGIN,
  PREVIEW_SMALLEST,
} from "./previews.ts";
export {
  type TextMeasurer,
  type FontFamilies,
  DEFAULT_FAMILIES,
  BAR_BELOW_PX,
  FONT_STEPS,
  ladderSize,
  estimateMeasurer,
  canvasMeasurer,
} from "./text.ts";
export { type Canvas2D } from "./canvas.ts";
export { SAFE_COORD } from "./path.ts";
export { detailFor, BOX_BELOW_PX, REDUCED_BELOW_PX } from "./draw-context.ts";
