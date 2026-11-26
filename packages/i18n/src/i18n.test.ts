// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { defineMessages } from "./catalog.ts";
import { createI18n, type I18nOptions } from "./i18n.ts";
import { commonMessages } from "./messages/index.ts";
import { memoryLocaleStorage } from "./storage.ts";

const shapes = defineMessages("ext.shapes", {
  nb: {
    "tool.name": "Former",
    "shape.count": "{count, plural, one {# form} other {# former}}",
    "only.nb": "Bare på bokmål",
  },
  en: {
    "tool.name": "Shapes",
    "shape.count": "{count, plural, one {# shape} other {# shapes}}",
    // "only.nb" is missing on purpose: the type checker would normally catch it.
  } as Record<"tool.name" | "shape.count" | "only.nb", string>,
});

function setup(options: Partial<I18nOptions> & { dev: boolean }) {
  const warnings: string[] = [];
  const i18n = createI18n({
    systemLanguages: [],
    warn: (message) => warnings.push(message),
    bundles: [commonMessages, shapes],
    ...options,
  });
  return { i18n, warnings };
}

describe("lookup", () => {
  it("looks up and formats plurals and values in Bokmål and English", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "nb" });
    const t = i18n.translator(shapes);
    expect(t("tool.name")).toBe("Former");
    expect(t("shape.count", { count: 1 })).toBe("1 form");
    expect(t("shape.count", { count: 5 })).toBe("5 former");
    expect(i18n.t("common:selection.count", { count: 0 })).toBe("Ingenting er valgt");

    i18n.setLocale("en");
    expect(t("tool.name")).toBe("Shapes");
    expect(t("shape.count", { count: 1 })).toBe("1 shape");
    expect(t("shape.count", { count: 5 })).toBe("5 shapes");
    expect(i18n.t("common:selection.count", { count: 2 })).toBe(
      "2 elements are selected",
    );
    expect(warnings).toEqual([]);
  });

  it("formats numbers and dates for the current language", () => {
    const { i18n } = setup({ dev: false, locale: "nb" });
    expect(i18n.formatNumber(1234.5)).toBe("1 234,5");
    i18n.setLocale("en");
    expect(i18n.formatNumber(1234.5)).toBe("1,234.5");
    expect(i18n.formatDate(0, { timeZone: "UTC", year: "numeric" })).toBe("1970");
  });
});

describe("missing translations", () => {
  it("warns and shows a marker during development", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en" });
    expect(i18n.t("ext.shapes:only.nb")).toBe("⟦ext.shapes:only.nb⟧");
    expect(warnings).toEqual(['Missing en translation for "ext.shapes:only.nb"']);

    // Warned once per problem, not on every render.
    i18n.t("ext.shapes:only.nb");
    expect(warnings).toHaveLength(1);
  });

  it("falls back quietly to the other language in production", () => {
    const { i18n, warnings } = setup({ dev: false, locale: "en" });
    expect(i18n.t("ext.shapes:only.nb")).toBe("Bare på bokmål");
    expect(warnings).toEqual([]);
  });

  it("marks unknown keys, unknown namespaces and missing values during development", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "nb" });
    expect(i18n.t("common:no.such.key")).toBe("⟦common:no.such.key⟧");
    expect(i18n.t("nowhere:key")).toBe("⟦nowhere:key⟧");
    expect(i18n.t("no-namespace")).toBe("⟦no-namespace⟧");
    expect(i18n.t("common:selection.count")).toBe("⟦count⟧");
    expect(warnings).toHaveLength(4);
  });

  it("returns the key, without markers or warnings, in production", () => {
    const { i18n, warnings } = setup({ dev: false, locale: "nb" });
    expect(i18n.t("common:no.such.key")).toBe("common:no.such.key");
    expect(i18n.t("common:selection.count")).toBe("{count}");
    expect(warnings).toEqual([]);
  });

  it("marks a broken message during development and falls back in production", () => {
    const broken = defineMessages("broken", {
      nb: { key: "Ødelagt {" },
      en: { key: "Fine" },
    });
    const dev = setup({ dev: true, locale: "nb", bundles: [broken] });
    expect(dev.i18n.t("broken:key")).toBe("⟦broken:key⟧");
    expect(dev.warnings[0]).toMatch(/^Broken message "broken:key" in nb/);
    const prod = setup({ dev: false, locale: "nb", bundles: [broken] });
    expect(prod.i18n.t("broken:key")).toBe("Fine");
  });
});

describe("language choice", () => {
  it("starts from the system language when nothing is stored", () => {
    expect(createI18n({ dev: false, systemLanguages: ["nb-NO", "en"] }).locale).toBe(
      "nb",
    );
    expect(createI18n({ dev: false, systemLanguages: ["nn"] }).locale).toBe("nb");
    expect(createI18n({ dev: false, systemLanguages: ["de-DE", "en-GB"] }).locale).toBe(
      "en",
    );
    expect(createI18n({ dev: false, systemLanguages: ["sv"] }).locale).toBe("en");
    expect(createI18n({ dev: false, systemLanguages: [] }).locale).toBe("en");
  });

  it("remembers an explicit choice and prefers it over the system language", () => {
    const storage = memoryLocaleStorage();
    const first = createI18n({ dev: false, storage, systemLanguages: ["en-US"] });
    expect(first.locale).toBe("en");
    expect(storage.get()).toBeNull(); // the system default is not stored
    first.setLocale("nb");
    expect(storage.get()).toBe("nb");

    const second = createI18n({ dev: false, storage, systemLanguages: ["en-US"] });
    expect(second.locale).toBe("nb");
  });

  it("ignores a stored value that is not a supported language", () => {
    const storage = memoryLocaleStorage("klingon");
    expect(createI18n({ dev: false, storage, systemLanguages: ["nb"] }).locale).toBe(
      "nb",
    );
  });

  it("notifies subscribers and bumps the version on changes", () => {
    const i18n = createI18n({ dev: false, locale: "nb" });
    let calls = 0;
    const unsubscribe = i18n.subscribe(() => {
      calls += 1;
    });
    const before = i18n.version;
    i18n.setLocale("en");
    i18n.setLocale("en"); // no change, no notification
    i18n.register(commonMessages);
    unsubscribe();
    i18n.setLocale("nb");
    expect(calls).toBe(2);
    expect(i18n.version).toBe(before + 3);
  });

  it("rejects unsupported languages", () => {
    const i18n = createI18n({ dev: false });
    expect(() => i18n.setLocale("de" as "nb")).toThrow("Unsupported language");
  });
});

describe("extension namespaces", () => {
  it("lets an extension register and unregister its own bundle", () => {
    const { i18n } = setup({ dev: false, locale: "en", bundles: [commonMessages] });
    expect(i18n.t("ext.shapes:tool.name")).toBe("ext.shapes:tool.name");
    i18n.register(shapes);
    i18n.register(shapes); // the same bundle again is fine
    expect(i18n.t("ext.shapes:tool.name")).toBe("Shapes");
    i18n.unregister("ext.shapes");
    expect(i18n.t("ext.shapes:tool.name")).toBe("ext.shapes:tool.name");
  });

  it("refuses a second bundle for a namespace that is taken", () => {
    const { i18n } = setup({ dev: false });
    const impostor = defineMessages("ext.shapes", { nb: { a: "a" }, en: { a: "a" } });
    expect(() => i18n.register(impostor)).toThrow("already registered");
  });

  it("refuses invalid namespaces", () => {
    expect(() => defineMessages("Bad Name", { nb: {}, en: {} })).toThrow("namespace");
    const { i18n } = setup({ dev: false });
    expect(() =>
      i18n.register({ namespace: "a:b", messages: { nb: {}, en: {} } }),
    ).toThrow("namespace");
  });
});
