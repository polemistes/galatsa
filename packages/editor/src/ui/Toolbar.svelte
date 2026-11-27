<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The toolbar (docs/adr/0016): the tools, inserting a picture from a file,
  undo and redo, the commands that ask for a button (`toolbar`), opening and
  saving a presentation file, and the language. Built from the extension host
  and the command registry (toolbar.ts), so what other extensions add appears
  here without a change. Every button has a tooltip with its shortcut.
-->
<script lang="ts">
  import { LOCALES, isLocale } from "@galatsa/i18n";
  import { pickFileToOpen } from "@galatsa/storage";
  import type { EditorApp } from "../app.ts";
  import type { EditorDocument } from "../document.ts";
  import { acceptFor } from "../dom.ts";
  import type { Editor } from "../editor.ts";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { ICONS } from "./icons.ts";
  import { editorChanges, translator, Watched } from "./reactive.ts";
  import {
    pressButton,
    shortcutText,
    toolbarModel,
    type ToolbarButton,
  } from "./toolbar.ts";

  let { app, editor, doc }: { app: EditorApp; editor: Editor; doc: EditorDocument } =
    $props();

  const i18n = $derived(app.i18n);
  const t = $derived(translator(i18n));
  const model = $derived(new Watched(editorChanges(editor), () => toolbarModel(editor)));
  const toolbar = $derived(model.current);
  const watchedDoc = $derived(new Watched(doc, () => doc.state));
  const info = $derived(watchedDoc.current);
  const busy = $derived(info.phase !== "open" || info.savingFile);
  const language = $derived(new Watched(i18n, () => i18n.locale));
  const canImport = $derived(editor.canImport && acceptFor(editor) !== "");

  /** The open dialog: shown before a file replaces work not saved to a file. */
  let asking = $state(false);

  function tooltip(label: string, shortcut: string | null): string {
    const text = t(label);
    if (shortcut === null) return text;
    return t("editor:toolbar.tooltip", {
      label: text,
      shortcut: shortcutText(shortcut, editor.platform, (key) => t(key)),
    });
  }

  function buttonTooltip(button: ToolbarButton): string {
    return tooltip(button.description ?? button.label, button.shortcut);
  }

  function press(button: ToolbarButton): void {
    pressButton(editor, button);
    editor.focusCanvas();
  }

  function insertFile(): void {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.accept = acceptFor(editor);
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      const files = picker.files ? [...picker.files] : [];
      picker.remove();
      editor.focusCanvas();
      if (files.length > 0) void editor.importFiles(files);
    });
    picker.addEventListener("cancel", () => picker.remove());
    document.body.append(picker);
    picker.click();
  }

  async function save(): Promise<void> {
    await doc.saveAsFile();
    editor.focusCanvas();
  }

  function open(): void {
    if (doc.state.status.unsavedToFile) asking = true;
    else void chooseAndOpen();
  }

  /** Picks a file (from the click, which the browser asks for) and opens it. */
  async function chooseAndOpen(): Promise<void> {
    asking = false;
    let source;
    try {
      source = await pickFileToOpen(t("editor:file.type"));
    } catch (error) {
      console.error(error);
      return;
    }
    if (source === null) return;
    const result = await app.openFile(source);
    if (!result.ok) doc.addNotices([result.problem]);
  }

  function chooseLanguage(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isLocale(value)) i18n.setLocale(value);
  }
</script>

{#snippet buttons(list: readonly ToolbarButton[])}
  {#each list as button (button.id)}
    <button
      type="button"
      data-id={button.id}
      title={buttonTooltip(button)}
      aria-label={t(button.label)}
      aria-pressed={button.pressed ?? undefined}
      disabled={!button.enabled}
      onclick={() => press(button)}
    >
      <Icon path={button.icon} />
    </button>
  {/each}
{/snippet}

<div class="galatsa-toolbar" role="toolbar" aria-label={t("editor:toolbar.label")}>
  {#each toolbar.tools as group (group.key)}
    <div class="group">{@render buttons(group.buttons)}</div>
  {/each}
  {#if canImport}
    <div class="group">
      <button
        type="button"
        data-id="editor/insert-file"
        title={t("editor:toolbar.insertFile")}
        aria-label={t("editor:toolbar.insertFile")}
        disabled={editor.importing}
        onclick={insertFile}
      >
        <Icon path={ICONS["image"]!} />
      </button>
    </div>
  {/if}
  {#if toolbar.history !== null}
    <div class="group">{@render buttons(toolbar.history.buttons)}</div>
  {/if}
  {#each toolbar.commands as group (group.key)}
    <div class="group">{@render buttons(group.buttons)}</div>
  {/each}
  <div class="group">
    <button
      type="button"
      data-id="editor/open-file"
      title={t("editor:toolbar.open")}
      aria-label={t("editor:toolbar.open")}
      disabled={busy}
      onclick={open}
    >
      <Icon path={ICONS["open"]!} />
    </button>
    <button
      type="button"
      data-id="editor/save-file"
      title={t("editor:toolbar.save")}
      aria-label={t("editor:toolbar.save")}
      disabled={busy}
      onclick={() => void save()}
    >
      <Icon path={ICONS["save"]!} />
    </button>
  </div>
  <label class="group language" title={t("editor:toolbar.language")}>
    <Icon path={ICONS["language"]!} />
    <select
      aria-label={t("editor:toolbar.language")}
      value={language.current}
      onchange={chooseLanguage}
    >
      {#each LOCALES as locale (locale)}
        <option value={locale}>{t(`editor:language.${locale}`)}</option>
      {/each}
    </select>
  </label>
</div>

{#if asking}
  <Dialog heading={t("editor:open.heading")}>
    {#if info.status.unsavedToFile}
      <p>{t("editor:open.detail")}</p>
      {#if info.status.downloadedAt !== null}
        <p>{t("editor:open.downloaded", { when: info.status.downloadedAt })}</p>
      {/if}
    {/if}
    <div class="buttons">
      <button type="button" disabled={busy} onclick={() => void doc.saveAsFile()}>
        {t("editor:toolbar.save")}
      </button>
      <button type="button" disabled={busy} onclick={() => void chooseAndOpen()}>
        {info.status.unsavedToFile
          ? t("editor:open.withoutSaving")
          : t("editor:open.choose")}
      </button>
      <button type="button" onclick={() => (asking = false)}>
        {t("editor:open.cancel")}
      </button>
    </div>
  </Dialog>
{/if}

<style>
  .galatsa-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .group + .group {
    padding-inline-start: 4px;
    border-inline-start: 1px solid #e2e8f0;
  }
  .galatsa-toolbar button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: #1e293b;
    cursor: pointer;
  }
  .galatsa-toolbar button:hover:not([disabled]) {
    background: #f1f5f9;
  }
  .galatsa-toolbar button:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 1px;
  }
  .galatsa-toolbar button[aria-pressed="true"] {
    background: #dbeafe;
    border-color: #93c5fd;
    color: #1d4ed8;
  }
  .galatsa-toolbar button[disabled] {
    color: #94a3b8;
    cursor: default;
  }
  .language {
    gap: 4px;
    padding-inline-end: 2px;
    color: #475569;
  }
  select {
    font: inherit;
    padding: 4px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    background: #fff;
    color: #1e293b;
  }
</style>
