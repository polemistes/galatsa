// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  isUiFile,
  isUiPackage,
  messageFiles,
  readI18nConfig,
  UI_PACKAGE_PATTERN,
} from "./i18n-config.ts";

describe("readI18nConfig", () => {
  it("uses .tsx, .jsx and HTML files and src/messages by default", () => {
    const { config, problems } = readI18nConfig({ name: "x" });
    expect(problems).toEqual([]);
    expect(isUiFile("src/Toolbar.tsx", config)).toBe(true);
    expect(isUiFile("Root.jsx", config)).toBe(true);
    expect(isUiFile("index.html", config)).toBe(true);
    expect(isUiFile("src/model.ts", config)).toBe(false);
    expect(isUiFile("src/Toolbar.test.tsx", config)).toBe(false);
    expect(config.messages).toBe("src/messages");
    expect(config.messagesExplicit).toBe(false);
  });

  it("treats every script under src/ of a user interface package as UI code", () => {
    const react = readI18nConfig({ name: "x" }, ["src/App.tsx", "src/menu.ts"]).config;
    expect(isUiFile("src/menu.ts", react)).toBe(true);
    expect(isUiFile("src/deep/helpers.mjs", react)).toBe(true);
    expect(isUiFile("vite.config.ts", react)).toBe(false);
    expect(isUiFile("src/messages/ids.ts", react)).toBe(false);
    expect(isUiFile("src/types.d.ts", react)).toBe(false);

    const translated = readI18nConfig(
      { name: "x", dependencies: { "@galatsa/i18n": "workspace:*" } },
      ["src/player.ts"],
    ).config;
    expect(isUiFile("src/player.ts", translated)).toBe(true);
  });

  it("knows which packages are user interface packages", () => {
    expect(isUiPackage({}, ["src/App.tsx"])).toBe(true);
    expect(isUiPackage({}, ["src/App.test.tsx", "src/model.ts"])).toBe(false);
    expect(isUiPackage({ devDependencies: { "@galatsa/i18n": "workspace:*" } }, [])).toBe(
      true,
    );
    expect(isUiPackage({ name: "@galatsa/i18n" }, ["src/i18n.ts"])).toBe(false);
    expect(isUiPackage({ dependencies: { "@galatsa/core": "workspace:*" } }, [])).toBe(
      false,
    );
  });

  it("leaves out files matched by a negated glob", () => {
    const { config } = readI18nConfig({
      galatsa: { i18n: { uiFiles: ["src/**", "!src/model/**"] } },
    });
    expect(isUiFile("src/view/slide.ts", config)).toBe(true);
    expect(isUiFile("src/model/slide.ts", config)).toBe(false);
  });

  it("reads uiFiles, messages and extra names", () => {
    const { config, problems } = readI18nConfig({
      galatsa: {
        i18n: {
          uiFiles: ["src/**/*.ts"],
          messages: "src/text/",
          textAttributes: ["emptyText"],
          textCalls: ["showToast"],
        },
      },
    });
    expect(problems).toEqual([]);
    expect(isUiFile("src/dom/slide.ts", config)).toBe(true);
    expect(isUiFile("src/dom/slide.spec.ts", config)).toBe(false);
    expect(isUiFile("src/text/nb.ts", config)).toBe(false); // message files are text
    expect(isUiFile("src/types.d.ts", config)).toBe(false);
    expect(config.messages).toBe("src/text");
    expect(config.textAttributes).toEqual(["emptyText"]);
  });

  it("can turn the hard-coded text check off", () => {
    const { config } = readI18nConfig({ galatsa: { i18n: { uiFiles: [] } } });
    expect(isUiFile("src/App.tsx", config)).toBe(false);
  });

  it("reports unknown and malformed settings", () => {
    const { problems } = readI18nConfig({
      galatsa: { i18n: { uifiles: ["src/**"], messages: 3, textCalls: "x" } },
    });
    expect(problems).toEqual([
      '"galatsa.i18n.uifiles" is not a known setting (uiFiles, messages, textAttributes, textCalls)',
      '"galatsa.i18n.messages" must be a folder path',
      '"galatsa.i18n.textCalls" must be a list of strings',
    ]);
  });
});

describe("messageFiles", () => {
  it("lists exactly <messages>/<language>.ts for the interface languages", () => {
    const { config } = readI18nConfig({});
    const found = messageFiles(
      [
        "src/messages/en.ts",
        "src/messages/nb.ts",
        "src/messages/index.ts",
        "src/messages/ids.ts", // a helper, not a language
        "src/messages/de.ts", // not an interface language
        "src/messages/nb.test.ts",
        "src/messages/old/de.ts",
        "src/other/sv.ts",
      ],
      config,
      ["nb", "en"],
    );
    expect([...found.entries()]).toEqual([
      ["nb", "src/messages/nb.ts"],
      ["en", "src/messages/en.ts"],
    ]);
  });
});

describe("UI_PACKAGE_PATTERN", () => {
  it("covers libraries, extensions and apps, not tooling", () => {
    expect(
      [
        "packages/editor",
        "packages/extensions/shapes",
        "apps/web",
        "bench",
        "tests/e2e",
        ".",
      ].map((dir) => UI_PACKAGE_PATTERN.test(dir)),
    ).toEqual([true, true, true, false, false, false]);
  });
});
