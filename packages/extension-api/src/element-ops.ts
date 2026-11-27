// SPDX-License-Identifier: GPL-3.0-or-later

// What commands use to create and change elements, with the extensions' rules
// applied: data checked by the type's own reader, references kept in `refs`,
// layouts upgraded before an edit, content edits refused for placeholders, and
// scaling that keeps proportions and does not resize what may not be resized.
// See docs/adr/0005-extension-interface.md, sections 3 and 3.7.

import {
  InvalidDocumentError,
  Problems,
  Resolver,
  envelopeField,
  type ElementData,
  type ElementId,
  type Point,
} from "@galatsa/core";
import {
  ORIGIN,
  addElement,
  dataMap,
  edit,
  moveElement,
  resizeElement,
  roots,
  setData,
  setRefs,
  setTypeVersion,
  valueFromY,
  yLookup,
  type NewElement,
} from "@galatsa/core/ydoc";
import * as Y from "yjs";
import type { CommandContext } from "./command.ts";
import type { AnyElementView } from "./element-type.ts";
import type { ElementCapabilities, RegisteredElementType } from "./element-editing.ts";
import type { ElementFacts } from "./host.ts";

/** Problems the type's reader reports for `data`, as "path: problem" lines. */
export function dataProblems(
  view: AnyElementView,
  data: ElementData,
  typeVersion: number = view.typeVersion,
): string[] {
  const problems: string[] = [];
  try {
    view.read(data, typeVersion, (path, problem) => problems.push(`${path}: ${problem}`));
  } catch (error) {
    problems.push(`read threw: ${String(error)}`);
  }
  return problems;
}

function referencesOf(
  type: RegisteredElementType,
  data: ElementData,
): string[] | undefined {
  const references = type.editing?.references;
  if (references === undefined) return undefined;
  return [
    ...references.call(
      type.editing,
      type.view.read(data, type.view.typeVersion, () => {}),
    ),
  ];
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
  const problems = dataProblems(type.view, init.data);
  if (problems.length > 0) throw new InvalidDocumentError("data", problems);
  const refs = referencesOf(type, init.data) ?? [];
  return addElement(ctx.doc, { ...init, typeVersion: type.view.typeVersion, refs });
}

/**
 * Changes keys of an element's data, the way every content edit must: refused
 * if the element's type is not loaded or is older than the element; the result
 * is checked with the type's reader before anything is written; `refs` follows
 * the type's `references`; the writes are one transaction. `writes` gets the
 * current data and returns the keys to set.
 *
 * Data in an older layout is first brought up to date, in a transaction of its
 * own (origin ORIGIN.upgrade) that undo does not take back: an upgrade keeps
 * the meaning of the data, so there is nothing to undo, and an undo of the edit
 * must not move the element back to a layout that a concurrent edit by someone
 * else may already rely on.
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
  const latest = type.view.typeVersion;
  const upgrades =
    facts.typeVersion < latest
      ? (type.editing?.upgrade?.call(type.editing, current, facts.typeVersion) ?? {})
      : {};
  const upgraded = { ...current, ...upgrades };
  const changes = typeof writes === "function" ? writes(upgraded) : writes;
  const next = { ...upgraded, ...changes };
  const problems = dataProblems(type.view, next);
  if (problems.length > 0) throw new InvalidDocumentError("data", problems);
  const refs = referencesOf(type, next);
  if (facts.typeVersion < latest) {
    edit(
      ctx.doc,
      () => {
        for (const [key, value] of Object.entries(upgrades))
          setData(ctx.doc, id, key, value);
        setTypeVersion(ctx.doc, id, latest);
      },
      { origin: ORIGIN.upgrade },
    );
  }
  edit(ctx.doc, () => {
    for (const [key, value] of Object.entries(changes)) setData(ctx.doc, id, key, value);
    if (refs !== undefined) setRefs(ctx.doc, id, refs);
  });
}

/** One change of a scaling plan: a new position in the parent's space, and a new size. */
export interface ScaleStep {
  readonly id: ElementId;
  readonly x: number;
  readonly y: number;
  /** Absent for groups (no size) and for elements that may not be resized. */
  readonly w?: number;
  readonly h?: number;
}

/** Thrown when a change would reach a locked element (docs/adr/0001, section 5.6). */
export class LockedError extends Error {
  readonly id: ElementId;

  constructor(id: ElementId) {
    super(`Element ${id} is locked`);
    this.name = "LockedError";
    this.id = id;
  }
}

/**
 * How scaling elements by `factor` about `anchor` (root space) changes them,
 * keeping proportions: every element inside a scaled group or frame is scaled
 * with it, also what is still shown inside a dissolved group or a deleted frame
 * in it. An element whose size may not change (a placeholder) keeps its size
 * and moves so that its centre lands where a scaled centre would. Throws
 * LockedError if any element it would change is locked, or inside a locked
 * container.
 */
export function planScale(
  ctx: CommandContext,
  ids: readonly ElementId[],
  anchor: Point,
  factor: number,
): ScaleStep[] {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("factor must be positive");
  const r = new Resolver(yLookup(ctx.doc));
  const chosen = new Set(ids.filter((id) => r.get(id) !== undefined && !r.isGone(id)));
  const inside = (id: ElementId): boolean => {
    for (let at = r.parentOf(id); at !== null; at = r.parentOf(at))
      if (chosen.has(at)) return true;
    return false;
  };
  const steps: ScaleStep[] = [];
  // `a` is the anchor in the element's parent space.
  const visit = (id: ElementId, a: Point): void => {
    const envelope = r.get(id)!;
    const local = r.localPosition(id);
    if (r.isGone(id)) {
      // A gone container (a dissolved group, a deleted frame) is not changed,
      // but what is still shown inside it scales with the rest, about the
      // anchor as seen in the container's space.
      if (r.isContainer(id))
        for (const child of r.children(id))
          visit(child, { x: a.x - local.x, y: a.y - local.y });
      return;
    }
    if (r.isLocked(id)) throw new LockedError(id);
    const size = envelope.size;
    const resizable = ctx.extensions.capabilities(elementFacts(ctx, id)).resize;
    if (size === undefined) {
      // A group: its origin scales, and so does everything in it.
      steps.push({
        id,
        x: a.x + (local.x - a.x) * factor,
        y: a.y + (local.y - a.y) * factor,
      });
    } else if (resizable) {
      steps.push({
        id,
        x: a.x + (local.x - a.x) * factor,
        y: a.y + (local.y - a.y) * factor,
        w: size.w * factor,
        h: size.h * factor,
      });
    } else {
      const cx = local.x + size.w / 2;
      const cy = local.y + size.h / 2;
      steps.push({
        id,
        x: a.x + (cx - a.x) * factor - size.w / 2,
        y: a.y + (cy - a.y) * factor - size.h / 2,
      });
      return;
    }
    // Containers have translation-only spaces: inside a scaled container the
    // anchor is its own origin.
    if (r.isContainer(id))
      for (const child of r.children(id)) visit(child, { x: 0, y: 0 });
  };
  for (const id of chosen) {
    if (inside(id)) continue;
    const origin = r.spaceOrigin(r.parentOf(id));
    visit(id, { x: anchor.x - origin.x, y: anchor.y - origin.y });
  }
  return steps;
}

/** Applies a scaling plan in one transaction. */
export function applyScale(ctx: CommandContext, steps: readonly ScaleStep[]): void {
  edit(ctx.doc, () => {
    for (const step of steps) {
      moveElement(ctx.doc, step.id, step.x, step.y);
      if (step.w !== undefined && step.h !== undefined)
        resizeElement(ctx.doc, step.id, step.w, step.h);
    }
  });
}
