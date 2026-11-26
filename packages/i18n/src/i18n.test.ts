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

  it("replaces a bundle with a new copy of the same namespace (hot reload)", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en" });
    expect(i18n.t("ext.shapes:tool.name")).toBe("Shapes");
    // A hot reload re-runs messages/index.ts and creates a new bundle object.
    const reloaded = defineMessages("ext.shapes", {
      nb: { "tool.name": "Formverktøy" },
      en: { "tool.name": "Shape tool" },
    });
    const before = i18n.version;
    i18n.register(reloaded);
    expect(i18n.version).toBe(before + 1);
    expect(i18n.t("ext.shapes:tool.name")).toBe("Shape tool");
    expect(warnings).toEqual([]);
  });

  it("warns during development when a replacement shares no key", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en" });
    const other = defineMessages("ext.shapes", { nb: { a: "a" }, en: { a: "a" } });
    i18n.register(other);
    expect(i18n.t("ext.shapes:a")).toBe("a");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/replaced by a bundle with none of the same keys/);
  });

  it("refuses invalid namespaces", () => {
    expect(() => defineMessages("Bad Name", { nb: {}, en: {} })).toThrow("namespace");
    const { i18n } = setup({ dev: false });
    expect(() =>
      i18n.register({ namespace: "a:b", messages: { nb: {}, en: {} } }),
    ).toThrow("namespace");
  });
});

describe("lookups never throw", () => {
  const odd = defineMessages("odd", {
    nb: {
      when: "{when, date}",
      at: "{at, time, short}",
      plain: "{value}",
      ctor: "{constructor}",
      proto: "{__proto__} {toString, number} {hasOwnProperty, plural, other {#}}",
      kind: "{kind, select, a {A} other {B}}",
    },
    en: {
      when: "{when, date}",
      at: "{at, time, short}",
      plain: "{value}",
      ctor: "{constructor}",
      proto: "{__proto__} {toString, number} {hasOwnProperty, plural, other {#}}",
      kind: "{kind, select, a {A} other {B}}",
    },
  });

  it("marks invalid dates during development and falls back in production", () => {
    const invalid = new Date("not a date");
    const dev = setup({ dev: true, locale: "en", bundles: [odd] });
    expect(dev.i18n.t("odd:when", { when: invalid })).toBe("⟦when⟧");
    expect(dev.i18n.t("odd:at", { at: Number.NaN })).toBe("⟦at⟧");
    expect(dev.i18n.t("odd:plain", { value: invalid })).toBe("⟦value⟧");
    expect(dev.i18n.t("odd:when", { when: 9e15 })).toBe("⟦when⟧"); // out of range
    expect(dev.warnings).toContain('Invalid value {when} for "odd:when"');

    const prod = setup({ dev: false, locale: "en", bundles: [odd] });
    expect(prod.i18n.t("odd:when", { when: invalid })).toBe("{when}");
    expect(prod.i18n.t("odd:at", { at: Number.POSITIVE_INFINITY })).toBe("{at}");
    expect(prod.warnings).toEqual([]);
  });

  it("reads values as own properties only", () => {
    const { i18n } = setup({ dev: false, locale: "en", bundles: [odd] });
    expect(i18n.t("odd:ctor", {})).toBe("{constructor}");
    expect(i18n.t("odd:proto", {})).toBe("{__proto__} {toString} {hasOwnProperty}");
    expect(i18n.t("odd:ctor", { constructor: "own" })).toBe("own");
  });

  it("survives values of the wrong type from plain JavaScript", () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en", bundles: [odd] });
    const values = { value: { an: "object" }, kind: null } as unknown as Record<
      string,
      string
    >;
    expect(i18n.t("odd:plain", values)).toBe("⟦value⟧");
    expect(i18n.t("odd:kind", values)).toBe("⟦kind⟧");
    expect(i18n.t("odd:plain", null as unknown as Record<string, string>)).toBe(
      "⟦value⟧",
    );
    expect(i18n.t(undefined as unknown as string)).toBe("⟦undefined⟧");
    expect(warnings).toContain('Value of the wrong type {value} for "odd:plain"');
  });

  it("formats invalid dates and rejected options without throwing", () => {
    const dev = setup({ dev: true, locale: "en" });
    expect(dev.i18n.formatDate(Number.NaN)).toBe("⟦NaN⟧");
    expect(dev.i18n.formatDate(new Date("x"))).toBe("⟦Invalid Date⟧");
    expect(dev.i18n.formatNumber(5, { style: "currency" })).toBe("⟦5⟧");
    expect(dev.warnings).toHaveLength(3);

    const prod = setup({ dev: false, locale: "en" });
    expect(prod.i18n.formatDate(Number.NaN)).toBe("");
    expect(prod.i18n.formatNumber(5, { style: "currency" })).toBe("5");
    expect(prod.i18n.formatNumber(Number.NaN)).toBe("NaN");
  });
});

describe("translator during rendering", () => {
  it("registers at once but notifies only after the current task", async () => {
    const i18n = createI18n({ dev: false, locale: "en" });
    let calls = 0;
    i18n.subscribe(() => {
      calls += 1;
    });
    const before = i18n.version;
    // As if called inside a React render: the store must not change under it.
    const t = i18n.translator(shapes);
    const again = i18n.translator(shapes);
    expect(t("tool.name")).toBe("Shapes");
    expect(again("tool.name")).toBe("Shapes");
    expect(calls).toBe(0);
    expect(i18n.version).toBe(before);

    await Promise.resolve();
    expect(calls).toBe(1); // one notification for the registration
    expect(i18n.version).toBe(before + 1);

    // The same bundle again changes nothing.
    i18n.translator(shapes);
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("picks up a reloaded bundle through translator()", async () => {
    const i18n = createI18n({ dev: false, locale: "en", bundles: [shapes] });
    const reloaded = defineMessages("ext.shapes", {
      nb: { "tool.name": "Nytt navn" },
      en: { "tool.name": "New name" },
    });
    expect(i18n.translator(reloaded)("tool.name")).toBe("New name");
    expect(i18n.translator(shapes)("tool.name")).toBe("Shapes");
  });

  /**
   * Simulates a component that calls translator() with whatever bundle `pick`
   * returns on each render, and renders again on every notification, as React
   * would. Returns the number of notifications once things settle (or the limit).
   */
  async function renderLoop(
    i18n: ReturnType<typeof createI18n>,
    pick: (render: number) => Parameters<typeof i18n.translator>[0],
  ): Promise<number> {
    let renders = 0;
    let notifications = 0;
    const render = (): void => {
      renders += 1;
      i18n.translator(pick(renders))("tool.name");
    };
    i18n.subscribe(() => {
      notifications += 1;
      if (notifications < 50) render();
    });
    render();
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
    return notifications;
  }

  it("settles when a component creates its bundle on every render", async () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en" });
    const notifications = await renderLoop(i18n, () =>
      // A new object with the same content each time, as defineMessages() inside a
      // component would give.
      defineMessages("ext.shapes", {
        nb: { ...shapes.messages.nb },
        en: { ...shapes.messages.en },
      }),
    );
    expect(notifications).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("settles and warns once when two copies of a bundle take turns", async () => {
    const { i18n, warnings } = setup({ dev: true, locale: "en", bundles: [] });
    // Two copies of a package with different texts, rendered side by side.
    const copyA = defineMessages("ext.shapes", {
      nb: { "tool.name": "A" },
      en: { "tool.name": "A" },
    });
    const copyB = defineMessages("ext.shapes", {
      nb: { "tool.name": "B" },
      en: { "tool.name": "B" },
    });
    const notifications = await renderLoop(i18n, (render) =>
      render % 2 === 0 ? copyA : copyB,
    );
    expect(notifications).toBeLessThanOrEqual(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /Two different bundles for message namespace "ext.shapes"/,
    );
    // Each copy still reads its own text, and t() reads the registered one.
    expect(i18n.translator(copyA)("tool.name")).toBe("A");
    expect(i18n.translator(copyB)("tool.name")).toBe("B");
    expect(["A", "B"]).toContain(i18n.t("ext.shapes:tool.name"));
  });

  it("does not notify when register() gets a bundle with the same content", () => {
    const { i18n } = setup({ dev: false, locale: "en" });
    const before = i18n.version;
    i18n.register(
      defineMessages("ext.shapes", {
        nb: { ...shapes.messages.nb },
        en: { ...shapes.messages.en },
      }),
    );
    expect(i18n.version).toBe(before);
  });

  it("lets register() put back a bundle that was replaced", () => {
    const { i18n } = setup({ dev: false, locale: "en" });
    const reloaded = defineMessages("ext.shapes", {
      nb: { "tool.name": "Nytt navn" },
      en: { "tool.name": "New name" },
    });
    i18n.register(reloaded);
    i18n.register(shapes);
    expect(i18n.t("ext.shapes:tool.name")).toBe("Shapes");
  });
});
