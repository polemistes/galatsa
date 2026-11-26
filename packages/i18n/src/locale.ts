// SPDX-License-Identifier: GPL-3.0-or-later

// The user interface languages, how a system language maps to one of them, and the
// order in which languages are tried when a message is missing.

/** Interface languages, as BCP 47 language codes. Norwegian Bokmål and English. */
export const LOCALES = ["nb", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Language used when no stored choice exists and none of the system languages is
 * supported. English, because a user whose system speaks neither language is more
 * likely to read English than Norwegian.
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Each language's name in that language, for a language picker. These are not
 * translated: a picker shows every language in its own name.
 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  nb: "Norsk bokmål",
  en: "English",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Maps a BCP 47 language tag (for example "nb-NO", "no", "en-GB") to a supported
 * interface language, or undefined. "no" (Norwegian) and "nn" (Nynorsk) map to
 * Bokmål, the closest supported written form.
 */
export function matchLocale(tag: string): Locale | undefined {
  const language = tag.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
  switch (language) {
    case "nb":
    case "no":
    case "nn":
      return "nb";
    case "en":
      return "en";
    default:
      return undefined;
  }
}

/**
 * The first supported language in a list of preferred language tags (most preferred
 * first, as in navigator.languages), or DEFAULT_LOCALE.
 */
export function negotiateLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const locale = matchLocale(tag);
    if (locale !== undefined) return locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Languages to try, in order, when looking up a message in `locale`: the language
 * itself, then English, then Bokmål. With two languages this means nb falls back to
 * en and en falls back to nb. Languages added later fall back to English first.
 */
export function fallbackChain(locale: Locale): readonly Locale[] {
  const order: readonly Locale[] = ["en", "nb"];
  return [locale, ...order.filter((other) => other !== locale)];
}

/**
 * The preferred languages reported by the platform: navigator.languages in browsers
 * and webviews (Node 21 and newer has it too), or an empty list.
 */
export function systemLanguages(): readonly string[] {
  const nav = (
    globalThis as {
      navigator?: { languages?: readonly string[]; language?: string };
    }
  ).navigator;
  if (nav === undefined) return [];
  if (Array.isArray(nav.languages) && nav.languages.length > 0) return nav.languages;
  return typeof nav.language === "string" ? [nav.language] : [];
}
