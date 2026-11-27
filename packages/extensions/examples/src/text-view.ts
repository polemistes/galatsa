// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the text extension, viewing part: the model, how a text box reads
// its data and draws. Data layout version 2; version 1 had no font family and
// alignment. Version 2's defaults for those keys are what version 1 implied
// (sans serif, left), so a missing key reads the same in either version and no
// data needs rewriting when an element is upgraded.

import type { YTextValue } from "@galatsa/core";
import {
  defineElementView,
  defineViewExtension,
  type TextStyle,
} from "@galatsa/extension-api";
import { API, label, readChoice, readColor, readNumber } from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const TEXT_EXTENSION = "examples.text";
export const TEXT_TYPE = `${TEXT_EXTENSION}/text`;

/** Font families by generic name; the renderer maps them to the fonts it bundles. */
export const FAMILIES = ["sans", "serif"] as const;
export const ALIGNS = ["left", "center", "right"] as const;

export interface TextModel {
  readonly text: YTextValue;
  readonly fontSize: number;
  readonly color: string;
  readonly fontFamily: (typeof FAMILIES)[number];
  readonly align: (typeof ALIGNS)[number];
}

const EMPTY_TEXT: YTextValue = { $y: "text", delta: [] };
export const DEFAULT_SIZE = 24;
export const DEFAULT_COLOR = "#1e293b";
export const LINE_HEIGHT = 1.2;

function isText(value: unknown): value is YTextValue {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { $y?: unknown }).$y === "text" &&
    Array.isArray((value as { delta?: unknown }).delta)
  );
}

export function styleOf(model: TextModel): TextStyle {
  return {
    fontFamily: model.fontFamily,
    fontSize: model.fontSize,
    color: model.color,
    align: model.align,
    lineHeight: LINE_HEIGHT,
  };
}

/** The text as plain characters (embeds left out). */
export function plainText(text: YTextValue): string {
  return text.delta
    .map((run) => (typeof run.insert === "string" ? run.insert : ""))
    .join("");
}

export const textView = defineElementView<TextModel>({
  name: "text",
  label: label("text.name"),
  typeVersion: 2,
  read(data, _typeVersion, report) {
    const text = Object.hasOwn(data, "text") ? data["text"] : undefined;
    if (text !== undefined && !isText(text))
      report("text", "must be shared text, read as empty");
    return {
      text: isText(text) ? text : EMPTY_TEXT,
      fontSize: readNumber(data, "fontSize", DEFAULT_SIZE, report, {
        min: 0.01,
        max: 1e6,
      }),
      color: readColor(data, "color", DEFAULT_COLOR, report) ?? DEFAULT_COLOR,
      fontFamily: readChoice(data, "fontFamily", FAMILIES, "sans", report),
      align: readChoice(data, "align", ALIGNS, "left", report),
    };
  },
  draw(model, ctx, box) {
    if (ctx.detail === "box") {
      // A few pixels tall: a faint bar in the text colour stands in for the text.
      const bar = ctx.createPath();
      bar.rect(0, 0, box.w, Math.min(box.h, model.fontSize));
      ctx.withOpacity(0.3, () => ctx.fill(bar, model.color));
      return;
    }
    const layout = ctx.layoutText(model.text, styleOf(model), box.w);
    ctx.drawText(layout, 0, 0);
  },
});

export const textViewExtension = defineViewExtension({
  id: TEXT_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
  elementTypes: [textView],
});
