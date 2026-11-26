// SPDX-License-Identifier: GPL-3.0-or-later

// A small parser and formatter for a subset of ICU MessageFormat, the syntax that
// translation tools understand. Supported:
//
//   Simple value         Hello, {name}!
//   Number               {size, number}   {size, number, integer}   {share, number, percent}
//   Date and time        {when, date}     {when, date, short}       {when, time, short}
//                        (styles: short, medium, long, full)
//   Plural               {count, plural, =0 {No files} one {# file} other {# files}}
//   Ordinal              {place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}
//   Select               {kind, select, image {Image} other {Element}}
//   Quoting              '{' and '}' are literal braces, '' is one apostrophe. A lone
//                        apostrophe, as in "don't", is literal (ICU's default mode).
//
// Not supported, and rejected by the parser: plural offsets, number and date
// skeletons ("::"), custom styles, and argument types other than those above.
// Plural categories come from Intl.PluralRules, so the rules are the platform's.

/** A parsed message: literal text and arguments, in order. */
export type Message = readonly MessagePart[];

export type MessagePart = string | Argument | Pound;

export type Argument =
  | { readonly kind: "argument"; readonly name: string }
  | {
      readonly kind: "number" | "date" | "time";
      readonly name: string;
      readonly style: string | undefined;
    }
  | {
      readonly kind: "plural" | "selectordinal" | "select";
      readonly name: string;
      readonly options: ReadonlyMap<string, Message>;
    };

/** "#" inside a plural: the plural's number, formatted for the language. */
export interface Pound {
  readonly kind: "pound";
}

export type ArgumentKind = Argument["kind"];

/** A value that can be put into a message. */
export type MessageValue = string | number | Date;

export type MessageValues = Readonly<Record<string, MessageValue>>;

export const NUMBER_STYLES: readonly string[] = ["integer", "percent"];
export const DATE_STYLES: readonly string[] = ["short", "medium", "long", "full"];
/** Plural category keywords defined by CLDR. */
export const PLURAL_KEYWORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
];

export class MessageSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at character ${offset})`);
    this.name = "MessageSyntaxError";
    this.offset = offset;
  }
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const SELECT_KEY = /[A-Za-z0-9_-]+/y;
const EXACT_KEY = /=-?\d+(?:\.\d+)?/y;

/** Parses a message. Throws MessageSyntaxError if the text is not valid. */
export function parseMessage(source: string): Message {
  let i = 0;

  const fail = (reason: string): never => {
    throw new MessageSyntaxError(reason, i);
  };
  const skipSpace = (): void => {
    while (i < source.length && /\s/.test(source[i] ?? "")) i += 1;
  };
  const match = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = i;
    const found = pattern.exec(source);
    if (found === null) return undefined;
    i += found[0].length;
    return found[0];
  };
  const expect = (char: string): void => {
    if (i >= source.length) fail(`Missing '${char}' at the end`);
    if (source[i] !== char) fail(`Expected '${char}'`);
    i += 1;
  };

  // Text and arguments up to the end of the source, or up to the "}" that closes an
  // option of a plural or select (when nested is true; the "}" is left for the caller).
  const parseParts = (inPlural: boolean, nested: boolean): MessagePart[] => {
    const parts: MessagePart[] = [];
    let text = "";
    const flush = (): void => {
      if (text.length > 0) parts.push(text);
      text = "";
    };
    while (i < source.length) {
      const char = source[i] as string;
      if (char === "'") {
        const next = source[i + 1];
        if (next === "'") {
          text += "'";
          i += 2;
        } else if (next === "{" || next === "}" || (inPlural && next === "#")) {
          i += 1;
          for (;;) {
            if (i >= source.length) fail("Quoted text is not closed with an apostrophe");
            const quoted = source[i] as string;
            if (quoted === "'") {
              if (source[i + 1] === "'") {
                text += "'";
                i += 2;
                continue;
              }
              i += 1;
              break;
            }
            text += quoted;
            i += 1;
          }
        } else {
          text += "'";
          i += 1;
        }
      } else if (char === "{") {
        flush();
        parts.push(parseArgument(inPlural));
      } else if (char === "}") {
        if (nested) break;
        fail("Unmatched '}'");
      } else if (char === "#" && inPlural) {
        flush();
        parts.push({ kind: "pound" });
        i += 1;
      } else {
        text += char;
        i += 1;
      }
    }
    if (nested && i >= source.length) fail("Missing '}'");
    flush();
    return parts;
  };

  const parseArgument = (inPlural: boolean): Argument => {
    i += 1; // "{"
    skipSpace();
    const name = match(IDENTIFIER) ?? fail("Expected a value name");
    skipSpace();
    if (i >= source.length) fail("Missing '}'");
    if (source[i] === "}") {
      i += 1;
      return { kind: "argument", name };
    }
    expect(",");
    skipSpace();
    const typeAt = i;
    const type = match(IDENTIFIER) ?? fail("Expected a type after ','");
    skipSpace();
    switch (type) {
      case "number":
      case "date":
      case "time": {
        let style: string | undefined;
        if (source[i] === ",") {
          i += 1;
          skipSpace();
          if (source.startsWith("::", i)) fail("Skeletons ('::') are not supported");
          style = match(IDENTIFIER) ?? fail("Expected a style after ','");
          const allowed = type === "number" ? NUMBER_STYLES : DATE_STYLES;
          if (!allowed.includes(style)) {
            fail(`Unknown ${type} style '${style}' (use ${allowed.join(", ")})`);
          }
          skipSpace();
        }
        expect("}");
        return { kind: type, name, style };
      }
      case "plural":
      case "selectordinal":
      case "select": {
        expect(",");
        skipSpace();
        if (source.startsWith("offset:", i)) fail("Plural offsets are not supported");
        const options = new Map<string, Message>();
        while (source[i] !== "}") {
          if (i >= source.length) fail("Missing '}'");
          const keyAt = i;
          const key =
            type === "select"
              ? match(SELECT_KEY)
              : (match(EXACT_KEY) ?? match(IDENTIFIER));
          if (key === undefined) fail(`Expected an option of '${type}'`);
          const optionKey = key as string;
          if (type !== "select" && !optionKey.startsWith("=")) {
            if (!PLURAL_KEYWORDS.includes(optionKey)) {
              i = keyAt;
              fail(
                `'${optionKey}' is not a plural category (use ${PLURAL_KEYWORDS.join(", ")} or =N)`,
              );
            }
          }
          if (options.has(optionKey)) {
            i = keyAt;
            fail(`Option '${optionKey}' is given twice`);
          }
          skipSpace();
          expect("{");
          const body = parseParts(type === "select" ? inPlural : true, true);
          expect("}");
          options.set(optionKey, body);
          skipSpace();
        }
        i += 1; // "}"
        if (!options.has("other")) {
          i = typeAt;
          fail(`'${type}' needs an 'other' option`);
        }
        return { kind: type, name, options };
      }
      default:
        i = typeAt;
        return fail(`Unknown type '${type}'`);
    }
  };

  return parseParts(false, false);
}

/** The names of the values a message uses, with the kind of each use. */
export function messageArguments(message: Message): Map<string, Set<ArgumentKind>> {
  const found = new Map<string, Set<ArgumentKind>>();
  const visit = (parts: Message): void => {
    for (const part of parts) {
      if (typeof part === "string" || part.kind === "pound") continue;
      let kinds = found.get(part.name);
      if (kinds === undefined) {
        kinds = new Set();
        found.set(part.name, kinds);
      }
      kinds.add(part.kind);
      if ("options" in part) for (const option of part.options.values()) visit(option);
    }
  };
  visit(message);
  return found;
}

/** Every plural and selectordinal in a message, nested ones included. */
export function pluralArguments(
  message: Message,
): { name: string; ordinal: boolean; keys: string[] }[] {
  const found: { name: string; ordinal: boolean; keys: string[] }[] = [];
  const visit = (parts: Message): void => {
    for (const part of parts) {
      if (typeof part === "string" || part.kind === "pound") continue;
      if (!("options" in part)) continue;
      if (part.kind !== "select") {
        found.push({
          name: part.name,
          ordinal: part.kind === "selectordinal",
          keys: [...part.options.keys()],
        });
      }
      for (const option of part.options.values()) visit(option);
    }
  };
  visit(message);
  return found;
}

// Intl objects are slow to create, so one is kept per language and option set.
const intlCache = new Map<
  string,
  Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules
>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules>(
  key: string,
  create: () => T,
): T {
  let value = intlCache.get(key) as T | undefined;
  if (value === undefined) {
    value = create();
    intlCache.set(key, value);
  }
  return value;
}

export function numberFormat(
  locale: string,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  return cached(
    `n|${locale}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(locale, options),
  );
}

export function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return cached(
    `d|${locale}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
  );
}

export function pluralRules(locale: string, ordinal: boolean): Intl.PluralRules {
  return cached(
    `p|${locale}|${ordinal ? "o" : "c"}`,
    () => new Intl.PluralRules(locale, { type: ordinal ? "ordinal" : "cardinal" }),
  );
}

export interface FormatOptions {
  /** BCP 47 tag passed to Intl, for example "nb" or "en". */
  readonly locale: string;
  /** Text to use for a value the caller did not pass (or passed with the wrong type). */
  readonly onMissingValue: (name: string) => string;
}

const NUMBER_STYLE_OPTIONS: Readonly<Record<string, Intl.NumberFormatOptions>> = {
  integer: { maximumFractionDigits: 0 },
  percent: { style: "percent" },
};

type DateStyle = "short" | "medium" | "long" | "full";

/** Formats a parsed message with values, for one language. */
export function formatMessage(
  message: Message,
  values: MessageValues | undefined,
  options: FormatOptions,
): string {
  const { locale, onMissingValue } = options;

  const asNumber = (value: MessageValue | undefined): number | undefined => {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    return undefined;
  };

  const format = (parts: Message, pound: number | undefined): string => {
    let out = "";
    for (const part of parts) {
      if (typeof part === "string") {
        out += part;
        continue;
      }
      if (part.kind === "pound") {
        out += numberFormat(locale).format(pound ?? 0);
        continue;
      }
      const value = values?.[part.name];
      switch (part.kind) {
        case "argument":
          if (value === undefined) out += onMissingValue(part.name);
          else if (typeof value === "string") out += value;
          else if (typeof value === "number") out += numberFormat(locale).format(value);
          else out += dateTimeFormat(locale, { dateStyle: "medium" }).format(value);
          break;
        case "number": {
          const n = asNumber(value);
          out +=
            n === undefined
              ? onMissingValue(part.name)
              : numberFormat(
                  locale,
                  part.style === undefined ? {} : NUMBER_STYLE_OPTIONS[part.style],
                ).format(n);
          break;
        }
        case "date":
        case "time": {
          const n = asNumber(value);
          const style = (part.style ?? "medium") as DateStyle;
          out +=
            n === undefined
              ? onMissingValue(part.name)
              : dateTimeFormat(
                  locale,
                  part.kind === "date" ? { dateStyle: style } : { timeStyle: style },
                ).format(n);
          break;
        }
        case "plural":
        case "selectordinal": {
          const n = typeof value === "number" ? value : undefined;
          if (n === undefined) {
            out += onMissingValue(part.name);
            break;
          }
          let chosen: Message | undefined;
          for (const [key, body] of part.options) {
            if (key.startsWith("=") && Number(key.slice(1)) === n) {
              chosen = body;
              break;
            }
          }
          chosen ??=
            part.options.get(
              pluralRules(locale, part.kind === "selectordinal").select(n),
            ) ?? part.options.get("other");
          out += format(chosen ?? [], n);
          break;
        }
        case "select": {
          if (value === undefined) {
            out += onMissingValue(part.name);
            break;
          }
          const body = part.options.get(String(value)) ?? part.options.get("other") ?? [];
          out += format(body, pound);
          break;
        }
      }
    }
    return out;
  };

  return format(message, undefined);
}
