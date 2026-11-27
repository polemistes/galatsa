// SPDX-License-Identifier: GPL-3.0-or-later

// What importers and the editor use around imports and exports: building a
// fragment from new elements, pasting an import as one command, and preparing
// the purged input every exporter gets. See
// docs/adr/0005-extension-interface.md, section 6.

import {
  keysBetween,
  newId,
  purgeSnapshot,
  referencedAssets,
  setOwn,
  type AssetId,
  type AssetInfo,
  type Element,
  type ElementData,
  type ElementId,
  type Fragment,
  type RouteId,
} from "@galatsa/core";
import { pasteFragment, toSnapshot, type PasteResult } from "@galatsa/core/ydoc";
import type * as Y from "yjs";
import type { CommandContext } from "./command.ts";
import type { AnyElementEditing } from "./element-editing.ts";
import type { AnyElementView } from "./element-type.ts";
import type { ExportInput, ImportResult } from "./transfer.ts";

/** A new element for a fragment, positioned in the fragment's common space. */
export interface FragmentElement {
  /** The element type id and its parts, so the data is written in its current layout. */
  readonly type: string;
  readonly view: AnyElementView;
  readonly editing?: AnyElementEditing;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot?: number;
  readonly name?: string;
  readonly data: ElementData;
}

/**
 * Builds a fragment of new top-level elements, back to front, with the asset
 * descriptions they use. Importers return this; pasting gives the elements new
 * ids, so the ids here are only for the fragment.
 */
export function buildFragment(
  elements: readonly FragmentElement[],
  assets: { readonly [id: AssetId]: AssetInfo } = {},
): Fragment {
  const keys = keysBetween(null, null, elements.length);
  const fragment: Fragment = {
    elements: {},
    roots: [],
    stops: {},
    routes: {},
    fallbackViews: {},
    assets: {},
  };
  elements.forEach((init, i) => {
    const id = newId();
    const model = init.view.read(init.data, init.view.typeVersion, () => {});
    const element: Element = {
      type: init.type,
      typeVersion: init.view.typeVersion,
      parent: null,
      order: keys[i]!,
      pos: { x: init.x, y: init.y, space: null },
      rebase: null,
      size: { w: init.w, h: init.h },
      rot: init.rot ?? 0,
      name: init.name ?? "",
      locked: false,
      rev: {},
      deleted: {},
      dissolved: false,
      purged: false,
      refs: [...new Set(init.editing?.references?.(model) ?? [])].sort(),
      ext: {},
      data: init.data,
    };
    setOwn(fragment.elements, id, element);
    fragment.roots.push(id);
  });
  for (const [id, info] of Object.entries(assets)) setOwn(fragment.assets, id, info);
  return fragment;
}

/**
 * Pastes an import's fragment into the document. Meant to run inside a
 * command, so the whole import is one undo step. Roots go into `parent`
 * (default: the root), moved by the offset.
 */
export function pasteImport(
  ctx: CommandContext,
  result: ImportResult,
  target: {
    readonly parent?: ElementId | null;
    readonly dx?: number;
    readonly dy?: number;
  } = {},
): PasteResult {
  return pasteFragment(ctx.doc, result.fragment, target);
}

/**
 * The input for an exporter: the document purged for sharing, and an asset
 * reader that serves only what the purged document refers to.
 */
export function prepareExport(
  doc: Y.Doc,
  assets: { get(id: AssetId): Promise<Uint8Array | undefined> },
  options: {
    readonly route?: RouteId | null;
    readonly selection?: readonly ElementId[] | null;
  } = {},
): ExportInput {
  const snapshot = purgeSnapshot(toSnapshot(doc));
  const allowed = referencedAssets(snapshot);
  return {
    snapshot,
    route: options.route ?? null,
    selection: options.selection ?? null,
    assets: {
      get: (id) => (allowed.has(id) ? assets.get(id) : Promise.resolve(undefined)),
    },
  };
}
