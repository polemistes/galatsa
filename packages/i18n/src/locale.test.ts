// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackChain, matchLocale, negotiateLocale } from "./locale.ts";
import { browserLocaleStorage, LOCALE_STORAGE_KEY } from "./storage.ts";

describe("locales", () => {
  it("maps system language tags to interface languages", () => {
    expect(matchLocale("nb-NO")).toBe("nb");
    expect(matchLocale("no")).toBe("nb");
    expect(matchLocale("nn_NO")).toBe("nb");
    expect(matchLocale("EN-gb")).toBe("en");
    expect(matchLocale("sv-SE")).toBeUndefined();
    expect(negotiateLocale(["sv", "da", "nb"])).toBe("nb");
    expect(negotiateLocale(["fr"])).toBe("en");
  });

  it("falls back from nb to en and from en to nb", () => {
    expect(fallbackChain("nb")).toEqual(["nb", "en"]);
    expect(fallbackChain("en")).toEqual(["en", "nb"]);
  });
});

describe("browserLocaleStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses localStorage when it exists", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const storage = browserLocaleStorage();
    storage.set("nb");
    expect(store.get(LOCALE_STORAGE_KEY)).toBe("nb");
    expect(browserLocaleStorage().get()).toBe("nb");
  });

  it("keeps the choice in memory when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const storage = browserLocaleStorage();
    expect(storage.get()).toBeNull();
    storage.set("en");
    expect(storage.get()).toBe("en");
  });
});
