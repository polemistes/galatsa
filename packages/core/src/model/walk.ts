// SPDX-License-Identifier: GPL-3.0-or-later

// Walking and rewriting values in value positions (element data, ext slots, stop
// transitions, settings): finding asset references (section 8.3) and remapping
// element and stop ids on paste (section 3.5).

import { ASSET_ID_PATTERN } from "./grammar.ts";
import {
  setOwn,
  type AnyTree,
  type AssetId,
  type DataValue,
  type DocumentSnapshot,
  type TextRun,
} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Calls `visit` for every string in a JSON-form value except the text of rich
 * text runs (user text never counts as a reference). Iterative, so deep values
 * cannot overflow the stack.
 */
export function forEachString(value: unknown, visit: (s: string) => void): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") visit(item);
    else if (Array.isArray(item)) stack.push(...item);
    else if (isObject(item)) {
      if ((item.$y === "text" || item.$y === "xmlText") && Array.isArray(item.delta)) {
        for (const run of item.delta as TextRun[]) {
          if (typeof run.insert !== "string") stack.push(run.insert);
          if (run.attributes) stack.push(run.attributes);
        }
        if (item.attributes) stack.push(item.attributes);
        continue;
      }
      for (const v of Object.values(item)) stack.push(v);
    }
  }
}

/**
 * Asset ids a document refers to: any string value that is a complete asset id,
 * anywhere in element envelopes, data and ext, stops (view, transition, notes
 * embeds, ext), routes and settings. With `includeRemoved` false, gone elements
 * and removed stops and routes are skipped (section 8.3).
 */
export function referencedAssets(
  snapshot: DocumentSnapshot,
  options: { skip?: (kind: "element" | "stop" | "route", id: string) => boolean } = {},
): Set<AssetId> {
  const out = new Set<AssetId>();
  const add = (s: string) => {
    if (ASSET_ID_PATTERN.test(s)) out.add(s as AssetId);
  };
  for (const [id, element] of Object.entries(snapshot.elements)) {
    if (options.skip?.("element", id)) continue;
    forEachString(element.data, add);
    forEachString(element.ext, add);
  }
  for (const [id, stop] of Object.entries(snapshot.stops)) {
    if (options.skip?.("stop", id)) continue;
    forEachString(stop.transition, add);
    forEachString(stop.ext, add);
    forEachString(stop.notes, add);
  }
  for (const [id, route] of Object.entries(snapshot.routes)) {
    if (options.skip?.("route", id)) continue;
    forEachString(route.ext, add);
  }
  forEachString(snapshot.settings, add);
  return out;
}

/**
 * Copy of a JSON-form value with every string that is a key of `ids` replaced by
 * its value, also as object keys of plain maps and shared maps. Text of rich
 * text runs is left alone.
 */
export function remapStrings<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (ids.size === 0) return value;
  const map = (s: string) => ids.get(s) ?? s;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return map(item);
    if (Array.isArray(item)) return item.map(walk);
    if (!isObject(item)) return item;
    if ((item.$y === "text" || item.$y === "xmlText") && Array.isArray(item.delta)) {
      const out: Record<string, unknown> = { ...item };
      out.delta = (item.delta as TextRun[]).map((run) =>
        typeof run.insert === "string"
          ? run
          : { ...run, insert: walk(run.insert) as DataValue },
      );
      if (item.attributes) out.attributes = walk(item.attributes);
      return out;
    }
    if (item.$y === "any") return { $y: "any", value: walkAny(item.value as AnyTree) };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(item)) {
      const newKey = key === "$y" ? key : map(key);
      setOwn(out, newKey, walk(item[key]));
    }
    return out;
  };
  const walkAny = (tree: AnyTree): AnyTree => {
    if (typeof tree === "string") return map(tree);
    if (tree === null || typeof tree !== "object") return tree;
    if ("a" in tree) return { a: tree.a.map(walkAny) };
    if ("o" in tree) {
      const o: { [key: string]: AnyTree } = {};
      for (const key of Object.keys(tree.o)) setOwn(o, map(key), walkAny(tree.o[key]!));
      return { o };
    }
    return tree;
  };
  return walk(value) as T;
}
