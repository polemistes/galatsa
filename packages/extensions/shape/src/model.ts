// SPDX-License-Identifier: GPL-3.0-or-later

// The data of a shape element and how it is read. The keys and value ranges
// here are part of the file format (docs/adr/0010-shapes.md, "Data"): change
// them only by adding optional keys whose default means what older data meant.
//
// Growth rule. Values are read in two ways. Reading for drawing is lenient
// about values a newer version may write: a well-formed choice this version
// does not know, and a finite number outside this version's range, are kept
// in the data without a report and drawn as the default or the nearest value
// in range, so a later version may add an option or widen a range without
// making the shape uneditable here. Only a value of the wrong form (a string
// where a number belongs, a colour that is not "#rrggbb") is reported.
// Writing is strict: a command writes only values this version allows.

import { PRECISION_BUDGET, type DataValue, type ElementData } from "@galatsa/core";
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

/** True if `value` is a colour as shape data stores it (either case). */
export function isShapeColor(value: unknown): value is ShapeColor {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

/**
 * The largest outline width and corner radius written, in world units: the
 * precision budget of the document model (docs/adr/0001, section 7), beyond
 * which nothing can be drawn precisely anyway.
 */
export const MAX_LENGTH = PRECISION_BUDGET;

/**
 * The form of a parameter's data key: a plain identifier (as "tailX"), so that
 * it can never be "__proto__" or another key with a meaning in JavaScript
 * objects beyond its own.
 */
export const PARAM_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

/** Names every JavaScript object has; never parameter keys. */
const OBJECT_KEYS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/** The form of a choice value, as of a kind name: so that unknown ones can be kept. */
export const CHOICE_PATTERN = KIND_PATTERN;

/** The style every shape has, whatever its kind. */
export interface ShapeStyle {
  /** Fill colour, or null for none. Only closed kinds are filled. */
  readonly fill: ShapeColor | null;
  /** Outline colour, or null for none. */
  readonly stroke: ShapeColor | null;
  /** Outline width in world units, 0 to MAX_LENGTH, centred on the outline. */
  readonly strokeWidth: number;
  /** Corner radius in world units, 0 to MAX_LENGTH; drawn at most half the shorter side. */
  readonly cornerRadius: number;
  /** 0 (invisible) to 1 (opaque), for fill and outline alike. */
  readonly opacity: number;
}

/** A shape as the type understands its data, ready to draw. */
export interface ShapeModel extends ShapeStyle {
  /**
   * The kind. A kind this version does not know (from a newer version) is
   * kept as it is and drawn as a placeholder; editing the style keeps it.
   */
  readonly kind: string;
  /** The parameters of the shape's own kind, by key, read or defaulted; none for an unknown kind. */
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

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * One key's rules: `read` gives the value to draw (lenient, by the growth
 * rule) or undefined for a value of the wrong form; `allows` says whether a
 * command may write the value.
 */
interface ValueRule<T> {
  read(value: DataValue): T | undefined;
  allows(value: unknown): boolean;
  readonly problem: string;
}

const COLOR: ValueRule<ShapeColor | null> = {
  read: (v) => (v === null ? null : isShapeColor(v) ? v : undefined),
  allows: (v) => v === null || isShapeColor(v),
  problem: 'must be a colour "#rrggbb" or "#rrggbbaa", or null',
};

function range(min: number, max: number): ValueRule<number> {
  return {
    read: (v) => (finite(v) ? clamp(v, min, max) : undefined),
    allows: (v) => finite(v) && v >= min && v <= max,
    problem: "must be a finite number",
  };
}

const STYLE_RULES: { readonly [K in StyleKey]: ValueRule<ShapeStyle[K]> } = {
  fill: COLOR,
  stroke: COLOR,
  strokeWidth: range(0, MAX_LENGTH),
  cornerRadius: range(0, MAX_LENGTH),
  opacity: range(0, 1),
};

function paramRule(param: ShapeParam): ValueRule<ParamValue> {
  switch (param.type) {
    case "number":
      return range(param.min, param.max);
    case "choice": {
      const known = (v: unknown) =>
        typeof v === "string" && param.options.some((o) => o.value === v);
      return {
        // An option of a newer version is drawn as the default.
        read: (v) =>
          typeof v === "string" && CHOICE_PATTERN.test(v)
            ? known(v)
              ? v
              : param.default
            : undefined,
        allows: known,
        problem: "must be a choice name",
      };
    }
    case "toggle":
      return {
        read: (v) => (typeof v === "boolean" ? v : undefined),
        allows: (v) => typeof v === "boolean",
        problem: "must be true or false",
      };
  }
}

/** Reads one parameter's value to draw, or undefined if it has the wrong form. */
export function readParamValue(
  param: ShapeParam,
  value: DataValue,
): ParamValue | undefined {
  return paramRule(param).read(value);
}

/** The kinds a shape type knows, and their parameters by key. */
export interface KindTable {
  readonly kinds: ReadonlyMap<string, ShapeKind>;
  readonly params: ReadonlyMap<string, ShapeParam>;
  /** For each parameter key, the kinds that list it. */
  readonly paramKinds: ReadonlyMap<string, ReadonlySet<string>>;
}

function checkParam(kind: ShapeKind, param: ShapeParam): void {
  const fail = (why: string): never => {
    throw new Error(`Shape kind "${kind.kind}": parameter "${param.key}" ${why}`);
  };
  if (!PARAM_KEY_PATTERN.test(param.key) || OBJECT_KEYS.has(param.key))
    fail("needs a key of letters and digits, starting with a lowercase letter");
  if (param.type === "number") {
    if (!finite(param.min) || !finite(param.max) || !(param.min < param.max))
      fail("needs a finite range");
    if (Math.max(Math.abs(param.min), Math.abs(param.max)) > MAX_LENGTH)
      fail("has a range beyond MAX_LENGTH");
  }
  if (param.type === "choice") {
    if (param.options.length === 0) fail("has no options");
    for (const option of param.options)
      if (!CHOICE_PATTERN.test(option.value))
        fail(`has an option "${option.value}" not of the form of a kind name`);
  }
  if (!paramRule(param).allows(param.default)) fail("has a default that does not fit");
}

/**
 * Builds the table of kinds, and checks it: kind names of the right form and
 * unique, parameter keys not taken by the common keys, a key shared by
 * several kinds meaning one parameter (the same object), number ranges finite
 * and choice names of the form of a kind name. Throws on a mistake, so a
 * faulty kind fails every test rather than a user's document.
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
      checkParam(kind, param);
      params.set(param.key, param);
      let users = paramKinds.get(param.key);
      if (users === undefined) paramKinds.set(param.key, (users = new Set()));
      users.add(kind.kind);
    }
  }
  return { kinds: byName, params, paramKinds };
}

/**
 * Reads shape data, totally (docs/adr/0005, section 3.2): a value of the
 * wrong form is read as the default and reported; a missing key is read as
 * its default without a report; values from newer versions are read by the
 * growth rule above; keys that are not the shape's, or not its kind's, are
 * left alone.
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
      const fits = STYLE_RULES[key].read(value);
      if (fits === undefined) report(key, STYLE_RULES[key].problem);
      else read = fits;
    }
    style[key] = read;
  }
  const params: Record<string, ParamValue> = {};
  for (const param of table.kinds.get(kind)?.params ?? []) {
    const rule = paramRule(param);
    const value = own(data, param.key);
    let read = param.default;
    if (value !== undefined) {
      const fits = rule.read(value);
      if (fits === undefined) report(param.key, rule.problem);
      else read = fits;
    }
    params[param.key] = read;
  }
  return { kind, ...(style as unknown as ShapeStyle), params };
}

/**
 * True if a command may write `value` under `key`: a style value in this
 * version's range, a known kind for "kind", or a parameter value its
 * parameter allows.
 */
export function isValidValue(table: KindTable, key: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (key === "kind") return typeof value === "string" && table.kinds.has(value);
  if ((STYLE_KEYS as readonly string[]).includes(key))
    return STYLE_RULES[key as StyleKey].allows(value);
  const param = table.params.get(key);
  return param !== undefined && paramRule(param).allows(value);
}

/** A value as it is written: colours in lower case, everything else as it is. */
export function normalizeValue<T>(value: T): T {
  return (isShapeColor(value) ? value.toLowerCase() : value) as T;
}

/** The data a new shape of `kind` is written with: every key, explicitly. */
export function newShapeData(
  table: KindTable,
  kind: string,
  style: Partial<ShapeStyle> = {},
): ElementData {
  const data: Record<string, DataValue> = { kind, ...DEFAULT_STYLE };
  for (const [key, value] of Object.entries(style))
    if (value !== undefined) data[key] = normalizeValue(value);
  for (const param of table.kinds.get(kind)?.params ?? [])
    data[param.key] = param.default;
  return data as ElementData;
}
