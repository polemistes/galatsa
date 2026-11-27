// SPDX-License-Identifier: GPL-3.0-or-later

// The data of a shape element and how it is read. The keys and value ranges
// here are part of the file format (docs/adr/0008-shapes.md, "Data"): change
// them only by adding optional keys whose default means what older data meant.

import type { DataValue, ElementData } from "@galatsa/core";
import type { DataReport } from "@galatsa/extension-api";
import {
  KIND_PATTERN,
  type ParamValue,
  type ShapeKind,
  type ShapeParam,
} from "./kind.ts";

/** A colour as the data stores it: "#rrggbb" or "#rrggbbaa", hexadecimal. */
export type ShapeColor = string;

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True if `value` is a colour as shape data stores it. */
export function isShapeColor(value: unknown): value is ShapeColor {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

/** The style every shape has, whatever its kind. */
export interface ShapeStyle {
  /** Fill colour, or null for none. Only closed kinds are filled. */
  readonly fill: ShapeColor | null;
  /** Outline colour, or null for none. */
  readonly stroke: ShapeColor | null;
  /** Outline width in world units, 0 or more, centred on the outline. */
  readonly strokeWidth: number;
  /** Corner radius in world units, 0 or more; drawn at most half the shorter side. */
  readonly cornerRadius: number;
  /** 0 (invisible) to 1 (opaque), for fill and outline alike. */
  readonly opacity: number;
}

/** A shape as the type understands its data. */
export interface ShapeModel extends ShapeStyle {
  /**
   * The kind. A kind this version does not know (from a newer version) is
   * kept as it is and drawn as a placeholder; editing the style keeps it.
   */
  readonly kind: string;
  /** Every known kind parameter, by key, read or defaulted. */
  readonly params: Readonly<Record<string, ParamValue>>;
}

/** Data keys of the style. */
export const STYLE_KEYS = [
  "fill",
  "stroke",
  "strokeWidth",
  "cornerRadius",
  "opacity",
] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

/**
 * What a missing key means. These never change: data without a key must keep
 * meaning what it meant when it was written. New shapes are written with
 * every key, so they do not depend on these.
 */
export const DEFAULT_KIND = "rect";
export const DEFAULT_STYLE: ShapeStyle = {
  fill: "#93c5fd",
  stroke: "#1e3a8a",
  strokeWidth: 2,
  cornerRadius: 0,
  opacity: 1,
};

/** The value of a key, or undefined when the key is missing. */
function own(data: ElementData, key: string): DataValue | undefined {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

/**
 * One key's reader: the value if it fits, otherwise undefined. Readers are
 * shared by `read` and by the commands' argument checks.
 */
type ValueReader<T> = (value: DataValue) => T | undefined;

const colorOrNone: ValueReader<ShapeColor | null> = (v) =>
  v === null ? null : isShapeColor(v) ? v : undefined;
const nonNegative: ValueReader<number> = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const unit: ValueReader<number> = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

const STYLE_READERS: { readonly [K in StyleKey]: ValueReader<ShapeStyle[K]> } = {
  fill: colorOrNone,
  stroke: colorOrNone,
  strokeWidth: nonNegative,
  cornerRadius: nonNegative,
  opacity: unit,
};

const STYLE_PROBLEMS: { readonly [K in StyleKey]: string } = {
  fill: 'must be a colour "#rrggbb" or "#rrggbbaa", or null',
  stroke: 'must be a colour "#rrggbb" or "#rrggbbaa", or null',
  strokeWidth: "must be a finite number of 0 or more",
  cornerRadius: "must be a finite number of 0 or more",
  opacity: "must be a number from 0 to 1",
};

/** Reads one parameter's value: the value if it fits the parameter, otherwise undefined. */
export function readParamValue(
  param: ShapeParam,
  value: DataValue,
): ParamValue | undefined {
  switch (param.type) {
    case "number":
      return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= param.min &&
        value <= param.max
        ? value
        : undefined;
    case "choice":
      return typeof value === "string" && param.options.some((o) => o.value === value)
        ? value
        : undefined;
    case "toggle":
      return typeof value === "boolean" ? value : undefined;
  }
}

function paramProblem(param: ShapeParam): string {
  switch (param.type) {
    case "number":
      return `must be a number from ${param.min} to ${param.max}`;
    case "choice":
      return `must be one of ${param.options.map((o) => o.value).join(", ")}`;
    case "toggle":
      return "must be true or false";
  }
}

/** The kinds a shape type knows, and their parameters by key. */
export interface KindTable {
  readonly kinds: ReadonlyMap<string, ShapeKind>;
  readonly params: ReadonlyMap<string, ShapeParam>;
  /** For each parameter key, the kinds that list it. */
  readonly paramKinds: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Builds the table of kinds, and checks it: kind names of the right form and
 * unique, parameter keys not taken by the common keys, and a key shared by
 * several kinds meaning one parameter (the same object). Throws on a mistake,
 * so a faulty kind fails every test rather than a user's document.
 */
export function kindTable(kinds: readonly ShapeKind[]): KindTable {
  const byName = new Map<string, ShapeKind>();
  const params = new Map<string, ShapeParam>();
  const paramKinds = new Map<string, Set<string>>();
  const reserved = new Set<string>(["kind", ...STYLE_KEYS]);
  for (const kind of kinds) {
    if (!KIND_PATTERN.test(kind.kind))
      throw new Error(`Bad shape kind name "${kind.kind}"`);
    if (byName.has(kind.kind))
      throw new Error(`Shape kind "${kind.kind}" is listed twice`);
    byName.set(kind.kind, kind);
    for (const param of kind.params ?? []) {
      if (reserved.has(param.key))
        throw new Error(
          `Shape kind "${kind.kind}": parameter key "${param.key}" is a common key`,
        );
      const known = params.get(param.key);
      if (known !== undefined && known !== param)
        throw new Error(
          `Shape kind "${kind.kind}": parameter key "${param.key}" means another parameter in another kind`,
        );
      if (readParamValue(param, param.default) === undefined)
        throw new Error(
          `Shape kind "${kind.kind}": default of "${param.key}" does not fit`,
        );
      params.set(param.key, param);
      let users = paramKinds.get(param.key);
      if (users === undefined) paramKinds.set(param.key, (users = new Set()));
      users.add(kind.kind);
    }
  }
  return { kinds: byName, params, paramKinds };
}

/**
 * Reads shape data, totally (docs/adr/0005, section 3.2): a value that does
 * not fit is read as the default and reported; a missing key is read as its
 * default without a report; keys that are not the shape's are left alone.
 */
export function readShape(
  table: KindTable,
  data: ElementData,
  report: DataReport,
): ShapeModel {
  let kind = DEFAULT_KIND;
  const rawKind = own(data, "kind");
  if (rawKind !== undefined) {
    if (typeof rawKind === "string" && KIND_PATTERN.test(rawKind)) kind = rawKind;
    else report("kind", "must be a kind name");
  }
  const style: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    const value = own(data, key);
    let read: unknown = DEFAULT_STYLE[key];
    if (value !== undefined) {
      const fits = STYLE_READERS[key](value);
      if (fits === undefined) report(key, STYLE_PROBLEMS[key]);
      else read = fits;
    }
    style[key] = read;
  }
  const params: Record<string, ParamValue> = {};
  for (const [key, param] of table.params) {
    const value = own(data, key);
    let read = param.default;
    if (value !== undefined) {
      const fits = readParamValue(param, value);
      if (fits === undefined) report(key, paramProblem(param));
      else read = fits;
    }
    params[key] = read;
  }
  return { kind, ...(style as unknown as ShapeStyle), params };
}

/**
 * True if `value` may be written under `key`: a common style key, a known
 * kind for "kind", or a known parameter.
 */
export function isValidValue(table: KindTable, key: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (key === "kind") return typeof value === "string" && table.kinds.has(value);
  if ((STYLE_KEYS as readonly string[]).includes(key))
    return STYLE_READERS[key as StyleKey](value as DataValue) !== undefined;
  const param = table.params.get(key);
  return param !== undefined && readParamValue(param, value as DataValue) !== undefined;
}

/** The data a new shape of `kind` is written with: every key, explicitly. */
export function newShapeData(
  table: KindTable,
  kind: string,
  style: Partial<ShapeStyle> = {},
): ElementData {
  const data: Record<string, DataValue> = { kind, ...DEFAULT_STYLE, ...style };
  for (const param of table.kinds.get(kind)?.params ?? [])
    data[param.key] = param.default;
  return data as ElementData;
}
