// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { checkCatalogs, coveredCategories } from "./catalog.ts";
import { commonMessages } from "./messages/index.ts";

describe("checkCatalogs", () => {
  it("accepts the shared catalogs", () => {
    expect(checkCatalogs(commonMessages.messages)).toEqual([]);
  });

  it("reports missing and extra keys", () => {
    const problems = checkCatalogs({
      nb: { a: "A", b: "B" },
      en: { a: "A", c: "C" },
    });
    expect(problems).toContain('en: missing key "b"');
    expect(problems).toContain('nb: missing key "c"');
  });

  it("reports a missing language and an unknown one", () => {
    expect(checkCatalogs({ nb: {}, de: {} })).toEqual([
      "en: the catalog is missing",
      "de: not an interface language (nb, en)",
    ]);
  });

  it("reports values that differ between languages", () => {
    expect(
      checkCatalogs({
        nb: { greet: "Hei, {name}!" },
        en: { greet: "Hello, {user}!" },
      }),
    ).toEqual([
      '"greet": the values differ between languages: nb uses {name}, en uses {user}',
    ]);
    expect(checkCatalogs({ nb: { k: "Hei" }, en: { k: "Hi {name}" } })).toEqual([
      '"k": the values differ between languages: nb uses no values, en uses {name}',
    ]);
  });

  it("reports syntax errors and invalid keys", () => {
    const problems = checkCatalogs({ nb: { "a:b": "x {" }, en: { "a:b": "x" } });
    expect(problems).toContain('nb: invalid key "a:b" (allowed: letters, digits, _ - .)');
    expect(problems.some((p) => p.startsWith('nb: "a:b" has a syntax error'))).toBe(true);
  });

  it("reports a value used as a number in one language and a date in another", () => {
    expect(checkCatalogs({ nb: { a: "{n} stk" }, en: { a: "{n, date} pcs" } })).toEqual([
      '"a": {n} is a plain value in nb but a date value in en',
    ]);
    expect(
      checkCatalogs({
        nb: { a: "{n, time}" },
        en: { a: "{n, plural, one {#} other {#}}" },
      }),
    ).toEqual(['"a": {n} is a date value in nb but a number value in en']);
    expect(
      checkCatalogs({ nb: { a: "{k, select, x {X} other {Y}}" }, en: { a: "{k}" } }),
    ).toEqual(['"a": {k} is a select value in nb but a plain value in en']);
  });

  it("accepts a plain value where the other language counts it", () => {
    expect(
      checkCatalogs({
        nb: { a: "{n} stk" },
        en: { a: "{n, plural, one {# piece} other {# pieces}}" },
      }),
    ).toEqual([]);
    expect(
      checkCatalogs({ nb: { a: "{d, date, short}" }, en: { a: "{d, time}" } }),
    ).toEqual([]);
  });

  it("reports one value used as two kinds in the same message", () => {
    expect(
      checkCatalogs({
        nb: { a: "{n, number} {n, date}" },
        en: { a: "{n, number} {n, date}" },
      }),
    ).toEqual([
      'nb: "a": {n} is used as date and number; one value cannot be both',
      'en: "a": {n} is used as date and number; one value cannot be both',
    ]);
  });

  it("reports select options that differ between languages", () => {
    expect(
      checkCatalogs({
        nb: { a: "{k, select, image {Bilde} text {Tekst} other {Element}}" },
        en: { a: "{k, select, image {Image} other {Element}}" },
      }),
    ).toEqual([
      '"a": select {k} has the options image, other, text in nb but image, other in en',
    ]);
  });

  it("accepts =1 in place of one in nb and en, where one means exactly 1", () => {
    expect(
      checkCatalogs({
        nb: { a: "{n, plural, =0 {Ingen} =1 {Én fil} other {# filer}}" },
        en: { a: "{n, plural, =0 {None} =1 {One file} other {# files}}" },
      }),
    ).toEqual([]);
    // =0 does not stand in for one.
    expect(
      checkCatalogs({
        nb: { a: "{n, plural, =0 {Ingen} other {# filer}}" },
        en: { a: "{n, plural, =0 {None} other {# files}}" },
      }),
    ).toHaveLength(2);
    // English ordinals: "one" is 1, 21, 31, ..., so =1 does not cover it.
    expect(coveredCategories("en", true, ["=1"])).toEqual([]);
    expect(coveredCategories("en", false, ["=1"])).toEqual(["one"]);
    expect(coveredCategories("nb", false, ["=0", "=1"])).toEqual(["one"]);
    // French "one" is 0 and 1 and the fractions between, Russian "one" 1, 21, 31, ...
    expect(coveredCategories("fr", false, ["=0", "=1"])).toEqual([]);
    expect(coveredCategories("ru", false, ["=1"])).toEqual([]);
  });

  it("requires each language's own plural categories, and only those", () => {
    const problems = checkCatalogs({
      nb: { n: "{n, plural, one {# fil} few {# filer} other {# filer}}" },
      en: { n: "{n, plural, other {# files}}" },
    });
    expect(problems).toEqual([
      'nb: "n": plural {n} has categories that nb never uses: few (use =N for exact numbers)',
      'en: "n": plural {n} lacks the categories one (en uses one, other)',
    ]);
  });
});
