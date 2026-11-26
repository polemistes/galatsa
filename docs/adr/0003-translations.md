# 0003 Translations

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Every piece of user interface text must come from translation files, in Norwegian Bokmål (`nb`) and English (`en`) from the start, with more languages possible later. The same translations are used by the React editor, by the player (plain DOM, no React, embedded in exported files, so it must stay small) and by Node tests. Tools are extensions, and an extension brings its own text. Translators may later work with ordinary translation tools.

We need to decide:

1. the message syntax, and whether to use a library for it;
2. the format of the message files;
3. how the language is chosen and remembered;
4. what happens when a translation is missing;
5. how hard-coded text is kept out of user interface code.

## Decision

### 1. Message syntax: a subset of ICU MessageFormat, with our own small parser

Messages use ICU MessageFormat syntax, the format most translation tools understand, but only a subset of it, implemented in `packages/i18n/src/message-format.ts` (about 400 lines, no dependencies):

| Feature       | Example                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| Named value   | `Hello, {name}!`                                                                     |
| Number        | `{size, number}`, `{size, number, integer}`, `{share, number, percent}`              |
| Date and time | `{when, date, short}`, `{when, time, short}` (short, medium, long, full)             |
| Plural        | `{count, plural, =0 {No files} one {# file} other {# files}}`                        |
| Ordinal       | `{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`                  |
| Select        | `{kind, select, image {Image} other {Element}}`                                      |
| Quoting       | `'{'` is a literal brace, `''` an apostrophe; a lone apostrophe ("don't") is literal |

Plural categories come from the platform's `Intl.PluralRules`, and numbers and dates are formatted with `Intl.NumberFormat` and `Intl.DateTimeFormat`, so no plural rules or locale data are written or shipped by us. Plural offsets, number and date skeletons (`::`), custom styles and other argument types are rejected by the parser, so a message never silently means something else than it says. Because the syntax is a strict subset of ICU MessageFormat, moving to a full ICU library later needs no change to the message files.

Measured bundle cost (Vite 8 library build, minified, gzip level 9; the entry creates a runtime and formats one plural message):

| Option                                                              | Minified | Gzipped |
| ------------------------------------------------------------------- | -------- | ------- |
| Our parser and formatter only                                       | 5.6 KB   | 2.2 KB  |
| Our whole runtime (`createI18n`, lookup, fallback, language choice) | 8.9 KB   | 3.3 KB  |
| The same, plus browser storage and the shared catalogs              | 10.2 KB  | 3.8 KB  |
| `intl-messageformat` 12.2.1 with its parser                         | 45.9 KB  | 11.3 KB |
| `messageformat` 4.1.0 (MessageFormat 2 syntax)                      | 33.2 KB  | 8.8 KB  |

The two libraries were measured the same way, in a scratch folder outside the repository. Their licenses are compatible with GPL-3.0-or-later: `intl-messageformat` is BSD-3-Clause and depends on `@formatjs/icu-messageformat-parser` and `@formatjs/fast-memoize` ([registry entry](https://registry.npmjs.org/intl-messageformat/latest)); `messageformat` is Apache-2.0 with no dependencies ([registry entry](https://registry.npmjs.org/messageformat/latest)). `messageformat` 4 implements the newer Unicode MessageFormat 2 syntax, which fewer translation tools read today (from memory, not checked). `intl-messageformat` 12.2.1 was published on 2026-11-23, so under our rule that dependencies must be at least two weeks old an older version would have been needed.

Reasons for our own parser: it is three to four times smaller in the player, adds no dependency to review and keep up to date, and covers what a presentation program's interface needs. The cost is about 400 lines of code that we maintain, covered by unit tests. If we need features outside the subset, we switch to `intl-messageformat` (precompiling messages at build time keeps its parser out of the player).

### 2. Message files: TypeScript modules, one per language and namespace

Each package or extension that has text keeps it in `src/messages/nb.ts` and `src/messages/en.ts`. Each file's default export is a flat object from key to message text:

```ts
export default {
  "toolbar.save": "Lagre",
  "selection.count":
    "{count, plural, =0 {Ingenting er valgt} one {# element er valgt} other {# elementer er valgt}}",
};
```

`src/messages/index.ts` turns them into a bundle with a namespace: `defineMessages("editor", { nb, en })`. The Bokmål file defines the keys; the type checker rejects an English file with missing keys, and `pnpm check` rejects missing and extra keys in either direction. TypeScript modules need no loader or build step in Vite, Vitest or Node, and give typed keys (`translator(bundle)` returns a function that only accepts the bundle's keys). Converting them to JSON for a translation tool is a few lines of script.

Namespaces are lowercase words separated by dots or hyphens (`common`, `editor`, `ext.shapes`); extensions use their extension id. A namespace can be registered once; a second bundle for the same namespace is an error. Keys contain letters, digits, `_`, `-` and `.`. An untyped lookup names the namespace and key as `namespace:key`.

### 3. Choosing and remembering the language

The runtime (`createI18n`) is framework-agnostic: the current language, registered bundles, lookup, `formatNumber`, `formatDate`, and `subscribe` plus a `version` counter. A React binding wraps `subscribe` and `version` with `useSyncExternalStore`; it is not built yet. The player uses the runtime directly.

The language at start is, in order:

1. a language the caller passes explicitly;
2. the language the user chose earlier, read from a `LocaleStorage` (`browserLocaleStorage()` uses `localStorage` and survives a missing or blocked `localStorage`; the desktop app and tests pass their own);
3. the first supported language among the system's preferred languages (`navigator.languages`): `nb`, `no` and `nn` give Bokmål, `en` gives English;
4. English, because a user whose system speaks neither language is more likely to read English than Norwegian.

Only an explicit choice (`setLocale`) is stored. A user who never chose follows the system language, also if it changes later.

### 4. Missing translations

Lookup tries the current language, then English, then Bokmål; with two languages, Bokmål falls back to English and English to Bokmål. The runtime takes a required `dev` flag (apps pass `import.meta.env.DEV`); there is deliberately no default, so neither behaviour can be switched on by accident.

- **Development:** a translation missing in the current language, a key missing everywhere, a broken message or a missing value logs a console warning (once per problem) and shows up in the text as `⟦namespace:key⟧` or `⟦name⟧`, so it is visible in the interface and in screenshots.
- **Production:** the other language is used quietly. If no language has the message, the key is shown; a missing value is shown as `{name}`.

`pnpm check` makes these cases rare: it requires both languages to have the same keys, the same values per key, valid syntax, and exactly the plural categories that each language uses (from `Intl.PluralRules`; for example `one` and `other` for both `nb` and `en`, so a forgotten `one` or an unusable `few` is caught).

### 5. Checking for hard-coded text

`scripts/check-i18n.ts`, part of `pnpm check`, parses user interface code with the TypeScript compiler and fails on user-visible text written directly in it.

**User interface code:** by default every `.tsx` and `.jsx` file in `packages/*`, `packages/extensions/*` and `apps/*`. A package changes this with `"galatsa": { "i18n": { "uiFiles": [...] } }` in its `package.json`; the player, which builds its interface with the DOM, will list its `.ts` files there. Test files and message files are never checked. Tooling (`bench`, `tests/e2e`, `scripts`) is not user interface code.

**User-visible text:** a string with at least one letter (or the literal parts of a template string), in JSX text and JSX children, in text attributes (`title`, `alt`, `placeholder`, `label`, `aria-label` and other ARIA text attributes, and a few common prop names such as `tooltip` and `caption`), in properties and variables whose names hold text by convention (`label`, `title`, `textContent`, names ending in `Label`, `Text`, `Message` and so on), and in arguments to browser APIs that show text (`alert`, `confirm`, `prompt`, `createTextNode`, `fillText`, `append`, `setAttribute("title", ...)`, `new Notification(...)`). Packages can add attribute and function names. Strings without letters (`×`, `100 %`) and message keys (`editor:toolbar.save`) are not text.

**Opting out:** `// i18n-ignore: <reason>` (or `{/* i18n-ignore: <reason> */}` in JSX) on the line or alone on the line above; `// i18n-ignore-file: <reason>` for a whole file. The reason is required.

The check also rejects catalogs written inline in `defineMessages(...)`, where the comparison of languages could not see them.

## Consequences

- The player carries about 3.3 KB (gzipped) for translations, plus its own messages.
- Message syntax beyond the subset (offsets, skeletons, currency styles) needs a change to the parser or a switch to a full ICU library.
- The hard-coded text check finds text where it is written. Text stored in a variable with an ordinary name and shown later is not found; code review and the convention of calling `t(...)` where text is shown cover that.
- Each language is a separate file per namespace. Adding a language means adding it to `LOCALES`, adding one file per namespace, and checking the fallback order.
