// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-text: text boxes, with their editing part. A text box is
// shared rich text in a box whose width breaks the lines and whose height
// follows the text. The renderer lays it out and edits it in place; this
// extension says where (textEditing), and formats it: font, size, colour and
// alignment for the box, bold and italic for characters, lists for
// paragraphs. A viewer imports "@galatsa/extension-text/view". See
// docs/adr/0011-text.md.

import type { ElementId, Json } from "@galatsa/core";
import { dataMap, edit } from "@galatsa/core/ydoc";
import {
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  updateElementData,
  type CommandContext,
  type EditExtension,
  type FieldChange,
  type ToolDefinition,
} from "@galatsa/extension-api/editing";
import * as Y from "yjs";
import {
  allHave,
  allLists,
  formatChars,
  paragraphRanges,
  paragraphsIn,
  setLists,
  wordAt,
  type ListKind,
  type ParagraphRange,
} from "./format.ts";
import {
  ALIGNS,
  DEFAULT_SIZE,
  FAMILIES,
  LINE_HEIGHT,
  STYLE_KEYS,
  TEXT_EXTENSION,
  TEXT_TYPE,
  isStyleValue,
  newTextData,
  styleOf,
  textLabel,
  textView,
  textViewExtension,
  type Align,
  type Family,
} from "./view.ts";

export * from "./view.ts";
export {
  allHave,
  allLists,
  formatChars,
  paragraphRanges,
  paragraphsIn,
  setLists,
  wordAt,
  type ListKind,
  type ParagraphRange,
} from "./format.ts";

export const TEXT_COMMANDS = {
  insert: `${TEXT_EXTENSION}/insert`,
  setStyle: `${TEXT_EXTENSION}/set-style`,
  bold: `${TEXT_EXTENSION}/bold`,
  italic: `${TEXT_EXTENSION}/italic`,
  bullets: `${TEXT_EXTENSION}/bullets`,
  numbers: `${TEXT_EXTENSION}/numbers`,
} as const;

/** Font size of new text, in screen pixels at the zoom it is made at. */
export const NEW_TEXT_PIXELS = 24;
/** Width of new text, in font sizes. */
export const NEW_TEXT_WIDTH = 12;

/** A number rounded to three significant digits, for sizes made from a zoom. */
function tidy(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return DEFAULT_SIZE;
  const p = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Math.round(value / p) * p;
}

/** The font size a new text box gets at a zoom: NEW_TEXT_PIXELS on screen. */
export function fontSizeAt(zoom: number): number {
  return tidy(NEW_TEXT_PIXELS / (zoom > 0 && Number.isFinite(zoom) ? zoom : 1));
}

export const textEditing = defineElementEditing(textView, {
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
      label: textLabel("font-size"),
      quick: true,
      control: { kind: "number", min: 1, max: 1000, step: 1 },
      get: (m) => m.fontSize,
      command: TEXT_COMMANDS.setStyle,
    },
    {
      key: "color",
      label: textLabel("color"),
      quick: true,
      control: { kind: "color" },
      get: (m) => m.color,
      command: TEXT_COMMANDS.setStyle,
    },
    {
      key: "align",
      label: textLabel("align"),
      quick: true,
      control: {
        kind: "select",
        options: ALIGNS.map((value) => ({ value, label: textLabel(`align.${value}`) })),
      },
      get: (m) => m.align,
      command: TEXT_COMMANDS.setStyle,
    },
    {
      key: "fontFamily",
      label: textLabel("font-family"),
      quick: true,
      control: {
        kind: "select",
        options: FAMILIES.map((value) => ({ value, label: textLabel(`font.${value}`) })),
      },
      get: (m) => m.fontFamily,
      command: TEXT_COMMANDS.setStyle,
    },
  ],
});

/** True if every id is a text box whose content may be edited. */
function allEditableText(ctx: CommandContext, ids: readonly unknown[]): ids is ElementId[] {
  return (
    ids.length > 0 &&
    ids.every((id) => {
      if (typeof id !== "string") return false;
      try {
        return elementFacts(ctx, id).type === TEXT_TYPE && capabilitiesOf(ctx, id).editContent;
      } catch {
        return false;
      }
    })
  );
}

function sharedText(ctx: CommandContext, id: ElementId, key = "text"): Y.Text | null {
  try {
    const text = dataMap(ctx.doc, id).get(key);
    return text instanceof Y.Text ? text : null;
  } catch {
    return null;
  }
}

/** Ids from `{ ids }` arguments, or none. */
function idsOf(args: unknown): readonly unknown[] {
  if (args === null || typeof args !== "object") return [];
  const ids = (args as { ids?: unknown }).ids;
  return Array.isArray(ids) ? ids : [];
}

/** Where a formatting command acts: a range of one shared text each. */
interface Target {
  readonly id: ElementId;
  readonly text: Y.Text;
  readonly index: number;
  readonly length: number;
  /** The whole text of a box that is not being edited. */
  readonly whole: boolean;
}

/**
 * The text a formatting command acts on: while a text box is edited in place,
 * its selection (for characters, the word at the caret when nothing is
 * selected); otherwise the whole text of each text box in `{ ids }`.
 */
function targets(ctx: CommandContext, args: unknown, chars: boolean): Target[] {
  const state = ctx.services.text.current();
  if (state !== null) {
    if (!allEditableText(ctx, [state.id])) return [];
    const text = sharedText(ctx, state.id, state.key);
    if (text === null) return [];
    let { index, length } = state;
    if (chars && length === 0) {
      const word = wordAt(text.toString(), index);
      if (word === null) return [];
      ({ index, length } = word);
    }
    return [{ id: state.id, text, index, length, whole: false }];
  }
  const ids = idsOf(args);
  if (!allEditableText(ctx, ids)) return [];
  const out: Target[] = [];
  for (const id of ids) {
    const text = sharedText(ctx, id);
    if (text === null) return [];
    out.push({ id, text, index: 0, length: text.length, whole: true });
  }
  return out;
}

function charToggle(name: "bold" | "italic", shortcut: string) {
  return defineCommand<unknown, void>({
    name,
    label: textLabel(name),
    undoLabel: textLabel(`${name}.step`),
    shortcuts: [shortcut],
    quick: true,
    enabled: (ctx, args) =>
      targets(ctx, args, true).some((t) => /[^\n]/.test(t.text.toString().slice(t.index, t.index + t.length))),
    execute(ctx, args) {
      const list = targets(ctx, args, true);
      const on = !list.every((t) => allHave(t.text, t.index, t.length, name));
      edit(ctx.doc, () => {
        for (const t of list) formatChars(t.text, t.index, t.length, { [name]: on ? true : null });
      });
    },
  });
}

function paragraphsOf(t: Target): ParagraphRange[] {
  const text = t.text.toString();
  return t.whole ? paragraphRanges(text) : paragraphsIn(text, t.index, t.length);
}

function listToggle(name: "bullets" | "numbers", kind: ListKind, shortcut: string) {
  return defineCommand<unknown, void>({
    name,
    label: textLabel(name),
    undoLabel: textLabel(`${name}.step`),
    shortcuts: [shortcut],
    quick: true,
    enabled: (ctx, args) => targets(ctx, args, false).length > 0,
    execute(ctx, args) {
      const list = targets(ctx, args, false).map((t) => ({ t, paragraphs: paragraphsOf(t) }));
      const off = list.every(({ t, paragraphs }) => allLists(t.text, paragraphs, kind));
      edit(ctx.doc, () => {
        for (const { t, paragraphs } of list) setLists(t.text, paragraphs, off ? null : kind);
      });
    },
  });
}

/** Arguments of a field's command, checked. */
function readFieldChange(args: unknown): FieldChange | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const { ids, key, value } = args as Partial<FieldChange>;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  if (typeof key !== "string" || value === undefined) return undefined;
  return { ids, key, value: value as Json };
}

const setStyle = defineCommand<unknown, void>({
  name: "set-style",
  label: textLabel("set-style"),
  undoLabel: textLabel("set-style.step"),
  quick: true,
  enabled(ctx, args) {
    const change = readFieldChange(args);
    if (change === undefined || !STYLE_KEYS.includes(change.key)) return false;
    if (!isStyleValue(change.key, change.value) || !allEditableText(ctx, change.ids)) return false;
    // A change that changes nothing is not offered.
    const value = change.key === "color" ? String(change.value).toLowerCase() : change.value;
    return change.ids.some((id) => dataMap(ctx.doc, id).get(change.key) !== value);
  },
  execute(ctx, args) {
    const change = readFieldChange(args)!;
    const value = change.key === "color" ? String(change.value).toLowerCase() : change.value;
    for (const id of change.ids)
      if (dataMap(ctx.doc, id).get(change.key) !== value)
        updateElementData(ctx, id, { [change.key]: value });
  },
});

export interface InsertTextArgs {
  /** Top-left corner of the box, in the parent's space (default: the middle of the view). */
  readonly x?: number;
  readonly y?: number;
  /** Width of the box; default NEW_TEXT_WIDTH font sizes. */
  readonly w?: number;
  readonly text?: string;
  readonly fontSize?: number;
  readonly fontFamily?: Family;
  readonly color?: string;
  readonly align?: Align;
  readonly parent?: ElementId | null;
}

function readInsert(args: unknown): InsertTextArgs | null {
  if (args === undefined) return {};
  if (args === null || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const finite = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isFinite(v));
  if (!finite(a["x"]) || !finite(a["y"])) return null;
  if (a["w"] !== undefined && !(typeof a["w"] === "number" && Number.isFinite(a["w"]) && a["w"] > 0)) return null;
  if (a["text"] !== undefined && typeof a["text"] !== "string") return null;
  for (const key of STYLE_KEYS)
    if (a[key] !== undefined && !isStyleValue(key, a[key])) return null;
  if (a["parent"] !== undefined && a["parent"] !== null && typeof a["parent"] !== "string") return null;
  return a as InsertTextArgs;
}

const insertText = defineCommand<unknown, ElementId>({
  name: "insert",
  label: textLabel("insert"),
  undoLabel: textLabel("insert.step"),
  quick: true,
  enabled: (_ctx, args) => readInsert(args) !== null,
  execute(ctx, args) {
    const a = readInsert(args)!;
    const fontSize = a.fontSize ?? fontSizeAt(ctx.services.camera.get().zoom);
    const text = a.text ?? "";
    const w = a.w ?? fontSize * NEW_TEXT_WIDTH;
    const lines = text.replace(/\n$/, "").split("\n").length;
    const h = lines * fontSize * LINE_HEIGHT;
    const view = ctx.services.camera.viewport();
    return insertElement(ctx, {
      type: TEXT_TYPE,
      parent: a.parent ?? null,
      x: a.x ?? view.x + view.w / 2 - w / 2,
      y: a.y ?? view.y + view.h / 2 - h / 2,
      size: { w, h },
      data: newTextData({
        text,
        fontSize,
        ...(a.fontFamily !== undefined ? { fontFamily: a.fontFamily } : {}),
        ...(a.color !== undefined ? { color: a.color } : {}),
        ...(a.align !== undefined ? { align: a.align } : {}),
      }),
    });
  },
});

/**
 * The text tool: a click makes a text box there (its first line centred on
 * the pointer) and starts editing it. The box is made as the button goes
 * down; a pinch that turns out to have started with it takes it back.
 */
const textTool: ToolDefinition = {
  name: "text",
  label: textLabel("tool"),
  shortcuts: ["t"],
  quick: true,
  group: "insert",
  cursor: "text",
  start(session) {
    return {
      pointerDown(event) {
        if (event.button !== 0) return;
        const fontSize = fontSizeAt(session.environment().services.camera.get().zoom);
        const outcome = session.run<ElementId>(TEXT_COMMANDS.insert, {
          x: event.world.x,
          y: event.world.y - (fontSize * LINE_HEIGHT) / 2,
          fontSize,
        } satisfies InsertTextArgs);
        if (outcome.ok) session.editText(outcome.value);
        session.done();
      },
    };
  },
};

export const textExtension: EditExtension = defineEditExtension({
  view: textViewExtension,
  contributes: {
    elementTypes: [textEditing],
    commands: [
      insertText,
      setStyle,
      charToggle("bold", "Mod+B"),
      charToggle("italic", "Mod+I"),
      listToggle("bullets", "bullet", "Mod+Shift+8"),
      listToggle("numbers", "ordered", "Mod+Shift+7"),
    ],
    tools: [textTool],
  },
});
