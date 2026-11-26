// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findBundleProblems,
  findHardcodedText,
  isTextName,
  isUserText,
  looksLikeCode,
} from "./i18n-hardcoded.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

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
    const source = ['<List fallback="None" />;', 'showToast("Copied");'].join("\n");
    expect(texts("x.tsx", source)).toEqual([]);
    expect(
      findHardcodedText("x.tsx", source, {
        textAttributes: ["fallback"],
        textCalls: ["showToast"],
      }).map((f) => f.text),
    ).toEqual(["None", "Copied"]);
  });
});

describe("findHardcodedText in an ordinary React component", () => {
  // The fixtures are .txt files, so they are not type-checked or built.
  it("finds the text in the places React code usually has it", () => {
    const findings = findHardcodedText("Toolbar.tsx", fixture("Toolbar.tsx"));
    expect(findings.map((f) => `${f.line}: ${f.reason}: ${f.text}`)).toEqual([
      '34: text in the "text" attribute: Save', // const names = { save: "Save" }
      '35: text in the "emptyHint" variable: Nothing selected',
      "38: text in JSX: No selection", // returned by selectionSummary()
      "38: text in JSX: selected",
      '44: text in the "label" variable: items',
      '45: text in the "text" attribute: Hidden?', // the marker is in a string
      '55: text in the "text" attribute: Save',
      '56: text in the "confirmLabel" attribute: Really delete?',
      '57: text in the "children" attribute: Delete everything',
      '58: text in the "text" attribute: selected',
      "58: text in JSX: element",
      "58: text in JSX: elements",
      '59: text in the "value" attribute: Send',
      "66: text in JSX: Undo",
      "66: text in JSX: Redo",
      '68: text in the "title" attribute: Working',
      "68: text in JSX: files",
      '69: text in the "alt" attribute: Galatsa logo',
      "95: text passed to append(): New item",
    ]);
  });

  it("finds text in a plain .ts file of menu definitions and text helpers", () => {
    const findings = findHardcodedText("menu.ts", fixture("menu.ts"));
    expect(findings.map((f) => `${f.line}: ${f.reason}: ${f.text}`)).toEqual([
      '8: text in the "label" property: Save',
      '9: text in the "label" property: Open file…',
      '9: text in the "tooltip" property: Open a presentation',
      '13: text returned by "statusText": Saving…',
      '13: text returned by "statusText": All changes saved',
    ]);
  });

  it("follows local constants, objects and functions into text places", () => {
    const source = [
      'const greeting = "Hello";',
      'const words = { yes: "Yes", no: "No" };',
      "function pick(ok: boolean) {",
      '  const inner = () => "Inner";',
      '  return ok ? words.yes : words["no"];',
      "}",
      "export const A = ({ who }: { who: string }) => (",
      "  <p title={greeting}>",
      "    {pick(true)} {who} {greeting.toUpperCase()} {[who, 'and more'].join(', ')}",
      "  </p>",
      ");",
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual(["Hello", "Yes", "No", "and more"]);
  });

  it("does not follow parameters, shadowed names or imports", () => {
    const source = [
      'import { label as imported } from "./x.ts";',
      'const word = "Outer";',
      "export function A({ word }: { word: string }) {",
      "  return <p>{word} {imported}</p>;",
      "}",
      "export function B() {",
      '  for (const word of ["x"]) void word;',
      "  return <p>{(() => word)()}</p>;",
      "}",
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual([]);
  });

  it("finds text in class fields and default values", () => {
    const source = [
      "class Dialog {",
      '  title = "Settings";',
      '  get okLabel() { return "Apply"; }',
      "}",
      'export function Field({ placeholder = "Type here", id = "field" }) {',
      "  return <input placeholder={placeholder} id={id} />;",
      "}",
      'function notify(message = "Done") {',
      "  alert(message);",
      "}",
    ].join("\n");
    expect(texts("D.tsx", source)).toEqual(["Settings", "Apply", "Type here", "Done"]);
  });

  it("checks append() only where it inserts text into the DOM", () => {
    const source = [
      "export function f(el: Element, data: FormData, q: URLSearchParams, url: URL) {",
      '  data.append("title", "Report");',
      '  q.append("sort", "Name");',
      '  url.searchParams.append("view", "Grid");',
      '  new Headers().append("Accept", "text/html");',
      "  const uploadForm = new FormData();",
      '  uploadForm.append("name", "Draft");',
      '  el.append("Visible text");',
      '  el.after("After text");',
      "}",
    ].join("\n");
    expect(texts("f.ts", source)).toEqual(["Visible text", "After text"]);
  });
});

describe("findHardcodedText in HTML", () => {
  it("finds text, text attributes and button values, and honours comments", () => {
    const findings = findHardcodedText("index.html", fixture("index.html"));
    expect(findings.map((f) => `${f.line}:${f.column}: ${f.reason}: ${f.text}`)).toEqual([
      "8:12: text in HTML: Presentation editor",
      "15:15: text in HTML: This program needs JavaScript.",
      '16:31: text in the "aria-label" attribute: Canvas',
      '18:48: text in the "placeholder" attribute: Search',
      '19:35: text in the "value" attribute: Go',
      '20:36: text in the "title" attribute: Close',
      '26:24: text assigned to "title": Set by script',
    ]);
  });

  it("skips a page with i18n-ignore-file", () => {
    const source = "<!-- i18n-ignore-file: test page --><p>Hello</p>";
    expect(texts("page.html", source)).toEqual([]);
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

  it("only counts i18n-ignore in comments, not in strings", () => {
    const source = [
      'const note = "i18n-ignore: not a comment"; el.textContent = "Shown";',
      'el.title = "Hidden"; // i18n-ignore: a real comment',
      'const s = "// i18n-ignore-file: not a comment either";',
      'el.textContent = "Also shown";',
    ].join("\n");
    expect(texts("x.ts", source)).toEqual(["Shown", "Also shown"]);
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

describe("findBundleProblems", () => {
  const rules = { messages: "src/messages", locales: ["nb", "en"] };
  const problems = (file: string, lines: string[]): [number, string, string][] =>
    findBundleProblems(file, lines.join("\n"), rules).map((f) => [
      f.line,
      f.text,
      f.reason,
    ]);

  it("accepts a bundle made from the message files in the messages folder", () => {
    const source = [
      'import { defineMessages } from "@galatsa/i18n";',
      'import en from "./en.ts";',
      'import nb from "./nb.ts";',
      'export const messages = defineMessages("editor", { nb, en });',
    ];
    expect(problems("src/messages/index.ts", source)).toEqual([]);
  });

  it("finds catalogs written inline", () => {
    const source = [
      'import { defineMessages } from "@galatsa/i18n";',
      'export const bad = defineMessages("b", { nb: { x: "X" }, en: { x: "X" } });',
    ];
    expect(problems("src/messages/index.ts", source).map(([l, t]) => [l, t])).toEqual([
      [2, "nb"],
      [2, "en"],
    ]);
  });

  it("finds bundles made outside the messages folder", () => {
    const source = [
      'import { defineMessages as dm } from "@galatsa/i18n";',
      'import nb from "./locales/nb.ts";',
      'import en from "./locales/en.ts";',
      'export const messages = dm("editor", { nb, en });',
    ];
    const found = problems("src/locales.ts", source);
    expect(found).toHaveLength(1);
    expect(found[0]?.[2]).toMatch(/^defineMessages\(\) outside src\/messages/);
  });

  it("finds catalogs that do not come from their language's file", () => {
    const source = [
      'import { defineMessages } from "@galatsa/i18n";',
      'import en from "./en.ts";',
      'import nb from "./nb.ts";',
      'import { extra } from "./ids.ts";',
      'export const a = defineMessages("a", { nb, en: nb });',
      'export const b = defineMessages("b", { nb: extra, en, de: en });',
    ];
    expect(problems("src/messages/index.ts", source)).toEqual([
      [
        5,
        "en",
        "the en catalog must be the default export of ./en.ts, imported in this file",
      ],
      [
        6,
        "nb",
        "the nb catalog must be the default export of ./nb.ts, imported in this file",
      ],
      [6, "de", "not an interface language (nb, en)"],
    ]);
  });
});

describe("hand-written bundles", () => {
  const rules = { messages: "src/messages", locales: ["nb", "en"] };

  it("rejects a bundle object written without defineMessages()", () => {
    const source = [
      'import type { MessageBundle } from "@galatsa/i18n";',
      'import nb from "./nb.ts";',
      'export const bundle: MessageBundle = { namespace: "editor", messages: { nb, en: { x: "X" } } };',
    ].join("\n");
    const found = findBundleProblems("src/messages/index.ts", source, rules);
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toMatch(
      /written by hand; create it with defineMessages\(\)/,
    );
  });

  it("accepts the shorthand object that defineMessages() itself returns", () => {
    const source =
      "export function make(namespace: string, messages: object) {\n  return { namespace, messages };\n}";
    expect(findBundleProblems("src/catalog.ts", source, rules)).toEqual([]);
  });
});

describe("findHardcodedText: fewer false alarms, fewer misses", () => {
  it("does not read CSS in <style> or code in <script> as text", () => {
    const source = [
      'const css = ".a { color: red; }";',
      "export const A = () => (",
      "  <>",
      "    <style>{css}</style>",
      '    <style>{".b { margin: 0 }"}</style>',
      '    <script>{"window.x = 1"}</script>',
      "  </>",
      ");",
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual([]);
  });

  it("knows enterKeyHint and the like are keywords", () => {
    expect(
      texts("A.tsx", 'export const A = () => <input enterKeyHint="search" />;'),
    ).toEqual([]);
    expect(isTextName("enterKeyHint")).toBe(false);
  });

  it("does not report codes in names that hold text only by convention", () => {
    const source = [
      'const errorMessage = "ENOENT";',
      'const plainText = "text/plain";',
      'const sortDescription = "ascending";',
      'const localeText = "en-US";',
      'const iconLabel = "arrowLeft";',
      'export const A = () => <Field statusText="idle" placeholder="https://example.com/x.png" />;',
      // Words are still text, also capitalised single words and non-ASCII words.
      'const saveLabel = "Save";',
      'const emptyMessage = "Nothing here";',
      'const searchHint = "søk";',
      'const okLabel = "OK";',
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual(["Save", "Nothing here", "søk", "OK"]);
  });

  it("still reports codes in the fixed text places", () => {
    const source = [
      "export const A = () => (",
      '  <button title="save" aria-label="ENOENT">ok</button>',
      ");",
    ].join("\n");
    expect(texts("A.tsx", source)).toEqual(["save", "ENOENT", "ok"]);
  });

  it("does not report a URL or e-mail address", () => {
    expect(isUserText("https://example.com/x.png")).toBe(false);
    expect(isUserText("someone@example.org")).toBe(false);
    expect(isUserText("Visit https://example.com")).toBe(true);
  });

  it("finds text appended to document.body and in notification bodies", () => {
    const source = [
      'document.body.append("Loading…");',
      'frame.contentDocument.body.append("Loading again");',
      'new Notification("Saved", { body: "Your presentation was saved" });',
      'const options = { body: "Ready" };',
      'registration.showNotification("Done", options);',
      'request.body.append("x", "not text");',
      'body.append("y", "not text either");',
    ].join("\n");
    expect(texts("dom.ts", source)).toEqual([
      "Loading…",
      "Loading again",
      "Saved",
      "Your presentation was saved",
      "Ready",
      "Done",
    ]);
  });

  it("looks for codes the way the documentation says", () => {
    const codes = [
      "ENOENT",
      "text/plain",
      "ascending",
      "en-US",
      "fooBar",
      "x.png",
      "item_1",
    ];
    for (const code of codes) expect(looksLikeCode(code), code).toBe(true);
    const words = ["Save", "OK", "Sign-in", "Saved.", "søk", "Save file", "Lagre…"];
    for (const word of words) expect(looksLikeCode(word), word).toBe(false);
  });
});
