// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers shared by the basic commands: labels, reading arguments, and the
// rules that decide which elements a command may act on.

import { ID_PATTERN, Resolver, type ElementId } from "@galatsa/core";
import { yLookup } from "@galatsa/core/ydoc";
import {
  EXTENSION_API_VERSION,
  messageKey,
  type ApiVersion,
  type Label,
} from "@galatsa/extension-api";
import { capabilitiesOf, type CommandContext } from "@galatsa/extension-api/editing";
import type { BundleKey } from "@galatsa/i18n";
import { basicsMessages } from "./messages/index.ts";

/** The extension's id; command ids are "galatsa.basics/<name>". */
export const BASICS_EXTENSION = "galatsa.basics";

/** The interface version the extension is written against. */
export const API: ApiVersion = EXTENSION_API_VERSION;

export function label(key: BundleKey<typeof basicsMessages>): Label {
  return messageKey(basicsMessages, key);
}

/** The document as resolved now. */
export function resolve(ctx: Pick<CommandContext, "doc">): Resolver {
  return new Resolver(yLookup(ctx.doc));
}

export function isId(value: unknown): value is ElementId {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** The `ids` of a command's arguments: a non-empty list of ids, without repeats. */
export function readIds(args: unknown): ElementId[] | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const ids = (args as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) return undefined;
  return [...new Set(ids)];
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** An optional number argument: absent, or finite. */
export function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

/** What a command needs of each element it acts on. */
export interface Need {
  /** The element may be locked, or inside a locked container (copying it). */
  readonly locked?: boolean;
  /** Its type allows resizing (placeholders do not). */
  readonly resize?: boolean;
  /** Its type allows rotating (placeholders, frames and groups do not). */
  readonly rotate?: boolean;
}

/**
 * Whether a command may act on an element: it exists and the user sees it (not
 * deleted, dissolved or tidied away); unless `need.locked`, neither it nor a
 * container it is in is locked (docs/adr/0001, section 5.6); and its type
 * allows what the command does (docs/adr/0005, section 3.7).
 */
export function canTarget(
  ctx: CommandContext,
  r: Resolver,
  id: ElementId,
  need: Need = {},
): boolean {
  if (r.get(id) === undefined || r.isGone(id)) return false;
  if (need.locked !== true && r.isLocked(id)) return false;
  if (need.resize === true || need.rotate === true) {
    const can = capabilitiesOf(ctx, id);
    if (need.resize === true && !can.resize) return false;
    if (need.rotate === true && !can.rotate) return false;
  }
  return true;
}

/** True if every id may be acted on. */
export function canTargetAll(
  ctx: CommandContext,
  r: Resolver,
  ids: readonly ElementId[],
  need: Need = {},
): boolean {
  return ids.every((id) => canTarget(ctx, r, id, need));
}

/** Thrown by `execute` when the arguments do not allow the command (normally caught by `enabled`). */
export function refuse(command: string): never {
  throw new Error(`${BASICS_EXTENSION}/${command}: not possible with these arguments`);
}

/** The ids that are not inside another of them (moving a container moves its contents). */
export function outermost(r: Resolver, ids: readonly ElementId[]): ElementId[] {
  const chosen = new Set(ids);
  return ids.filter((id) => {
    for (let at = r.parentOf(id); at !== null; at = r.parentOf(at))
      if (chosen.has(at)) return false;
    return true;
  });
}

/** The ids in drawing order, back to front. */
export function backToFront(r: Resolver, ids: readonly ElementId[]): ElementId[] {
  const index = new Map(r.drawOrder().map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (index.get(a) ?? -1) - (index.get(b) ?? -1));
}

/** A container the user can put elements into: the root, or a visible, unlocked frame or group. */
export function isOpenContainer(r: Resolver, id: ElementId | null): boolean {
  if (id === null) return true;
  return r.isContainer(id) && !r.isGone(id) && !r.isLocked(id);
}
