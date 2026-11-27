// SPDX-License-Identifier: GPL-3.0-or-later

// What commands use to create and change elements of an extension's types,
// with the type's rules applied: data checked by the type's own reader,
// references kept in `refs`, layouts upgraded on edit, and content edits
// refused for placeholders. See docs/adr/0005-extension-interface.md, section 3.

import {
  InvalidDocumentError,
  Problems,
  envelopeField,
  type ElementData,
  type ElementId,
} from "@galatsa/core";
import {
  addElement,
  dataMap,
  edit,
  roots,
  setData,
  setRefs,
  setTypeVersion,
  valueFromY,
  type NewElement,
} from "@galatsa/core/ydoc";
import * as Y from "yjs";
import type { CommandContext } from "./command.ts";
import type { AnyElementType, ElementCapabilities } from "./element-type.ts";
import type { ElementFacts } from "./host.ts";

/** Problems the type's reader reports for `data`, as "path: problem" lines. */
export function dataProblems(
  type: AnyElementType,
  data: ElementData,
  typeVersion: number = type.typeVersion,
): string[] {
  const problems: string[] = [];
  try {
    type.read(data, typeVersion, (path, problem) => problems.push(`${path}: ${problem}`));
  } catch (error) {
    problems.push(`read threw: ${String(error)}`);
  }
  return problems;
}

function modelOf(type: AnyElementType, data: ElementData): unknown {
  return type.read(data, type.typeVersion, () => {});
}

/** An element's type and data layout version, read from the document. */
export function elementFacts(
  ctx: Pick<CommandContext, "doc">,
  id: ElementId,
): ElementFacts {
  const map = roots(ctx.doc).elements.get(id);
  if (!(map instanceof Y.Map)) throw new Error(`No element ${id}`);
  const type = envelopeField.type(map.get("type"));
  if (type === null) throw new Error(`Element ${id} has no valid type`);
  return {
    type,
    typeVersion: envelopeField.typeVersion(map.get("typeVersion"), new Problems(0)),
  };
}

/** What the user may do to an element of the document. */
export function capabilitiesOf(ctx: CommandContext, id: ElementId): ElementCapabilities {
  return ctx.extensions.capabilities(elementFacts(ctx, id));
}

/** An element's data in its JSON form. */
export function readData(ctx: Pick<CommandContext, "doc">, id: ElementId): ElementData {
  const out: ElementData = {};
  for (const [key, value] of dataMap(ctx.doc, id).entries()) {
    Object.defineProperty(out, key, {
      value: valueFromY(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export type NewTypedElement = Omit<
  NewElement,
  "type" | "typeVersion" | "refs" | "data"
> & {
  /** The element type id, "<extension id>/<name>". */
  readonly type: string;
  readonly data: ElementData;
};

/**
 * Creates an element of a loaded type, in the type's current layout, after
 * checking its data with the type's reader; `refs` is set from the type's
 * `references`. Throws InvalidDocumentError if the data does not read cleanly.
 */
export function insertElement(ctx: CommandContext, init: NewTypedElement): ElementId {
  const type = ctx.extensions.elementType(init.type);
  if (!type) throw new Error(`Element type ${init.type} is not loaded`);
  const problems = dataProblems(type, init.data);
  if (problems.length > 0) throw new InvalidDocumentError("data", problems);
  const refs = [...(type.references?.(modelOf(type, init.data)) ?? [])];
  return addElement(ctx.doc, { ...init, typeVersion: type.typeVersion, refs });
}

/**
 * Changes keys of an element's data, the way every content edit must: refused
 * if the element's type is not loaded or is older than the element; data in an
 * older layout is upgraded in the same transaction; the result is checked with
 * the type's reader before anything is written; `refs` follows the type's
 * `references`. `writes` gets the current data and returns the keys to set.
 */
export function updateElementData(
  ctx: CommandContext,
  id: ElementId,
  writes: ElementData | ((data: ElementData) => ElementData),
): void {
  const facts = elementFacts(ctx, id);
  if (!ctx.extensions.capabilities(facts).editContent)
    throw new Error(`The content of element ${id} cannot be edited here`);
  const type = ctx.extensions.elementType(facts.type)!;
  const current = readData(ctx, id);
  const upgrades =
    facts.typeVersion < type.typeVersion
      ? (type.upgrade?.(current, facts.typeVersion) ?? {})
      : {};
  const upgraded = { ...current, ...upgrades };
  const changes = typeof writes === "function" ? writes(upgraded) : writes;
  const next = { ...upgraded, ...changes };
  const problems = dataProblems(type, next);
  if (problems.length > 0) throw new InvalidDocumentError("data", problems);
  const refs = type.references?.(modelOf(type, next));
  edit(ctx.doc, () => {
    for (const [key, value] of Object.entries(upgrades)) setData(ctx.doc, id, key, value);
    for (const [key, value] of Object.entries(changes)) setData(ctx.doc, id, key, value);
    if (facts.typeVersion < type.typeVersion)
      setTypeVersion(ctx.doc, id, type.typeVersion);
    if (refs !== undefined) setRefs(ctx.doc, id, [...refs]);
  });
}
