// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the text extension: a text box whose content is shared rich text,
// edited in place through the renderer, with style properties, a tool that
// places a box and starts editing, a panel for the default font size, and an
// exporter of all text as a plain outline. Data layout version 2; version 1
// had no font family and alignment, and is upgraded when the user edits such
// an element.

import {
  Resolver,
  lookupFromRecord,
  type ElementData,
  type ElementId,
  type YTextValue,
} from "@galatsa/core";
import { roots, setSetting } from "@galatsa/core/ydoc";
import {
  defineCommand,
  defineElementType,
  defineExtension,
  insertElement,
  throwIfCancelled,
  updateElementData,
  capabilitiesOf,
  elementFacts,
  type CommandContext,
  type ExporterDefinition,
  type FieldDefinition,
  type TextStyle,
} from "@galatsa/extension-api";
import {
  API,
  label,
  readChoice,
  readColor,
  readFieldChange,
  readNumber,
} from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const TEXT_EXTENSION = "examples.text";
export const TEXT_TYPE = `${TEXT_EXTENSION}/text`;
export const TEXT_INSERT = `${TEXT_EXTENSION}/insert`;
export const TEXT_SET_STYLE = `${TEXT_EXTENSION}/set-style`;
export const TEXT_SET_DEFAULT = `${TEXT_EXTENSION}/set-default`;
/** Document setting with the font size of new text boxes. */
export const DEFAULT_SIZE_SETTING = `${TEXT_EXTENSION}.defaultFontSize`;

/** Font families by generic name; the renderer maps them to the fonts it bundles. */
const FAMILIES = ["sans", "serif"] as const;
const ALIGNS = ["left", "center", "right"] as const;

export interface TextModel {
  readonly text: YTextValue;
  readonly fontSize: number;
  readonly color: string;
  readonly fontFamily: (typeof FAMILIES)[number];
  readonly align: (typeof ALIGNS)[number];
}

const EMPTY_TEXT: YTextValue = { $y: "text", delta: [] };
const DEFAULT_SIZE = 24;
const DEFAULT_COLOR = "#1e293b";
const LINE_HEIGHT = 1.2;

function isText(value: unknown): value is YTextValue {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { $y?: unknown }).$y === "text" &&
    Array.isArray((value as { delta?: unknown }).delta)
  );
}

function styleOf(model: TextModel): TextStyle {
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

export const textType = defineElementType<TextModel>({
  name: "text",
  label: label("text.name"),
  typeVersion: 2,
  read(data, typeVersion, report) {
    const text = Object.hasOwn(data, "text") ? data["text"] : undefined;
    if (!isText(text)) report("text", "must be shared text, read as empty");
    return {
      text: isText(text) ? text : EMPTY_TEXT,
      fontSize: readNumber(data, "fontSize", DEFAULT_SIZE, report, {
        min: 0.01,
        max: 1e6,
      }),
      color: readColor(data, "color", DEFAULT_COLOR, report) ?? DEFAULT_COLOR,
      // Version 1 had neither key: its text was always left-aligned sans serif.
      fontFamily:
        typeVersion < 2
          ? "sans"
          : readChoice(data, "fontFamily", FAMILIES, "sans", report),
      align: typeVersion < 2 ? "left" : readChoice(data, "align", ALIGNS, "left", report),
    };
  },
  upgrade(_data, from) {
    // Adds the keys version 2 introduced, with what version 1 implied.
    return from < 2 ? { fontFamily: "sans", align: "left" } : {};
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
  textEditing(model, box) {
    return {
      key: "text",
      style: styleOf(model),
      box: { x: 0, y: 0, w: box.w, h: box.h },
      autoHeight: true,
    };
  },
  properties: [
    {
      key: "fontSize",
      label: label("text.font-size"),
      quick: true,
      control: { kind: "number", min: 1, max: 1000, step: 1 },
      get: (m) => m.fontSize,
      command: TEXT_SET_STYLE,
    },
    {
      key: "color",
      label: label("text.color"),
      quick: true,
      control: { kind: "color" },
      get: (m) => m.color,
      command: TEXT_SET_STYLE,
    },
    {
      key: "align",
      label: label("text.align"),
      quick: true,
      control: {
        kind: "select",
        options: ALIGNS.map((value) => ({ value, label: label(`text.align.${value}`) })),
      },
      get: (m) => m.align,
      command: TEXT_SET_STYLE,
    },
    {
      key: "fontFamily",
      label: label("text.font-family"),
      control: {
        kind: "select",
        options: FAMILIES.map((value) => ({ value, label: label(`text.font.${value}`) })),
      },
      get: (m) => m.fontFamily,
      command: TEXT_SET_STYLE,
    },
  ],
});

function defaultSize(ctx: CommandContext): number {
  const value = roots(ctx.doc).settings.get(DEFAULT_SIZE_SETTING);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SIZE;
}

export interface InsertTextArgs {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly text?: string;
  readonly parent?: ElementId | null;
}

const insertText = defineCommand<InsertTextArgs | undefined, ElementId>({
  name: "insert",
  label: label("text.insert"),
  quick: true,
  execute(ctx, args) {
    const fontSize = defaultSize(ctx);
    const content = args?.text ?? "";
    const w = args?.w ?? fontSize * 10;
    const h = Math.max(1, content.split("\n").length) * fontSize * LINE_HEIGHT;
    const view = ctx.viewport;
    const data: ElementData = {
      text: { $y: "text", delta: content === "" ? [] : [{ insert: content }] },
      fontSize,
      color: DEFAULT_COLOR,
      fontFamily: "sans",
      align: "left",
    };
    return insertElement(ctx, {
      type: TEXT_TYPE,
      parent: args?.parent ?? null,
      x: args?.x ?? (view ? view.x + view.w / 2 - w / 2 : 0),
      y: args?.y ?? (view ? view.y + view.h / 2 - h / 2 : 0),
      size: { w, h },
      data,
    });
  },
});

const STYLE_KEYS = new Set(["fontSize", "color", "align", "fontFamily"]);

/** True if every id is a text element whose content may be edited. */
function allEditableText(ctx: CommandContext, ids: readonly ElementId[]): boolean {
  return (
    ids.length > 0 &&
    ids.every(
      (id) =>
        elementFacts(ctx, id).type === TEXT_TYPE && capabilitiesOf(ctx, id).editContent,
    )
  );
}

const setStyle = defineCommand<unknown, void>({
  name: "set-style",
  label: label("text.set-style"),
  quick: true,
  enabled(ctx, args) {
    const change = readFieldChange(args);
    return (
      change !== undefined &&
      STYLE_KEYS.has(change.key) &&
      allEditableText(ctx, change.ids)
    );
  },
  execute(ctx, args) {
    const change = readFieldChange(args)!;
    for (const id of change.ids)
      updateElementData(ctx, id, { [change.key]: change.value });
  },
});

const setDefault = defineCommand<unknown, void>({
  name: "set-default",
  label: label("text.set-default"),
  enabled: (_ctx, args) => {
    const change = readFieldChange(args);
    return typeof change?.value === "number" && change.value > 0;
  },
  execute(ctx, args) {
    setSetting(ctx.doc, DEFAULT_SIZE_SETTING, readFieldChange(args)!.value);
  },
});

const defaultsField: FieldDefinition<CommandContext> = {
  key: "defaultFontSize",
  label: label("text.default-size"),
  control: { kind: "number", min: 1, max: 1000, step: 1 },
  get: (ctx) => defaultSize(ctx),
  command: TEXT_SET_DEFAULT,
};

/** Minimal UTF-8 encoder: the interface is environment-agnostic, so no TextEncoder type. */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const c = char.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000)
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }
  return Uint8Array.from(bytes);
}

const outlineExporter: ExporterDefinition = {
  name: "outline",
  label: label("text.outline"),
  fileType: {
    label: label("text.file-type.txt"),
    mediaTypes: ["text/plain"],
    extensions: ["txt"],
  },
  async write(input, output, context) {
    const { snapshot, selection } = input;
    const order = new Resolver(lookupFromRecord(snapshot.elements)).drawOrder();
    const chosen = selection === null ? undefined : new Set(selection);
    const parts: string[] = [];
    order.forEach((id, i) => {
      throwIfCancelled(context.cancellation);
      const element = snapshot.elements[id]!;
      if (element.type !== TEXT_TYPE || (chosen && !chosen.has(id))) return;
      if (element.typeVersion > textType.typeVersion) return;
      const model = textType.read(element.data, element.typeVersion, () => {});
      parts.push(plainText(model.text));
      context.progress((i + 1) / order.length);
    });
    await output.write(utf8(parts.join("\n\n")));
    return { notices: [] };
  },
};

export const textExtension = defineExtension({
  id: TEXT_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
  contributes: {
    elementTypes: [textType],
    commands: [insertText, setStyle, setDefault],
    tools: [
      {
        name: "text",
        label: label("text.tool"),
        shortcuts: ["t"],
        quick: true,
        group: "insert",
        cursor: "text",
        start(session) {
          return {
            pointerDown(event) {
              const outcome = session.run<ElementId>(TEXT_INSERT, {
                x: event.world.x,
                y: event.world.y,
              });
              if (outcome.ok) session.editText(outcome.value);
              session.done();
            },
          };
        },
      },
    ],
    exporters: [outlineExporter],
    panels: [
      {
        name: "defaults",
        label: label("text.defaults"),
        location: "side",
        content: { kind: "fields", fields: [defaultsField] },
      },
    ],
  },
});
