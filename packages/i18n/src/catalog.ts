// SPDX-License-Identifier: GPL-3.0-or-later

// Message catalogs and bundles. A catalog is the messages of one namespace in one
// language: a flat object from key to message text. A bundle holds the catalogs of
// one namespace for every interface language. The program and each extension ship
// their own bundles, so an extension brings its own text.

import { LOCALES, type Locale } from "./locale.ts";
import {
  MessageSyntaxError,
  messageArguments,
  parseMessage,
  pluralArguments,
  pluralRules,
  selectArguments,
  type ArgumentKind,
} from "./message-format.ts";

/** Messages of one namespace in one language: key to message text. */
export type Catalog<K extends string = string> = Readonly<Record<K, string>>;

/** The catalogs of one namespace, one per interface language. */
export interface MessageBundle<K extends string = string> {
  readonly namespace: string;
  readonly messages: Readonly<Record<Locale, Catalog<K>>>;
}

/** The keys of a bundle, for typed lookups. */
export type BundleKey<B> = B extends MessageBundle<infer K> ? K : never;

/**
 * Namespaces: lowercase words separated by dots or hyphens, for example "common",
 * "editor" or "ext.shapes". Extensions use their extension id.
 */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/** Keys: letters, digits, "_", "-" and ".", for example "toolbar.save". No ":". */
export const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Creates a bundle. The keys of the Bokmål catalog define the bundle's keys; the
 * English catalog must have the same ones (checked by the type checker for missing
 * keys, and by `pnpm check` for both missing and extra keys).
 */
export function defineMessages<K extends string>(
  namespace: string,
  messages: { readonly nb: Catalog<K>; readonly en: Catalog<NoInfer<K>> },
): MessageBundle<K> {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`Invalid message namespace "${namespace}"`);
  }
  return { namespace, messages };
}

/**
 * What kind of value a message expects for a name, from how it uses it:
 * "number" ({n, number}, plural, selectordinal), "date" ({d, date}, {d, time}),
 * "select" ({kind, select, ...}) or "plain" ({name}, which shows a string as it is
 * and formats a number).
 */
export type ValueType = "plain" | "number" | "date" | "select";

const VALUE_TYPES: Readonly<Record<ArgumentKind, ValueType>> = {
  argument: "plain",
  number: "number",
  plural: "number",
  selectordinal: "number",
  date: "date",
  time: "date",
  select: "select",
};

/**
 * The value type a set of uses settles on, or undefined if the uses conflict. A
 * plain use goes with number uses, because {n} formats a number the way
 * {n, number} does; every other mix is a conflict.
 */
function settledType(types: ReadonlySet<ValueType>): ValueType | undefined {
  const typed = [...types].filter((type) => type !== "plain");
  if (typed.length > 1) return undefined;
  return typed[0] ?? "plain";
}

/** True if a value used as `a` in one language and `b` in another is the same value. */
function compatibleTypes(a: ValueType, b: ValueType): boolean {
  if (a === b) return true;
  return (a === "plain" && b === "number") || (a === "number" && b === "plain");
}

// Numbers tried to find which numbers pick a plural category: the integers up to
// 1000 (enough for every CLDR rule that depends on the last two or three digits),
// some large numbers and some fractions.
const PLURAL_SAMPLES: readonly number[] = [
  ...Array.from({ length: 1001 }, (_, n) => n),
  ...[1e4, 1e5, 1e6, 1e6 + 1, 2e6, 1e7],
  ...[0.1, 0.5, 1.1, 1.5, 2.1, 2.5, 3.5, 5.5, 10.5, 11.5, 21.5, 100.5, 1000.5],
];

const samplesByCategory = new Map<string, Map<string, number[]>>();

/**
 * Plural categories of a language that the exact cases (=0, =1, ...) of a plural
 * fully cover: every sample number that would pick the category has its own exact
 * case. In nb and en, "one" picks only the number 1, so {n, plural, =1 {...}
 * other {...}} needs no "one". In French, "one" also picks 0 and 1.5, and in
 * Russian 21 and 31, so =1 alone does not cover it there.
 */
export function coveredCategories(
  locale: string,
  ordinal: boolean,
  exactKeys: readonly string[],
): string[] {
  const exact = new Set(exactKeys.map((key) => Number(key.slice(1))));
  const cacheKey = `${locale}|${ordinal ? "o" : "c"}`;
  let picked = samplesByCategory.get(cacheKey);
  if (picked === undefined) {
    const rules = pluralRules(locale, ordinal);
    picked = new Map<string, number[]>();
    for (const n of PLURAL_SAMPLES) {
      const category = rules.select(n);
      picked.set(category, [...(picked.get(category) ?? []), n]);
    }
    samplesByCategory.set(cacheKey, picked);
  }
  return [...picked]
    .filter(([, numbers]) => numbers.every((n) => exact.has(n)))
    .map(([category]) => category);
}

/**
 * Checks that the catalogs of one namespace agree: every language is present, all
 * have the same keys, every message parses, each key uses the same value names
 * with the same kind of value in every language (a number in one language and a
 * date in another is an error), a select has the same options in every language,
 * and every plural covers exactly the plural categories of its language (a
 * category may be left out if exact cases cover it, see coveredCategories). Returns
 * one line per problem; an empty list means the catalogs are fine.
 */
export function checkCatalogs(catalogs: Partial<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const present: Locale[] = [];

  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    if (catalog === undefined) {
      problems.push(`${locale}: the catalog is missing`);
    } else if (
      typeof catalog !== "object" ||
      catalog === null ||
      Array.isArray(catalog)
    ) {
      problems.push(`${locale}: the catalog is not an object of key to text`);
    } else {
      present.push(locale);
    }
  }
  for (const locale of Object.keys(catalogs)) {
    if (!(LOCALES as readonly string[]).includes(locale)) {
      problems.push(`${locale}: not an interface language (${LOCALES.join(", ")})`);
    }
  }

  const entries = (locale: Locale): [string, unknown][] =>
    Object.entries(catalogs[locale] as Record<string, unknown>);
  const allKeys = new Set(present.flatMap((locale) => entries(locale).map(([k]) => k)));

  // Value names with their type, per key and language.
  const names = new Map<string, Map<Locale, Map<string, ValueType>>>();
  // Options of each select, per key, value name and language.
  const selects = new Map<string, Map<string, Map<Locale, string[]>>>();

  for (const locale of present) {
    const catalog = catalogs[locale] as Record<string, unknown>;
    for (const key of allKeys) {
      if (!Object.hasOwn(catalog, key)) {
        problems.push(`${locale}: missing key "${key}"`);
      }
    }
    for (const [key, text] of entries(locale)) {
      if (!KEY_PATTERN.test(key)) {
        problems.push(
          `${locale}: invalid key "${key}" (allowed: letters, digits, _ - .)`,
        );
      }
      if (typeof text !== "string") {
        problems.push(`${locale}: "${key}" is not a string`);
        continue;
      }
      let message;
      try {
        message = parseMessage(text);
      } catch (error) {
        const reason =
          error instanceof MessageSyntaxError ? error.message : String(error);
        problems.push(`${locale}: "${key}" has a syntax error: ${reason}`);
        continue;
      }
      let perLocale = names.get(key);
      if (perLocale === undefined) {
        perLocale = new Map();
        names.set(key, perLocale);
      }
      const types = new Map<string, ValueType>();
      for (const [name, kinds] of messageArguments(message)) {
        const used = new Set([...kinds].map((kind) => VALUE_TYPES[kind]));
        const type = settledType(used);
        if (type === undefined) {
          problems.push(
            `${locale}: "${key}": {${name}} is used as ${[...used].sort().join(" and ")}; one value cannot be both`,
          );
          continue;
        }
        types.set(name, type);
      }
      perLocale.set(locale, types);

      for (const select of selectArguments(message)) {
        let byName = selects.get(key);
        if (byName === undefined) {
          byName = new Map();
          selects.set(key, byName);
        }
        let byLocale = byName.get(select.name);
        if (byLocale === undefined) {
          byLocale = new Map();
          byName.set(select.name, byLocale);
        }
        byLocale.set(locale, [
          ...new Set([...(byLocale.get(locale) ?? []), ...select.keys]),
        ]);
      }

      for (const plural of pluralArguments(message)) {
        const required = pluralRules(locale, plural.ordinal).resolvedOptions()
          .pluralCategories as readonly string[];
        const keywords = plural.keys.filter((k) => !k.startsWith("="));
        const exact = plural.keys.filter((k) => k.startsWith("="));
        const covered = coveredCategories(locale, plural.ordinal, exact);
        const type = plural.ordinal ? "selectordinal" : "plural";
        const missing = required.filter(
          (c) => !keywords.includes(c) && !covered.includes(c),
        );
        const unused = keywords.filter((c) => !required.includes(c));
        if (missing.length > 0) {
          problems.push(
            `${locale}: "${key}": ${type} {${plural.name}} lacks the categories ${missing.join(", ")} (${locale} uses ${required.join(", ")})`,
          );
        }
        if (unused.length > 0) {
          problems.push(
            `${locale}: "${key}": ${type} {${plural.name}} has categories that ${locale} never uses: ${unused.join(", ")} (use =N for exact numbers)`,
          );
        }
      }
    }
  }

  const describe = (list: readonly string[]): string =>
    list.length === 0 ? "no values" : list.map((name) => `{${name}}`).join(", ");
  for (const [key, perLocale] of names) {
    const variants = [...perLocale.entries()];
    const [first] = variants;
    if (first === undefined) continue;
    const firstNames = [...first[1].keys()].sort();
    for (const [locale, types] of variants.slice(1)) {
      const list = [...types.keys()].sort();
      if (list.join(",") !== firstNames.join(",")) {
        problems.push(
          `"${key}": the values differ between languages: ${first[0]} uses ${describe(firstNames)}, ${locale} uses ${describe(list)}`,
        );
        continue;
      }
      for (const name of list) {
        const a = first[1].get(name);
        const b = types.get(name);
        if (a !== undefined && b !== undefined && !compatibleTypes(a, b)) {
          problems.push(
            `"${key}": {${name}} is a ${a} value in ${first[0]} but a ${b} value in ${locale}`,
          );
        }
      }
    }
  }

  for (const [key, byName] of selects) {
    for (const [name, byLocale] of byName) {
      const variants = [...byLocale.entries()];
      const [first] = variants;
      if (first === undefined) continue;
      const expected = [...first[1]].sort().join(", ");
      for (const [locale, options] of variants.slice(1)) {
        const actual = [...options].sort().join(", ");
        if (actual !== expected) {
          problems.push(
            `"${key}": select {${name}} has the options ${expected} in ${first[0]} but ${actual} in ${locale}`,
          );
        }
      }
    }
  }

  return problems;
}
