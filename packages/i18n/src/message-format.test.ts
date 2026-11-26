// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  formatMessage,
  MessageSyntaxError,
  messageArguments,
  parseMessage,
  type MessageValues,
} from "./message-format.ts";

const format = (locale: string, source: string, values?: MessageValues): string =>
  formatMessage(parseMessage(source), values, {
    locale,
    onMissingValue: (name) => `<missing ${name}>`,
  });

const FILES_NB =
  "{count, plural, =0 {Ingen filer} one {# fil} other {# filer}} i {folder}";
const FILES_EN =
  "{count, plural, =0 {No files} one {# file} other {# files}} in {folder}";

describe("plurals", () => {
  it("chooses the Bokmål form from Intl.PluralRules", () => {
    expect(format("nb", FILES_NB, { count: 0, folder: "Bilder" })).toBe(
      "Ingen filer i Bilder",
    );
    expect(format("nb", FILES_NB, { count: 1, folder: "Bilder" })).toBe("1 fil i Bilder");
    expect(format("nb", FILES_NB, { count: 2, folder: "Bilder" })).toBe(
      "2 filer i Bilder",
    );
    // "#" is formatted for the language: Bokmål groups thousands with a no-break
    // space and uses a decimal comma.
    expect(format("nb", FILES_NB, { count: 1234, folder: "Bilder" })).toBe(
      "1 234 filer i Bilder",
    );
    expect(format("nb", FILES_NB, { count: 1.5, folder: "Bilder" })).toBe(
      "1,5 filer i Bilder",
    );
  });

  it("chooses the English form from Intl.PluralRules", () => {
    expect(format("en", FILES_EN, { count: 0, folder: "Pictures" })).toBe(
      "No files in Pictures",
    );
    expect(format("en", FILES_EN, { count: 1, folder: "Pictures" })).toBe(
      "1 file in Pictures",
    );
    expect(format("en", FILES_EN, { count: 21, folder: "Pictures" })).toBe(
      "21 files in Pictures",
    );
    expect(format("en", FILES_EN, { count: 1234, folder: "Pictures" })).toBe(
      "1,234 files in Pictures",
    );
  });

  it("formats English ordinals", () => {
    const source = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} stop";
    expect([1, 2, 3, 4, 11, 22, 103].map((n) => format("en", source, { n }))).toEqual([
      "1st stop",
      "2nd stop",
      "3rd stop",
      "4th stop",
      "11th stop",
      "22nd stop",
      "103rd stop",
    ]);
  });

  it("formats Bokmål ordinals", () => {
    expect(format("nb", "{n, selectordinal, other {#.}} stopp", { n: 3 })).toBe(
      "3. stopp",
    );
  });

  it("supports select and nesting, with # from the enclosing plural", () => {
    const source =
      "{kind, select, image {{count, plural, one {# bilde} other {# bilder}}} other {{count, plural, one {# element} other {# elementer}}}}";
    expect(format("nb", source, { kind: "image", count: 1 })).toBe("1 bilde");
    expect(format("nb", source, { kind: "shape", count: 3 })).toBe("3 elementer");
  });
});

describe("values", () => {
  it("interpolates named values in both languages", () => {
    expect(format("nb", "Hei, {name}! Du har {n} nye.", { name: "Kari", n: 3 })).toBe(
      "Hei, Kari! Du har 3 nye.",
    );
    expect(format("en", "Hello, {name}! You have {n} new.", { name: "Kari", n: 3 })).toBe(
      "Hello, Kari! You have 3 new.",
    );
  });

  it("formats numbers with Intl", () => {
    expect(format("nb", "{x, number}", { x: 1234.5 })).toBe("1 234,5");
    expect(format("en", "{x, number}", { x: 1234.5 })).toBe("1,234.5");
    expect(format("en", "{x, number, integer}", { x: 2.6 })).toBe("3");
    expect(format("nb", "{x, number, percent}", { x: 0.25 })).toBe("25 %");
    expect(format("en", "{x, number, percent}", { x: 0.25 })).toBe("25%");
  });

  it("formats dates with Intl", () => {
    const when = new Date(Date.UTC(2026, 10, 26, 12));
    expect(format("nb", "{d, date, long}", { d: when })).toBe(
      new Intl.DateTimeFormat("nb", { dateStyle: "long" }).format(when),
    );
    expect(format("en", "{d, date, short}", { d: when })).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "short" }).format(when),
    );
    expect(format("nb", "{d, date, long}", { d: when })).toContain("november");
  });

  it("reports a value that is missing or of the wrong type", () => {
    expect(format("en", "Hi {name}")).toBe("Hi <missing name>");
    expect(format("en", "{n, plural, other {#}}", { n: "x" })).toBe("<missing n>");
  });

  it("lists the values a message uses", () => {
    const names = messageArguments(parseMessage(FILES_EN));
    expect([...names.keys()].sort()).toEqual(["count", "folder"]);
    expect([...(names.get("count") ?? [])]).toEqual(["plural"]);
  });
});

describe("quoting", () => {
  it("keeps a lone apostrophe and turns '' into one", () => {
    expect(format("en", "Don't stop", {})).toBe("Don't stop");
    expect(format("en", "It''s {x}", { x: "ok" })).toBe("It's ok");
  });

  it("treats quoted braces and # as text", () => {
    expect(format("en", "Use '{name}' literally", {})).toBe("Use {name} literally");
    expect(format("en", "{n, plural, other {'#' is # here}}", { n: 4 })).toBe(
      "# is 4 here",
    );
    expect(format("en", "# outside a plural", {})).toBe("# outside a plural");
  });
});

describe("syntax errors", () => {
  it.each([
    ["Hello {name", "Missing"],
    ["Hello name}", "Unmatched"],
    ["{n, plural, one {x}}", "'other'"],
    ["{n, plural, few {x} other {y} few {z}}", "twice"],
    ["{n, plural, lots {x} other {y}}", "not a plural category"],
    ["{n, plural, offset:1 other {#}}", "offsets"],
    ["{n, number, ::currency/EUR}", "Skeletons"],
    ["{n, number, currency}", "Unknown number style"],
    ["{n, money}", "Unknown type"],
    ["{}", "value name"],
    ["'{unclosed", "Quoted text"],
  ])("rejects %s", (source, reason) => {
    expect(() => parseMessage(source)).toThrow(MessageSyntaxError);
    expect(() => parseMessage(source)).toThrow(reason);
  });
});
