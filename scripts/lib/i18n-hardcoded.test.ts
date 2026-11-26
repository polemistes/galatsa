// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  findHardcodedText,
  findInlineCatalogs,
  isTextName,
  isUserText,
} from "./i18n-hardcoded.ts";

const texts = (fileName: string, source: string): string[] =>
  findHardcodedText(fileName, source).map((finding) => finding.text);

describe("findHardcodedText in JSX", () => {
  it("finds JSX text, text in braces and text attributes", () => {
    const source = [
      "export function Toolbar({ busy }: { busy: boolean }) {",
      "  return (",
      '    <div className="toolbar" data-testid="bar">',
      "      <button>Save</button>",
      '      <button aria-label="Close window">×</button>',
      '      <p>{busy ? "Saving" : `Saved`}</p>',
      '      <img alt="Logo" src="logo.png" />',
      '      <input placeholder={"Search"} type="text" />',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const findings = findHardcodedText("Toolbar.tsx", source);
    expect(findings.map((f) => [f.line, f.text])).toEqual([
      [4, "Save"],
      [5, "Close window"],
      [6, "Saving"],
      [6, "Saved"],
      [7, "Logo"],
      [8, "Search"],
    ]);
    expect(findings[0]?.reason).toBe("text in JSX");
    expect(findings[1]?.reason).toBe('text in the "aria-label" attribute');
  });

  it("accepts translated text, symbols, numbers and message keys", () => {
    const source = [
      'import { t } from "./t.ts";',
      "export const A = () => (",
      '  <span title={t("editor:toolbar.save")} className="icon">',
      "    {t('editor:toolbar.save')} · 100 % – {count} &nbsp; ×",
      '    <Item label="editor:toolbar.open" />',
      "  </span>",
      ");",
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual([]);
  });

  it("ignores comments, imports and type names", () => {
    const source = [
      "// A comment with words",
      'import type { Label } from "./types.ts";',
      "/** Docs with words */",
      "export const B = (): Label => <div>{/* JSX comment with words */}</div>;",
    ].join("\n");
    expect(texts("B.tsx", source)).toEqual([]);
  });
});

describe("findHardcodedText in plain DOM code", () => {
  it("finds text given to DOM properties, browser APIs and text names", () => {
    const source = [
      "export function show(el: HTMLElement, ctx: CanvasRenderingContext2D) {",
      '  el.textContent = "Loading";',
      '  el.title = "Next stop";',
      '  el.setAttribute("aria-label", "Next");',
      '  el.setAttribute("class", "next button");',
      '  el.append("Done", document.createElement("b"));',
      '  ctx.fillText("Slide", 0, 0);',
      '  alert("Saved");',
      '  const commands = [{ id: "save", label: "Save file", shortcut: "Mod+S" }];',
      '  const emptyMessage = "Nothing here";',
      '  new Notification("Presentation started");',
      '  console.log("debug output");',
      '  throw new Error("developer message");',
      "}",
    ].join("\n");
    expect(texts("player.ts", source)).toEqual([
      "Loading",
      "Next stop",
      "Next",
      "Done",
      "Slide",
      "Saved",
      "Save file",
      "Nothing here",
      "Presentation started",
    ]);
  });

  it("checks the literal parts of template strings", () => {
    const source = [
      "const n = 3;",
      "el.textContent = `${n} slides`;",
      "el.textContent = `${n} / ${n}`;",
    ].join("\n");
    expect(texts("x.ts", source)).toEqual(["slides"]);
  });

  it("accepts extra attributes and calls from the package configuration", () => {
    const source = ['<List emptyText="None" />;', 'showToast("Copied");'].join("\n");
    expect(texts("x.tsx", source)).toEqual([]);
    expect(
      findHardcodedText("x.tsx", source, {
        textAttributes: ["emptyText"],
        textCalls: ["showToast"],
      }).map((f) => f.text),
    ).toEqual(["None", "Copied"]);
  });
});

describe("opting out", () => {
  it("skips a line marked with i18n-ignore and a reason, on the line or above", () => {
    const source = [
      "export const C = () => (",
      "  <footer>",
      "    {/* i18n-ignore: product name, not translated */}",
      "    Galatsa",
      '    <a title="GitHub">x</a> {/* i18n-ignore: brand name */}',
      "    <span>Visible</span>",
      "  </footer>",
      ");",
    ].join("\n");
    expect(texts("C.tsx", source)).toEqual(["Visible"]);
  });

  it("requires a reason", () => {
    const source = ["// i18n-ignore", 'el.textContent = "Hello";'].join("\n");
    const [finding] = findHardcodedText("x.ts", source);
    expect(finding?.reason).toMatch(/needs a reason/);
  });

  it("skips a whole file with i18n-ignore-file and a reason", () => {
    const source = [
      "// i18n-ignore-file: developer-only debug panel, never shown to users",
      "export const D = () => <div>Debug</div>;",
    ].join("\n");
    expect(texts("D.tsx", source)).toEqual([]);
  });
});

describe("helpers", () => {
  it("tells user text from symbols and keys", () => {
    expect(isUserText("Save")).toBe(true);
    expect(isUserText("Lagre endringer")).toBe(true);
    expect(isUserText("Æ")).toBe(true);
    expect(isUserText(" – 100 % ")).toBe(false);
    expect(isUserText("&nbsp;")).toBe(false);
    expect(isUserText("editor:toolbar.save")).toBe(false);
    expect(isUserText("ext.shapes:tool.name")).toBe(false);
  });

  it("knows names that hold user text", () => {
    expect(
      ["label", "title", "textContent", "saveLabel", "emptyMessage"].every(isTextName),
    ).toBe(true);
    expect(["id", "className", "type", "key", "labelKey", "Text"].some(isTextName)).toBe(
      false,
    );
  });
});

describe("findInlineCatalogs", () => {
  it("finds catalogs written inline in defineMessages()", () => {
    const source = [
      'import { defineMessages } from "@galatsa/i18n";',
      'import nb from "./messages/nb.ts";',
      'export const ok = defineMessages("a", { nb, en: nb });',
      'export const bad = defineMessages("b", { nb: { x: "X" }, en: { x: "X" } });',
    ].join("\n");
    expect(findInlineCatalogs("m.ts", source).map((f) => [f.line, f.text])).toEqual([
      [4, "nb"],
      [4, "en"],
    ]);
  });
});
