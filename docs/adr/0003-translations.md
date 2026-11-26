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

`src/messages/index.ts` turns them into a bundle with a namespace: `defineMessages("editor", { nb, en })`. The Bokmål file defines the keys; the type checker rejects an English file with missing keys, and `pnpm check` rejects missing and extra keys in either direction.

The message files are found by name, not by guessing: they are exactly `<messages>/<language>.ts` for each language in `LOCALES` (the folder is `src/messages` unless the package sets another one). Other files in the folder, such as `index.ts` or a helper `ids.ts`, are not catalogs. `pnpm check` rejects a `defineMessages()` call outside the messages folder, and a catalog that is written inline or is not the default export of its language's file, so every bundle is one the catalog comparison sees. TypeScript modules need no loader or build step in Vite, Vitest or Node, and give typed keys (`translator(bundle)` returns a function that only accepts the bundle's keys). Converting them to JSON for a translation tool is a few lines of script.

Namespaces are lowercase words separated by dots or hyphens (`common`, `editor`, `ext.shapes`); extensions use their extension id. Registering a different bundle for a namespace that is taken replaces the old one. This is what hot module reload needs (it re-runs `messages/index.ts` and creates a new bundle object), and it keeps a package that happens to be loaded twice from crashing the program. In development, a replacement that shares no key with the old bundle logs a warning, because it more likely means that two packages chose the same namespace; keeping extension ids unique is the job of the extension host. Keys contain letters, digits, `_`, `-` and `.`. An untyped lookup names the namespace and key as `namespace:key`.

### 3. Choosing and remembering the language

The runtime (`createI18n`) is framework-agnostic: the current language, registered bundles, lookup, `formatNumber`, `formatDate`, and `subscribe` plus a `version` counter. A React binding wraps `subscribe` and `version` with `useSyncExternalStore`; it is not built yet. The player uses the runtime directly.

Intended use with React: bundles are registered at startup, outside rendering (`createI18n({ bundles })`, or `register()` in the app's setup code), because `register()` notifies subscribers at once. `translator(bundle)` may be called during a render, for example inside a future `useTranslator` hook: if it has to register the bundle, lookups see the bundle at once, but the version bump and the notification wait for a microtask, after the render. A render therefore never changes the store it is reading, which `useSyncExternalStore` requires.

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

A lookup never throws. A value that is missing, of the wrong type (a string for `{n, number}`) or that `Intl` cannot format (an invalid `Date`, `NaN` for `{d, date}`) counts as a missing value. Values are read as own properties only, so a message `{constructor}` with `{}` does not pick up `Object.prototype.constructor`. `formatNumber` and `formatDate` do not throw either: in development they show a marker and warn, in production `formatDate` of an invalid date gives an empty string and `formatNumber` with options `Intl` rejects gives the plain digits.

`pnpm check` makes these cases rare. It requires both languages to have:

- the same keys, and valid syntax;
- the same values per key, used as the same kind of value: a number (`{n, number}`, plural, selectordinal), a date (`{d, date}`, `{d, time}`), a select key, or plain (`{name}`). Plain goes with number, because `{n}` formats a number like `{n, number}` does, so `nb: "{n} stk"` with `en: "{n, plural, one {# piece} other {# pieces}}"` is fine, while `{n}` in one language and `{n, date}` in the other is an error;
- the same options in each select;
- exactly the plural categories that each language uses (from `Intl.PluralRules`; `one` and `other` for both `nb` and `en`), so a forgotten `one` or an unusable `few` is caught. A category may be left out when exact cases cover it: the check tries the numbers 0 to 1000 and some larger numbers and fractions, and a category counts as covered if every number that `Intl.PluralRules` puts in it has its own `=N` case. In `nb` and `en`, `one` is only the number 1, so `{n, plural, =0 {...} =1 {...} other {...}}` is accepted. For English ordinals `one` is 1, 21, 31 and so on, so `=1` does not cover it there; the same holds in other languages where `one` covers more than 1 (French: 0, 1 and 1.5; Russian: 1, 21, 31).

### 5. Checking for hard-coded text

`scripts/check-i18n.ts`, part of `pnpm check`, parses user interface code with the TypeScript compiler and fails on user-visible text written directly in it.

**User interface code:** in `packages/*`, `packages/extensions/*` and `apps/*`. In a user interface package, every script under `src/`, every `.tsx` and `.jsx` file and every HTML page; a package is a user interface package if it has a `.tsx` or `.jsx` file (other than tests) or declares `@galatsa/i18n` as a dependency, since code that shows translated text is code that shows text. Menu definitions in a `.ts` file next to the components are then checked too. In other packages, `.tsx`, `.jsx` and HTML files. A package changes this with `"galatsa": { "i18n": { "uiFiles": [...] } }` in its `package.json`, where a glob starting with `!` leaves files out (`"!src/model/**"`). Test files, declaration files and message files are never checked. Tooling (`bench`, `tests/e2e`, `scripts`) is not user interface code.

**User-visible text:** a string with at least one letter (or the literal parts of a template string), in:

- JSX text and JSX children;
- JSX attributes that hold text: `title`, `alt`, `placeholder`, `label`, `aria-label` and the other ARIA text attributes, `tooltip`, `caption` and a few more, every prop whose name holds text by convention (`text`, `confirmLabel`, `emptyText`: see below), the `children` prop, and `value` on `<input type="submit">` (and `button`, `reset`);
- properties, variables, class fields and default values whose names hold text by convention (`label`, `title`, `textContent`, names ending in `Label`, `Title`, `Text`, `Message`, `Hint` and so on);
- what functions, methods and getters with such a name return (`statusText()`);
- arguments to browser APIs that show text (`alert`, `confirm`, `prompt`, `createTextNode`, `fillText`, `append`, `after`, `setAttribute("title", ...)`, `new Notification(...)`). `append` is skipped when the receiver is a `FormData`, `URLSearchParams` or `Headers` object: built with `new` or declared with that type in the same file, reached as `.searchParams` or `.headers`, or named like one (`form`, `params`, `query`, `headers`). Other receivers are taken to be DOM nodes;
- HTML pages: text between tags (`<title>` and `<noscript>` included), the same text attributes, and inline scripts, which are checked like script files.

A value in one of these places is followed within the file where that is cheap and certain: both branches of `?:`, `&&`, `||`, `??` and `+`, array elements, string methods (`["Undo", "Redo"].join(" / ")`), `String(x)`, a local constant (`text={label}`), a property of a local object literal (`text={names.save}`) and the return values of a local function (`{summary(count)}`). Packages can add attribute and function names. Strings without letters (`×`, `100 %`) and message keys (`editor:toolbar.save`) are not text.

**Opting out:** `// i18n-ignore: <reason>` (or `{/* i18n-ignore: <reason> */}` in JSX, `<!-- i18n-ignore: <reason> -->` in HTML) on the line or alone on the line above; `// i18n-ignore-file: <reason>` for a whole file. The reason is required. Only real comments count: the same words inside a string do nothing.

The check also rejects bundles the comparison of languages could not see (section 2).

## Consequences

- The player carries about 3.3 KB (gzipped) for translations, plus its own messages.
- Message syntax beyond the subset (offsets, skeletons, currency styles) needs a change to the parser or a switch to a full ICU library.
- The hard-coded text check finds text where it is written, and follows it only within one file. Text that reaches a text place through a parameter, an import or a variable that is reassigned (`menu.map((item) => <Button text={item.label} />)` with the menu in another file) is found only where it is written, if that place holds text by name (`label: "Save"`); text in a variable with an ordinary name in another file is not found. Code review and the convention of calling `t(...)` where text is shown cover that.
- Each language is a separate file per namespace. Adding a language means adding it to `LOCALES`, adding one file per namespace, and checking the fallback order.
