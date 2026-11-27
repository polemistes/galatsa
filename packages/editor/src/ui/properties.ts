// SPDX-License-Identifier: GPL-3.0-or-later

// What the properties panel shows (docs/adr/0005, section 3.9; docs/adr/0016):
// for the selected elements, one section per element type with the fields
// that type offers in the current mode and that apply to every selected
// element of it (`applies`), each with its value or a mixed state when the
// elements differ. A change runs the field's command with a FieldChange, so
// it is one undo step; a colour being dragged is previewed through a gesture
// and committed once.
//
// Plain TypeScript over the editor, tested in Node; Properties.svelte draws it.

import type { ElementId, Json } from "@galatsa/core";
import type { Label } from "@galatsa/extension-api";
import {
  elementFacts,
  readData,
  type CommandOutcome,
  type Control,
  type FieldChange,
  type FieldDefinition,
  type Gesture,
} from "@galatsa/extension-api/editing";
import type { Editor } from "../editor.ts";

export interface PropertyField {
  readonly key: string;
  readonly label: Label;
  readonly control: Control;
  readonly command: string;
  /** The elements the field is shown for. */
  readonly ids: readonly ElementId[];
  /** The value of the first element (the one shown when the values differ). */
  readonly value: Json;
  /** The elements' values differ. */
  readonly mixed: boolean;
}

export interface PropertySection {
  /** The element type id. */
  readonly type: string;
  readonly label: Label;
  readonly ids: readonly ElementId[];
  readonly fields: readonly PropertyField[];
}

/** More selected elements than this are not read for the panel (select all on a large canvas). */
export const PROPERTIES_LIMIT = 500;

function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The panel's sections for the selection now; empty when nothing selected has fields. */
export function propertiesModel(editor: Editor): PropertySection[] {
  // While a text is edited in place it is outlined, not selected; its
  // properties are shown all the same.
  const editing = editor.services.text.current();
  const selection =
    editor.selection.length === 0 && editing !== null ? [editing.id] : editor.selection;
  if (selection.length === 0 || selection.length > PROPERTIES_LIMIT) return [];
  const ctx = { doc: editor.doc };
  const byType = new Map<string, { ids: ElementId[]; models: unknown[] }>();
  for (const id of selection) {
    let type: string;
    let model: unknown;
    try {
      const facts = elementFacts(ctx, id);
      const registered = editor.host.elementType(facts.type);
      if (registered?.editing === undefined) continue;
      type = registered.id;
      model = registered.view.read(readData(ctx, id), facts.typeVersion, () => {});
    } catch {
      continue;
    }
    const entry = byType.get(type);
    if (entry === undefined) byType.set(type, { ids: [id], models: [model] });
    else {
      entry.ids.push(id);
      entry.models.push(model);
    }
  }
  const sections: PropertySection[] = [];
  for (const [type, { ids, models }] of byType) {
    const registered = editor.host.elementType(type)!;
    const fields: PropertyField[] = [];
    for (const field of editor.host.properties(type, editor.mode)) {
      const shown = readField(field, models);
      if (shown !== null) fields.push({ ...describe(field), ids, ...shown });
    }
    if (fields.length > 0)
      sections.push({ type, label: registered.view.label, ids, fields });
  }
  return sections;
}

function describe(field: FieldDefinition<unknown>) {
  return {
    key: field.key,
    label: field.label,
    control: field.control,
    command: field.command,
  };
}

/** The field's value over the models, or null when it does not apply to all of them. */
function readField(
  field: FieldDefinition<unknown>,
  models: readonly unknown[],
): { value: Json; mixed: boolean } | null {
  try {
    if (field.applies !== undefined && !models.every((m) => field.applies!(m)))
      return null;
    const values = models.map((m) => field.get(m));
    const first = values[0] ?? null;
    return { value: first, mixed: values.some((v) => !same(v, first)) };
  } catch {
    return null;
  }
}

/** Runs the field's command with the new value: one undo step. */
export function changeField(
  editor: Editor,
  field: PropertyField,
  value: Json,
): CommandOutcome {
  const change: FieldChange = { ids: [...field.ids], key: field.key, value };
  return editor.run(field.command, change);
}

/**
 * A continuous change (a colour being dragged): `preview` shows each value
 * without changing the document, `commit` runs the field's command once with
 * the last value, `cancel` drops it.
 */
export class FieldGesture {
  readonly #editor: Editor;
  readonly #field: PropertyField;
  #gesture: Gesture | null = null;
  #last: Json | undefined;

  constructor(editor: Editor, field: PropertyField) {
    this.#editor = editor;
    this.#field = field;
  }

  preview(value: Json): void {
    this.#last = value;
    this.#gesture ??= this.#editor.host.commands.beginGesture(this.#editor.environment());
    if (!this.#gesture.active) return;
    const changes: { [id: ElementId]: { data: { [key: string]: Json } } } = {};
    for (const id of this.#field.ids) changes[id] = { data: { [this.#field.key]: value } };
    this.#gesture.preview(changes);
  }

  commit(value?: Json): CommandOutcome | null {
    const final = value ?? this.#last;
    const gesture = this.#gesture;
    this.#gesture = null;
    if (final === undefined) {
      gesture?.cancel();
      return null;
    }
    const change: FieldChange = { ids: [...this.#field.ids], key: this.#field.key, value: final };
    if (gesture === null || !gesture.active) return this.#editor.run(this.#field.command, change);
    return gesture.commit(this.#field.command, change);
  }

  cancel(): void {
    this.#gesture?.cancel();
    this.#gesture = null;
  }
}
