// SPDX-License-Identifier: GPL-3.0-or-later

// The text box's data and how it is read (docs/adr/0011-text.md). This is part
// of the file format. Every key is optional when read, and a missing key
// means its default, forever; new text boxes are written with every key.
//
// | Key          | Value                                                        | Default     |
// | ------------ | ------------------------------------------------------------ | ----------- |
// | `text`       | Shared rich text (Y.Text); attributes below                  | empty       |
// | `fontFamily` | A generic family name: `sans`, `serif`, `mono`               | `"sans"`    |
// | `fontSize`   | Font size in world units, above 0, at most MAX_SIZE          | `24`        |
// | `color`      | `"#rrggbb"` or `"#rrggbbaa"`                                 | `"#1e293b"` |
// | `align`      | `left`, `center` or `right`                                  | `"left"`    |
//
// Rich text attributes: `bold: true`, `italic: true` and `color` on
// characters; `list: "bullet" | "ordered"` on the "\n" that ends a paragraph.
// New text ends with "\n", so every paragraph has one; text without it is read
// the same (its last paragraph has no list).
//
// Growth (docs/adr/0005, section 3.2, "Lenient reading"): a family name or an
// alignment this version does not know is kept and read without a report, and
// drawn as sans serif or left; the commands write only what this version
// knows.

import type { DataReport, Color } from "@galatsa/extension-api";
import type { DataValue, ElementData, YTextValue } from "@galatsa/core";

export const TEXT_EXTENSION = "galatsa.text";
export const TEXT_TYPE = `${TEXT_EXTENSION}/text`;

export const FAMILIES = ["sans", "serif", "mono"] as const;
export const ALIGNS = ["left", "center", "right"] as const;
export type Family = (typeof FAMILIES)[number];
export type Align = (typeof ALIGNS)[number];

export const DEFAULT_SIZE = 24;
export const DEFAULT_COLOR = "#1e293b";
export const LINE_HEIGHT = 1.2;
/** The largest font size: the precision budget of docs/adr/0001, section 7. */
export const MAX_SIZE = 2 ** 46;

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface TextModel {
  readonly text: YTextValue;
  /** As stored: may be a family this version does not know. */
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: Color;
  /** As stored: may be an alignment this version does not know. */
  readonly align: string;
}

export const EMPTY_TEXT: YTextValue = { $y: "text", delta: [] };

export function isTextColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

export function isFontSize(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SIZE
  );
}

function isText(value: unknown): value is YTextValue {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { $y?: unknown }).$y === "text" &&
    Array.isArray((value as { delta?: unknown }).delta)
  );
}

function own(data: ElementData, key: string): DataValue | undefined {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

/** Reads a text box's data; total, as an element type's reader must be. */
export function readText(data: ElementData, report: DataReport): TextModel {
  const text = own(data, "text");
  if (text !== undefined && !isText(text))
    report("text", "must be shared text, read as empty");
  const family = own(data, "fontFamily");
  if (family !== undefined && !(typeof family === "string" && NAME_PATTERN.test(family)))
    report("fontFamily", "must be a family name, read as sans");
  const size = own(data, "fontSize");
  if (size !== undefined && !isFontSize(size))
    report("fontSize", `must be a number above 0, read as ${DEFAULT_SIZE}`);
  const color = own(data, "color");
  if (color !== undefined && !isTextColor(color))
    report("color", "must be #rrggbb or #rrggbbaa");
  const align = own(data, "align");
  if (align !== undefined && !(typeof align === "string" && NAME_PATTERN.test(align)))
    report("align", "must be an alignment, read as left");
  return {
    text: isText(text) ? text : EMPTY_TEXT,
    fontFamily: typeof family === "string" && NAME_PATTERN.test(family) ? family : "sans",
    fontSize: isFontSize(size) ? size : DEFAULT_SIZE,
    color: isTextColor(color) ? color.toLowerCase() : DEFAULT_COLOR,
    align: typeof align === "string" && NAME_PATTERN.test(align) ? align : "left",
  };
}

/** The alignment drawn: an unknown one as left. */
export function drawnAlign(model: TextModel): Align {
  return (ALIGNS as readonly string[]).includes(model.align)
    ? (model.align as Align)
    : "left";
}

/** Whether a value is one this version writes for a style key. */
export function isStyleValue(key: string, value: unknown): boolean {
  switch (key) {
    case "fontFamily":
      return (FAMILIES as readonly unknown[]).includes(value);
    case "align":
      return (ALIGNS as readonly unknown[]).includes(value);
    case "fontSize":
      return isFontSize(value);
    case "color":
      return isTextColor(value);
    default:
      return false;
  }
}

export const STYLE_KEYS: readonly string[] = ["fontFamily", "fontSize", "color", "align"];

/** The data of a new text box. */
export function newTextData(options: {
  readonly text?: string;
  readonly fontSize?: number;
  readonly fontFamily?: Family;
  readonly color?: string;
  readonly align?: Align;
}): ElementData {
  const content = (options.text ?? "").replace(/\r\n?/g, "\n");
  return {
    text: {
      $y: "text",
      delta: [{ insert: content.endsWith("\n") ? content : `${content}\n` }],
    },
    fontFamily: options.fontFamily ?? "sans",
    fontSize: options.fontSize ?? DEFAULT_SIZE,
    color: (options.color ?? DEFAULT_COLOR).toLowerCase(),
    align: options.align ?? "left",
  };
}
