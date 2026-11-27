// SPDX-License-Identifier: GPL-3.0-or-later

// Copy, paste and duplicate, through fragments (docs/adr/0001, section 3.5).
// The clipboard itself is the editor's: "copy" returns a fragment, which the
// editor puts on the system clipboard as JSON, and "paste" takes a fragment
// the editor read back. A fragment from the clipboard may come from another
// program or another version, so paste checks it with the document's grammar
// and the element types' readers before anything is written.

import {
  ASSET_ID_PATTERN,
  ID_PATTERN,
  Problems,
  copyFragment,
  isPlainObject,
  readAsset,
  readElement,
  readRoute,
  readStop,
  readView,
  setOwn,
  type AssetId,
  type AssetInfo,
  type Element,
  type ElementId,
  type Fragment,
  type RectView,
  type Route,
  type RouteId,
  type Stop,
  type StopId,
} from "@galatsa/core";
import { pasteFragment, toSnapshot } from "@galatsa/core/ydoc";
import {
  dataProblems,
  defineCommand,
  type CommandContext,
} from "@galatsa/extension-api/editing";
import {
  backToFront,
  canTargetAll,
  isId,
  isOpenContainer,
  label,
  optionalNumber,
  outermost,
  readIds,
  refuse,
  resolve,
} from "./common.ts";
import type { IdsArgs } from "./structure.ts";

// ---------------------------------------------------------------------------
// Reading a fragment
// ---------------------------------------------------------------------------

export interface ReadFragmentResult {
  /** The fragment as the grammar reads it, or null if anything had to be changed. */
  readonly fragment: Fragment | null;
  readonly problems: readonly string[];
}

function readRecords<T>(
  raw: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  p: Problems,
  read: (value: unknown, p: Problems) => T | null,
): { [id: string]: T } {
  const out: { [id: string]: T } = {};
  p.at(key, () => {
    const records = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (records === undefined) return;
    if (!isPlainObject(records)) return p.add("must be an object");
    for (const id of Object.keys(records)) {
      p.at(id, () => {
        if (!pattern.test(id)) return p.add("not an id");
        const value = read(records[id], p);
        if (value !== null) setOwn(out, id, value);
      });
    }
  });
  return out;
}

/**
 * Reads a fragment, for example one pasted from the clipboard. Every record
 * must read cleanly with the document's grammar, the roots must be top-level
 * elements of the fragment, and every other element must lie inside a root.
 * The result is null if anything had to be changed or left out.
 */
export function readFragment(raw: unknown): ReadFragmentResult {
  const p = new Problems(20);
  if (!isPlainObject(raw)) return { fragment: null, problems: ["must be an object"] };
  const known = ["elements", "roots", "stops", "routes", "fallbackViews", "assets"];
  for (const key of Object.keys(raw))
    if (!known.includes(key)) p.at(key, () => p.add("unknown key"));
  const elements = readRecords<Element>(raw, "elements", ID_PATTERN, p, readElement);
  const stops = readRecords<Stop>(raw, "stops", ID_PATTERN, p, readStop);
  const routes = readRecords<Route>(raw, "routes", ID_PATTERN, p, readRoute);
  const assets = readRecords<AssetInfo>(raw, "assets", ASSET_ID_PATTERN, p, readAsset);
  const fallbackViews = readRecords<RectView>(
    raw,
    "fallbackViews",
    ID_PATTERN,
    p,
    (value, q) => {
      const view = readView(value, q);
      if (view.kind === "rect") return view;
      q.add("must be a rectangle");
      return null;
    },
  );
  const roots: ElementId[] = [];
  p.at("roots", () => {
    const list = Object.hasOwn(raw, "roots") ? raw.roots : undefined;
    if (!Array.isArray(list)) return p.add("must be a list of ids");
    for (const id of list) {
      if (!isId(id) || !Object.hasOwn(elements, id) || roots.includes(id))
        return p.add("must list elements of the fragment, each once");
      if (elements[id]!.parent !== null) return p.add("roots must have no parent");
      roots.push(id);
    }
  });
  // Every element lies inside a root; otherwise pasting it could not be undone.
  const rootSet = new Set(roots);
  p.at("elements", () => {
    for (const id of Object.keys(elements)) {
      const seen = new Set<ElementId>();
      let at: ElementId | null = id;
      while (at !== null && !rootSet.has(at) && !seen.has(at)) {
        seen.add(at);
        at = Object.hasOwn(elements, at) ? elements[at]!.parent : null;
      }
      if (at === null || !rootSet.has(at))
        p.at(id, () => p.add("is not inside one of the roots"));
    }
  });
  if (p.count > 0) return { fragment: null, problems: p.list };
  return {
    fragment: {
      elements,
      roots,
      stops: stops as { [id: StopId]: Stop },
      routes: routes as { [id: RouteId]: Route },
      fallbackViews: fallbackViews as { [id: StopId]: RectView },
      assets: assets as { [id: AssetId]: AssetInfo },
    },
    problems: [],
  };
}

/**
 * Problems with the data of the fragment's elements whose type is loaded: data
 * that the type's reader would read differently is refused, as it is for
 * every command that writes data (docs/adr/0005, section 3.2). Elements of a
 * missing extension or a newer layout are pasted as they are.
 */
function fragmentDataProblems(ctx: CommandContext, fragment: Fragment): string[] {
  const problems: string[] = [];
  for (const [id, element] of Object.entries(fragment.elements)) {
    const type = ctx.extensions.elementType(element.type);
    if (type === undefined || element.typeVersion > type.view.typeVersion) continue;
    for (const problem of dataProblems(type.view, element.data, element.typeVersion))
      problems.push(`elements.${id}.data.${problem}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** What a paste or a duplicate made. */
export interface PasteOutcome {
  /** The new top-level elements, back to front. */
  readonly ids: readonly ElementId[];
  /** Assets the new elements use; the editor copies their bytes into this document's store. */
  readonly assets: readonly AssetId[];
}

function pasteInto(
  ctx: CommandContext,
  fragment: Fragment,
  target: { parent: ElementId | null; dx: number; dy: number },
): PasteOutcome {
  const result = pasteFragment(ctx.doc, fragment, target);
  const ids = fragment.roots.map((id) => result.ids.get(id)!);
  ctx.services.selection.set(ids);
  return { ids, assets: result.assets };
}

function readCopy(ctx: CommandContext, args: unknown): ElementId[] | undefined {
  const ids = readIds(args);
  if (ids === undefined) return undefined;
  // Copying changes nothing, so locked elements can be copied.
  return canTargetAll(ctx, resolve(ctx), ids, { locked: true }) ? ids : undefined;
}

/**
 * Copies elements, with everything visible inside them, into a fragment. It
 * changes nothing in the document; the editor puts the fragment on the
 * clipboard.
 */
export const copy = defineCommand<IdsArgs, Fragment>({
  name: "copy",
  label: label("copy"),
  shortcuts: ["Mod+C"],
  quick: true,
  undoable: false,
  enabled: (ctx, args) => readCopy(ctx, args) !== undefined,
  execute(ctx, args) {
    const ids = readCopy(ctx, args) ?? refuse("copy");
    return copyFragment(toSnapshot(ctx.doc), ids);
  },
});

export interface PasteArgs {
  /** A fragment, as "copy" returns it (and as the clipboard holds it, read as JSON). */
  readonly fragment: unknown;
  /** The frame or group to paste into; default: the canvas root. */
  readonly parent?: ElementId | null;
  /** Offset of the pasted elements from where they were copied. */
  readonly dx?: number;
  readonly dy?: number;
}

interface PastePlan {
  readonly fragment: Fragment;
  readonly parent: ElementId | null;
  readonly dx: number;
  readonly dy: number;
}

function planPaste(ctx: CommandContext, args: unknown): PastePlan | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const a = args as Partial<PasteArgs>;
  const parent = a.parent ?? null;
  if ((parent !== null && !isId(parent)) || !optionalNumber(a.dx) || !optionalNumber(a.dy))
    return undefined;
  if (!isOpenContainer(resolve(ctx), parent)) return undefined;
  const { fragment } = readFragment(a.fragment);
  if (fragment === null || fragment.roots.length === 0) return undefined;
  if (fragmentDataProblems(ctx, fragment).length > 0) return undefined;
  return { fragment, parent, dx: a.dx ?? 0, dy: a.dy ?? 0 };
}

/**
 * Pastes a fragment with new ids, in front of what is in the target container,
 * and selects what was pasted. Refused if the fragment does not read cleanly.
 */
export const paste = defineCommand<PasteArgs, PasteOutcome>({
  name: "paste",
  label: label("paste"),
  undoLabel: label("paste.step"),
  shortcuts: ["Mod+V"],
  quick: true,
  enabled: (ctx, args) => planPaste(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planPaste(ctx, args) ?? refuse("paste");
    return pasteInto(ctx, plan.fragment, plan);
  },
});

export interface DuplicateArgs {
  readonly ids: readonly ElementId[];
  /** Offset of the copies from the originals; default none. */
  readonly dx?: number;
  readonly dy?: number;
}

interface DuplicatePlan {
  readonly ids: ElementId[];
  readonly parent: ElementId | null;
  readonly dx: number;
  readonly dy: number;
}

function planDuplicate(ctx: CommandContext, args: unknown): DuplicatePlan | undefined {
  const ids = readIds(args);
  const { dx, dy } = (args ?? {}) as Partial<DuplicateArgs>;
  if (ids === undefined || !optionalNumber(dx) || !optionalNumber(dy)) return undefined;
  const r = resolve(ctx);
  if (!canTargetAll(ctx, r, ids, { locked: true })) return undefined;
  // The copies go into the container the first root (in drawing order) is seen
  // in: the fragment's positions are in that container's space.
  const first = backToFront(r, outermost(r, ids))[0]!;
  const parent = r.logicalParentOf(first);
  if (!isOpenContainer(r, parent)) return undefined;
  return { ids, parent, dx: dx ?? 0, dy: dy ?? 0 };
}

/**
 * Duplicates elements, with everything visible inside them, into the container
 * the first of them is seen in, in front of what is there; selects the copies.
 * Locked elements can be duplicated (the copies are locked too), but not into
 * a locked container.
 */
export const duplicate = defineCommand<DuplicateArgs, PasteOutcome>({
  name: "duplicate",
  label: label("duplicate"),
  undoLabel: label("duplicate.step"),
  shortcuts: ["Mod+D"],
  quick: true,
  enabled: (ctx, args) => planDuplicate(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planDuplicate(ctx, args) ?? refuse("duplicate");
    const fragment = copyFragment(toSnapshot(ctx.doc), plan.ids);
    return pasteInto(ctx, fragment, plan);
  },
});
