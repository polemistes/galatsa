// SPDX-License-Identifier: GPL-3.0-or-later

// Small helpers shared by the example extensions: typed labels, and readers for
// the plain values in element data. Each reader returns a default and reports
// when the value does not fit, as an element type's `read` must.

import type { DataValue, ElementData, Json } from "@galatsa/core";
import {
  EXTENSION_API_VERSION,
  messageKey,
  type ApiVersion,
  type DataReport,
  type FieldChange,
  type Label,
} from "@galatsa/extension-api";
import type { BundleKey } from "@galatsa/i18n";
import { exampleMessages } from "./messages/index.ts";

/** The interface version the examples are written against. */
export const API: ApiVersion = EXTENSION_API_VERSION;

export function label(key: BundleKey<typeof exampleMessages>): Label {
  return messageKey(exampleMessages, key);
}

function own(data: ElementData, key: string): DataValue | undefined {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

export function readNumber(
  data: ElementData,
  key: string,
  fallback: number,
  report: DataReport,
  range: { readonly min?: number; readonly max?: number } = {},
): number {
  const value = own(data, key);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= (range.min ?? -Infinity) &&
    value <= (range.max ?? Infinity)
  ) {
    return value;
  }
  report(key, `must be a number in range, read as ${fallback}`);
  return fallback;
}

/** A CSS colour string, or null for "none" when `allowNone`. */
export function readColor(
  data: ElementData,
  key: string,
  fallback: string | null,
  report: DataReport,
  allowNone = false,
): string | null {
  const value = own(data, key);
  if (typeof value === "string" && value.length > 0 && value.length <= 64) return value;
  if (value === null && allowNone) return null;
  report(key, "must be a colour");
  return fallback;
}

export function readChoice<T extends string>(
  data: ElementData,
  key: string,
  choices: readonly T[],
  fallback: T,
  report: DataReport,
): T {
  const value = own(data, key);
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) {
    return value as T;
  }
  report(key, `must be one of ${choices.join(", ")}`);
  return fallback;
}

/** Arguments of a field's command, checked. */
export function readFieldChange(args: unknown): FieldChange | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const { ids, key, value } = args as Partial<FieldChange>;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  if (typeof key !== "string" || value === undefined) return undefined;
  return { ids, key, value: value as Json };
}
