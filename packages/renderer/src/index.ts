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
} from "./images.ts";
export {
  type TextMeasurer,
  type FontFamilies,
  type Line,
  type LayoutFragment,
  RichTextLayout,
  DEFAULT_FAMILIES,
  DEFAULT_LINE_HEIGHT,
  BAR_BELOW_PX,
  FONT_STEPS,
  REFERENCE_SIZE,
  ladderSize,
  lineHeightOf,
  estimateMeasurer,
  canvasMeasurer,
} from "./text.ts";
export {
  type FontWaiter,
  BUNDLED_FAMILIES,
  NO_WAIT,
  documentFontWaiter,
} from "./fonts.ts";
export {
  type RichText,
  type Paragraph,
  type TextRun,
  type ListKind,
  parseRichText,
  contentString,
  PARAGRAPH_ATTRIBUTES,
} from "./rich-text.ts";
export {
  type TextEdit,
  type TextEditKey,
  type TextEditOptions,
  type TextEditSession,
  type TextSelection,
  diffText,
  transformEdit,
} from "./text-edit.ts";
export { type Canvas2D } from "./canvas.ts";
export { SAFE_COORD } from "./path.ts";
export { detailFor, BOX_BELOW_PX, REDUCED_BELOW_PX } from "./draw-context.ts";
