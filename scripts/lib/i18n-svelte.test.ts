// SPDX-License-Identifier: GPL-3.0-or-later

// The hard-coded text check on Svelte components: the same places as in JSX
// (i18n-hardcoded.test.ts), found through svelte/compiler's parser, and the
// same things left alone.

import { describe, expect, it } from "vitest";
import { findHardcodedText } from "./i18n-hardcoded.ts";

const check = (source: string) => findHardcodedText("Component.svelte", source);
const texts = (source: string): string[] => check(source).map((f) => f.text);

describe("findHardcodedText in Svelte markup", () => {
  it("finds markup text, text in braces and text attributes", () => {
    const source = [
      '<script lang="ts">',
      "  let { busy }: { busy: boolean } = $props();",
      "</script>",
      '<div class="toolbar" data-testid="bar">',
      "  <button>Save</button>",
      '  <button aria-label="Close window">×</button>',
      '  <p>{busy ? "Saving" : `Saved`}</p>',
      '  <img alt="Logo" src="logo.png" />',
      '  <input placeholder={"Search"} type="text" />',
      "</div>",
    ].join("\n");
    const findings = check(source);
    expect(findings.map((f) => [f.line, f.column, f.text])).toEqual([
      [5, 11, "Save"],
      [6, 23, "Close window"],
      [7, 14, "Saving"],
      [7, 25, "Saved"],
      [8, 13, "Logo"],
      [9, 23, "Search"],
    ]);
    expect(findings[0]?.reason).toBe("text in markup");
    expect(findings[1]?.reason).toBe('text in the "aria-label" attribute');
  });

  it("finds text in attributes mixing text and expressions, {@html}, and button values", () => {
    const source = [
      "<script>",
      "  let { name } = $props();",
      "</script>",
      '<span title="Hello {name}">{@html "<b>Bold</b>"}</span>',
      '<input type="submit" value="Send" />',
      '<input type="text" value="not a label" />',
      "<svelte:head><title>Galatsa editor</title></svelte:head>",
    ].join("\n");
    expect(texts(source)).toEqual(["Hello", "<b>Bold</b>", "Send", "Galatsa editor"]);
  });

  it("finds text in the props of components, by the same names as in JSX", () => {
    const source = [
      "<script>",
      '  import Button from "./Button.svelte";',
      "</script>",
      '<Button text="Save" confirmLabel="Really delete?" kind="primary" />',
      '<Button emptyText="ascending" title="ascending" />',
    ].join("\n");
    // emptyText holds text only by its name's ending, so a code is not reported
    // there; title always holds text.
    expect(texts(source)).toEqual(["Save", "Really delete?", "ascending"]);
    expect(check(source)[2]?.reason).toBe('text in the "title" attribute');
  });

  it("accepts translated text, symbols, numbers, message keys, URLs and codes", () => {
    const source = [
      '<script lang="ts">',
      '  import { t } from "./t.ts";',
      "  let count = $state(0);",
      "</script>",
      '<span title={t("editor:toolbar.save")} class="icon wide" style="color: red">',
      "  {t('editor:toolbar.save')} · 100 % – {count} &nbsp; ×",
      '  <Item label="editor:toolbar.open" />',
      '  <a href="https://example.com/help">{t("editor:help")}</a>',
      '  <div role="status" data-state="open" id="main-panel"></div>',
      '  <div class:active={count > 0} style:color="red" bind:this={el} use:focus></div>',
      '  <svelte:element this="section" onclick={() => console.log("debug output")} />',
      "</span>",
    ].join("\n");
    expect(texts(source)).toEqual([]);
  });

  it("finds text given to an action named like text", () => {
    const source = [
      '<button use:tooltip={"Drag to move"} use:focus={"Not text"}>',
      '  {t("editor:move")}',
      "</button>",
    ].join("\n");
    expect(texts(source)).toEqual(["Drag to move"]);
  });

  it("does not read comments, CSS, imports or types as text", () => {
    const source = [
      '<script lang="ts">',
      "  // A comment with words",
      '  import type { Label } from "./types.ts";',
      "  /** Docs with words */",
      "  let label: Label | undefined = undefined;",
      "</script>",
      "<!-- A markup comment with words -->",
      "<div>{/* An expression comment with words */ label}</div>",
      "<style>",
      '  p::before { content: "Not text"; font-family: "Open Sans"; }',
      "</style>",
    ].join("\n");
    expect(texts(source)).toEqual([]);
  });
});

describe("findHardcodedText follows the component's script into the markup", () => {
  it("follows local constants, objects, functions and runes", () => {
    const source = [
      '<script lang="ts">',
      '  const greeting = "Welcome";',
      '  const names = { save: "Save" };',
      "  let { busy } = $props();",
      "  function summary(n: number) {",
      '    return n === 0 ? "No selection" : `${n} selected`;',
      "  }",
      '  let status = $derived(busy ? "Working" : "Idle");',
      '  let heading = $state("Start");',
      "</script>",
      "<h1>{greeting}</h1>",
      "<button title={names.save}>{summary(0)}</button>",
      "<p>{status} {heading}</p>",
    ].join("\n");
    expect(texts(source)).toEqual([
      "Welcome",
      "Save",
      "No selection",
      "selected",
      "Working",
      "Idle",
      "Start",
    ]);
    // Reported where the text is written, in the script.
    expect(check(source)[0]?.line).toBe(2);
  });

  it("finds text in prop defaults, {@const} and text names in the script", () => {
    const source = [
      "<script>",
      '  let { label = "Untitled", size = "large" } = $props();',
      '  const emptyMessage = "Nothing here";',
      "</script>",
      "{#each [1] as n}",
      '  {@const caption = "Figure"}',
      "  <figure>{caption} {n}</figure>",
      "{/each}",
    ].join("\n");
    expect(texts(source)).toEqual(["Untitled", "Nothing here", "Figure"]);
  });

  it("checks the code in the markup with the script rules: handlers, blocks, snippets", () => {
    const source = [
      "<script>",
      "  let el;",
      "</script>",
      '<button onclick={() => alert("Saved")}>{"+"}</button>',
      '<div onclick={() => (el.textContent = "Clicked")}></div>',
      '{#if confirm("Delete it?")}',
      "  <p>Gone</p>",
      "{:else}",
      "  {#each items as item (item.id)}<li>{item.name}</li>{:else}Empty{/each}",
      "{/if}",
      "{#snippet row(label)}<td>{label}</td><td>Cell</td>{/snippet}",
      "{#await load()}Loading{:then value}{value}{:catch}Failed{/await}",
      "{#key id}<span>Keyed</span>{/key}",
    ].join("\n");
    expect(texts(source)).toEqual([
      "Saved",
      "Clicked",
      "Delete it?",
      "Gone",
      "Empty",
      "Cell",
      "Loading",
      "Failed",
      "Keyed",
    ]);
  });

  it("follows $state.raw, $state.snapshot and $derived.by", () => {
    const source = [
      '<script lang="ts">',
      "  let { busy, n } = $props();",
      '  let raw = $state.raw("Raw text");',
      '  let copy = $state.snapshot(busy ? "Snapshot A" : "Snapshot B");',
      "  let summary = $derived.by(() => {",
      '    if (n === 0) return "Nothing";',
      "    return `${n} items`;",
      "  });",
      '  let short = $derived.by(() => (busy ? "Busy" : "Ready"));',
      "  function pick() {",
      '    return "Picked";',
      "  }",
      "  let named = $derived.by(pick);",
      "  let quiet = $derived.by(() => n + 1); // a number, not text",
      "</script>",
      "<p>{raw} {copy} {summary} {short} {named} {quiet}</p>",
    ].join("\n");
    expect(texts(source)).toEqual([
      "Raw text",
      "Snapshot A",
      "Snapshot B",
      "Nothing",
      "items",
      "Busy",
      "Ready",
      "Picked",
    ]);
  });

  it("does not report the runes' arguments where they are not shown", () => {
    const source = [
      "<script>",
      '  let mode = $state.raw("advanced");',
      '  let key = $derived.by(() => "editor:toolbar.save");',
      "</script>",
      '<div data-mode={mode} class={$state.snapshot("wide")}>{t(key)}</div>',
    ].join("\n");
    expect(texts(source)).toEqual([]);
  });

  it("checks a module script too", () => {
    const source = [
      "<script module>",
      '  export const tooltip = "Drag to move";',
      "</script>",
      "<p>{tooltip}</p>",
    ].join("\n");
    expect(texts(source)).toEqual(["Drag to move"]);
  });

  it("does not follow parameters or imports, as in a .tsx file", () => {
    const source = [
      "<script>",
      '  import { saveText } from "./texts.ts";',
      "  let { title } = $props();",
      "</script>",
      "{#snippet line(text)}<p>{text}</p>{/snippet}",
      "<h1>{title}</h1><p>{saveText}</p>",
    ].join("\n");
    expect(texts(source)).toEqual([]);
  });
});

describe("opting out in Svelte", () => {
  it("skips a line marked with an HTML comment with a reason, on the line or above", () => {
    const source = [
      "<footer>",
      "  <!-- i18n-ignore: product name, not translated -->",
      "  Galatsa",
      '  <a title="GitHub">x</a> <!-- i18n-ignore: brand name -->',
      "  <span>Visible</span>",
      "</footer>",
    ].join("\n");
    expect(texts(source)).toEqual(["Visible"]);
  });

  it("honours comments in the script and in expressions", () => {
    const source = [
      "<script>",
      '  const brand = "Galatsa"; // i18n-ignore: product name',
      '  const other = "Shown";',
      "</script>",
      "<p>{brand} {other}</p>",
      '<p>{"Hidden" /* i18n-ignore: example of a comment in an expression */}</p>',
    ].join("\n");
    expect(texts(source)).toEqual(["Shown"]);
  });

  it("requires a reason, and only counts real comments", () => {
    const missing = ["<!-- i18n-ignore -->", "<p>Hello</p>"].join("\n");
    expect(check(missing)[0]?.reason).toMatch(/needs a reason/);
    const inText = ['<p title="i18n-ignore: not a comment">Shown</p>'].join("\n");
    expect(texts(inText)).toEqual(["i18n-ignore: not a comment", "Shown"]);
  });

  it("skips the component with i18n-ignore-file in markup or in the script", () => {
    expect(texts("<!-- i18n-ignore-file: debug panel -->\n<p>Debug</p>")).toEqual([]);
    expect(
      texts("<script>\n  // i18n-ignore-file: debug panel\n</script>\n<p>Debug</p>"),
    ).toEqual([]);
  });
});

describe("components that cannot be read", () => {
  it("reports a component the parser rejects instead of passing it", () => {
    const [finding] = check("<p>{unclosed</p>");
    expect(finding?.reason).toBe("the component cannot be parsed");
  });
});
