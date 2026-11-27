// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the text extension, editing part: in-place editing through the
// renderer, style properties, bold for the selected text, a tool that places a
// box and starts editing, a panel for the default font size, and an exporter of
// all text as a plain outline.

import {
  Resolver,
  lookupFromRecord,
  type ElementData,
  type ElementId,
} from "@galatsa/core";
import { dataMap, edit, roots, setSetting } from "@galatsa/core/ydoc";
import {
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  throwIfCancelled,
  updateElementData,
  type CommandContext,
  type ExporterDefinition,
  type FieldDefinition,
} from "@galatsa/extension-api/editing";
import * as Y from "yjs";
import { label, readFieldChange } from "./common.ts";
import {
  ALIGNS,
  DEFAULT_COLOR,
  DEFAULT_SIZE,
  FAMILIES,
  LINE_HEIGHT,
  TEXT_EXTENSION,
  TEXT_TYPE,
  plainText,
  styleOf,
  textView,
  textViewExtension,
} from "./text-view.ts";

export * from "./text-view.ts";

export const TEXT_INSERT = `${TEXT_EXTENSION}/insert`;
export const TEXT_SET_STYLE = `${TEXT_EXTENSION}/set-style`;
export const TEXT_SET_DEFAULT = `${TEXT_EXTENSION}/set-default`;
export const TEXT_TOGGLE_BOLD = `${TEXT_EXTENSION}/toggle-bold`;
/** Document setting with the font size of new text boxes. */
export const DEFAULT_SIZE_SETTING = `${TEXT_EXTENSION}.defaultFontSize`;

export const textEditing = defineElementEditing(textView, {
  // No upgrade function: version 2 only added keys, whose defaults mean what
  // version 1 implied. The host raises the version before the first edit.
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
    const view = ctx.services.camera.viewport();
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
      x: args?.x ?? view.x + view.w / 2 - w / 2,
      y: args?.y ?? view.y + view.h / 2 - h / 2,
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

/** The shared text being edited and the selected range, if bold can apply. */
function editedRange(
  ctx: CommandContext,
): { text: Y.Text; index: number; length: number } | undefined {
  const state = ctx.services.text.current();
  if (state === null || state.length === 0) return undefined;
  if (!allEditableText(ctx, [state.id])) return undefined;
  const text = dataMap(ctx.doc, state.id).get(state.key);
  return text instanceof Y.Text
    ? { text, index: state.index, length: state.length }
    : undefined;
}

/** True if every character in the range is bold. */
function allBold(text: Y.Text, index: number, length: number): boolean {
  let at = 0;
  for (const run of text.toDelta() as Array<{ insert: unknown; attributes?: object }>) {
    const size = typeof run.insert === "string" ? run.insert.length : 1;
    const overlaps = at < index + length && at + size > index;
    if (overlaps && (run.attributes as { bold?: unknown } | undefined)?.bold !== true)
      return false;
    at += size;
  }
  return true;
}

/**
 * Bold for the selected text, through the editor's text service: the command
 * formats the shared text in place, as one undo step separate from the typing
 * before it.
 */
const toggleBold = defineCommand<undefined, void>({
  name: "toggle-bold",
  label: label("text.bold"),
  shortcuts: ["Mod+B"],
  quick: true,
  enabled: (ctx) => editedRange(ctx) !== undefined,
  execute(ctx) {
    const { text, index, length } = editedRange(ctx)!;
    const bold = allBold(text, index, length) ? null : true;
    edit(ctx.doc, () => text.format(index, length, { bold }));
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
      if (element.typeVersion > textView.typeVersion) return;
      const model = textView.read(element.data, element.typeVersion, () => {});
      parts.push(plainText(model.text));
      context.progress((i + 1) / order.length);
    });
    await output.write(utf8(parts.join("\n\n")));
    return { notices: [] };
  },
};

export const textExtension = defineEditExtension({
  view: textViewExtension,
  contributes: {
    elementTypes: [textEditing],
    commands: [insertText, setStyle, toggleBold, setDefault],
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
