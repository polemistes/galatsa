// SPDX-License-Identifier: GPL-3.0-or-later

// Translations for Galatsa. See docs/adr/0003-translations.md for the design.

export {
  checkCatalogs,
  defineMessages,
  KEY_PATTERN,
  NAMESPACE_PATTERN,
  type BundleKey,
  type Catalog,
  type MessageBundle,
} from "./catalog.ts";
export {
  createI18n,
  missingMarker,
  type I18n,
  type I18nOptions,
  type Translate,
} from "./i18n.ts";
export {
  DEFAULT_LOCALE,
  fallbackChain,
  isLocale,
  LOCALE_NAMES,
  LOCALES,
  matchLocale,
  negotiateLocale,
  systemLanguages,
  type Locale,
} from "./locale.ts";
export {
  formatMessage,
  MessageSyntaxError,
  messageArguments,
  parseMessage,
  type Message,
  type MessageValue,
  type MessageValues,
} from "./message-format.ts";
export { commonMessages } from "./messages/index.ts";
export {
  browserLocaleStorage,
  LOCALE_STORAGE_KEY,
  memoryLocaleStorage,
  type LocaleStorage,
} from "./storage.ts";
