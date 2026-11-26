// SPDX-License-Identifier: GPL-3.0-or-later

// The translation runtime: holds the current language and the registered bundles,
// looks up and formats messages, and tells subscribers when the language changes.
// It has no dependency on a user interface framework, so the React editor, the
// player (plain DOM) and Node tests use the same object. A React binding wraps
// `subscribe` and `version` with useSyncExternalStore.
//
// Nothing here throws for bad input at lookup time: t(), a translator, formatNumber
// and formatDate always return a string. In development a problem shows up as a
// visible marker (⟦...⟧) and a warning; in production as a quiet fallback.
//
// Intended use with React (the binding is not built yet):
//
//   - Register bundles at startup, outside rendering: createI18n({ bundles }) or
//     i18n.register(bundle) in the app's setup code. register() notifies
//     subscribers synchronously, so it must not run during a React render.
//   - translator(bundle) may be called anywhere, also during a render (for example
//     in a useTranslator hook). If it has to register the bundle, lookups see the
//     bundle at once, but the version bump and the notification wait for a
//     microtask, after the render, so a render never changes the store it reads.

import type { BundleKey, MessageBundle } from "./catalog.ts";
import { NAMESPACE_PATTERN } from "./catalog.ts";
import {
  fallbackChain,
  isLocale,
  negotiateLocale,
  systemLanguages,
  type Locale,
} from "./locale.ts";
import {
  dateTimeFormat,
  formatMessage,
  isValidTime,
  numberFormat,
  parseMessage,
  type Message,
  type MessageValues,
} from "./message-format.ts";
import type { LocaleStorage } from "./storage.ts";

export interface I18nOptions {
  /**
   * True during development: a missing translation, a missing value or a broken
   * message logs a warning and shows up in the text as ⟦namespace:key⟧ (or ⟦name⟧
   * for a value). False in production: the other language is used quietly. Apps
   * pass `import.meta.env.DEV`. There is deliberately no default.
   */
  readonly dev: boolean;
  /** Start in this language, ignoring the stored choice and the system languages. */
  readonly locale?: Locale;
  /**
   * Where the user's choice is remembered. Use browserLocaleStorage() in browsers;
   * the desktop app passes its own. Without it the choice lasts for the session.
   */
  readonly storage?: LocaleStorage;
  /** Preferred languages of the system, most preferred first. Default: navigator. */
  readonly systemLanguages?: readonly string[];
  /** Receives development warnings. Default: console.warn. */
  readonly warn?: (message: string) => void;
  /** Bundles to register right away. */
  readonly bundles?: readonly MessageBundle[];
}

/** Looks up a key of one bundle. */
export type Translate<K extends string> = (key: K, values?: MessageValues) => string;

export interface I18n {
  /** The current interface language. */
  readonly locale: Locale;
  /** Increases on every change (language or bundles). A snapshot for React. */
  readonly version: number;
  /** Switches the language, remembers the choice and notifies subscribers. */
  setLocale(locale: Locale): void;
  /**
   * Adds a namespace and notifies subscribers. A different bundle with the same
   * namespace replaces the old one: hot module reload re-runs the module that
   * defines a bundle, and a package may be loaded twice. In development a
   * replacement that shares no key with the old bundle logs a warning, because it
   * is more likely two packages choosing the same namespace. Throws only for an
   * invalid namespace. Do not call it during a React render; see translator().
   */
  register(bundle: MessageBundle): void;
  /** Removes a namespace, for example when an extension is unloaded. */
  unregister(namespace: string): void;
  /** Looks up "namespace:key" and fills in the values. */
  t(fullKey: string, values?: MessageValues): string;
  /**
   * A typed lookup for one bundle's keys. Registers the bundle if needed (or if a
   * different bundle holds the namespace, as after a hot reload). Safe to call
   * during a React render: lookups see the bundle at once, while the version bump
   * and the notification of subscribers are deferred to a microtask.
   */
  translator<B extends MessageBundle>(bundle: B): Translate<BundleKey<B>>;
  /**
   * Formats a number for the current language (Intl.NumberFormat). Never throws:
   * if Intl rejects the options, development shows a marker, production the
   * number as plain digits.
   */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  /**
   * Formats a date or timestamp for the current language (Intl.DateTimeFormat).
   * Never throws: an invalid date (or options Intl rejects) shows a marker in
   * development and an empty string in production.
   */
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /** Calls the listener after every change. Returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void;
}

/** How a missing message or value is shown during development. */
export function missingMarker(name: string): string {
  return `⟦${name}⟧`;
}

/** True if two bundles have at least one key in common (or one has no keys). */
function sharesKey(a: MessageBundle, b: MessageBundle): boolean {
  const keysOf = (bundle: MessageBundle): string[] =>
    Object.values(bundle.messages).flatMap((catalog: unknown) =>
      catalog !== null && typeof catalog === "object" ? Object.keys(catalog) : [],
    );
  const first = new Set(keysOf(a));
  const second = keysOf(b);
  return first.size === 0 || second.length === 0 || second.some((key) => first.has(key));
}

function defaultWarn(message: string): void {
  (globalThis as { console?: { warn(...args: unknown[]): void } }).console?.warn(
    `[i18n] ${message}`,
  );
}

export function createI18n(options: I18nOptions): I18n {
  const { dev, storage } = options;
  const warnSink = options.warn ?? defaultWarn;
  const warned = new Set<string>();
  const warn = (message: string): void => {
    if (!dev || warned.has(message)) return;
    warned.add(message);
    warnSink(message);
  };

  const bundles = new Map<string, MessageBundle>();
  const parsed = new Map<string, Message | Error>();
  const listeners = new Set<() => void>();
  let version = 0;

  const stored = storage?.get();
  let locale: Locale =
    options.locale ??
    (isLocale(stored)
      ? stored
      : negotiateLocale(options.systemLanguages ?? systemLanguages()));

  const changed = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  // One deferred notification at a time, for registrations made by translator().
  let notifyPending = false;
  const changedLater = (): void => {
    if (notifyPending) return;
    notifyPending = true;
    void Promise.resolve().then(() => {
      notifyPending = false;
      changed();
    });
  };

  const forgetParsed = (namespace: string): void => {
    for (const cacheKey of [...parsed.keys()]) {
      if (cacheKey.split("\u0000")[1] === namespace) parsed.delete(cacheKey);
    }
  };

  const parse = (lang: Locale, namespace: string, key: string, text: string) => {
    const cacheKey = `${lang}\u0000${namespace}\u0000${key}`;
    let result = parsed.get(cacheKey);
    if (result === undefined) {
      try {
        result = parseMessage(text);
      } catch (error) {
        result = error instanceof Error ? error : new Error(String(error));
      }
      parsed.set(cacheKey, result);
    }
    return result;
  };

  const lookup = (namespace: string, key: string, values?: MessageValues): string => {
    const fullKey = `${namespace}:${key}`;
    try {
      return lookupUnsafe(namespace, key, fullKey, values);
    } catch (error) {
      // A last line of defence: formatMessage guards its values, but a malformed
      // bundle passed in from plain JavaScript could still make something throw.
      warn(`Could not format "${fullKey}": ${String(error)}`);
      return dev ? missingMarker(fullKey) : fullKey;
    }
  };

  const lookupUnsafe = (
    namespace: string,
    key: string,
    fullKey: string,
    values: MessageValues | undefined,
  ): string => {
    const bundle = bundles.get(namespace);
    if (bundle === undefined) {
      warn(`Unknown namespace "${namespace}" (looking up "${fullKey}")`);
      return dev ? missingMarker(fullKey) : fullKey;
    }
    for (const lang of fallbackChain(locale)) {
      const catalog: Readonly<Record<string, string>> | undefined = bundle.messages[lang];
      if (catalog === undefined || !Object.hasOwn(catalog, key)) continue;
      const text = catalog[key];
      if (typeof text !== "string") continue;
      const message = parse(lang, namespace, key, text);
      if (message instanceof Error) {
        warn(`Broken message "${fullKey}" in ${lang}: ${message.message}`);
        if (dev) return missingMarker(fullKey);
        continue;
      }
      if (lang !== locale) {
        warn(`Missing ${locale} translation for "${fullKey}"`);
        if (dev) return missingMarker(fullKey);
      }
      return formatMessage(message, values, {
        locale: lang,
        onMissingValue: (name, problem) => {
          const what =
            problem === "missing"
              ? "Missing value"
              : problem === "invalid"
                ? "Invalid value"
                : "Value of the wrong type";
          warn(`${what} {${name}} for "${fullKey}"`);
          return dev ? missingMarker(name) : `{${name}}`;
        },
      });
    }
    warn(`Missing message "${fullKey}" in every language`);
    return dev ? missingMarker(fullKey) : fullKey;
  };

  /** Stores the bundle; returns false if it was already registered. */
  const store = (bundle: MessageBundle): boolean => {
    const existing = bundles.get(bundle.namespace);
    if (existing === bundle) return false;
    if (!NAMESPACE_PATTERN.test(bundle.namespace)) {
      throw new Error(`Invalid message namespace "${bundle.namespace}"`);
    }
    if (existing !== undefined) {
      if (!sharesKey(existing, bundle)) {
        warn(
          `Message namespace "${bundle.namespace}" was replaced by a bundle with none of the same keys. ` +
            "Two packages may be using the same namespace.",
        );
      }
      forgetParsed(bundle.namespace);
    }
    bundles.set(bundle.namespace, bundle);
    return true;
  };

  const register = (bundle: MessageBundle): void => {
    if (store(bundle)) changed();
  };

  for (const bundle of options.bundles ?? []) register(bundle);

  return {
    get locale() {
      return locale;
    },
    get version() {
      return version;
    },
    setLocale(next) {
      if (!isLocale(next)) throw new Error(`Unsupported language "${String(next)}"`);
      storage?.set(next);
      if (next === locale) return;
      locale = next;
      changed();
    },
    register,
    unregister(namespace) {
      if (!bundles.delete(namespace)) return;
      forgetParsed(namespace);
      changed();
    },
    t(fullKey, values) {
      if (typeof fullKey !== "string") {
        warn(`Key ${String(fullKey)} is not a string`);
        return dev ? missingMarker(String(fullKey)) : "";
      }
      const colon = fullKey.indexOf(":");
      if (colon <= 0) {
        warn(`Key "${fullKey}" has no namespace (expected "namespace:key")`);
        return dev ? missingMarker(fullKey) : fullKey;
      }
      return lookup(fullKey.slice(0, colon), fullKey.slice(colon + 1), values);
    },
    translator<B extends MessageBundle>(bundle: B): Translate<BundleKey<B>> {
      if (store(bundle)) changedLater();
      return (key, values) => lookup(bundle.namespace, key, values);
    },
    formatNumber(value, formatOptions) {
      try {
        return numberFormat(locale, formatOptions).format(value);
      } catch (error) {
        warn(`formatNumber(${String(value)}) failed: ${String(error)}`);
        return dev ? missingMarker(String(value)) : String(value);
      }
    },
    formatDate(value, formatOptions) {
      try {
        const time = value instanceof Date ? value.getTime() : value;
        if (typeof time !== "number" || !isValidTime(time)) {
          throw new RangeError("invalid date");
        }
        return dateTimeFormat(locale, formatOptions).format(time);
      } catch (error) {
        warn(`formatDate(${String(value)}) failed: ${String(error)}`);
        return dev ? missingMarker(String(value)) : "";
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
