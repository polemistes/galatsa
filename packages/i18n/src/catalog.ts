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
 * Checks that the catalogs of one namespace agree: every language is present, all
 * have the same keys, every message parses, each key uses the same value names in
 * every language, and every plural covers exactly the plural categories of its
 * language. Returns one line per problem; an empty list means the catalogs are fine.
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

  // Parsed messages and their value names, per key and language.
  const names = new Map<string, Map<Locale, string[]>>();

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
      perLocale.set(locale, [...messageArguments(message).keys()].sort());

      for (const plural of pluralArguments(message)) {
        const required = pluralRules(locale, plural.ordinal).resolvedOptions()
          .pluralCategories as readonly string[];
        const keywords = plural.keys.filter((k) => !k.startsWith("="));
        const type = plural.ordinal ? "selectordinal" : "plural";
        const missing = required.filter((c) => !keywords.includes(c));
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
    for (const [locale, list] of variants.slice(1)) {
      if (list.join(",") !== first[1].join(",")) {
        problems.push(
          `"${key}": the values differ between languages: ${first[0]} uses ${describe(first[1])}, ${locale} uses ${describe(list)}`,
        );
      }
    }
  }

  return problems;
}
