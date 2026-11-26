// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { checkCatalogs } from "./catalog.ts";
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
