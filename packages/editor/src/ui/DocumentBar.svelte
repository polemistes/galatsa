<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The open document: its save status and the storage layer's notices, saving
  as a file, closing, and the offer to save as a file before a document with
  unstored changes is closed (docs/adr/0006, section 7.1).
-->
<script lang="ts">
  import type { I18n } from "@galatsa/i18n";
  import { noticeText } from "@galatsa/storage";
  import { statusMessage, type EditorDocument } from "../document.ts";
  import Dialog from "./Dialog.svelte";
  import { translator, Watched } from "./reactive.ts";

  let { i18n, doc }: { i18n: I18n; doc: EditorDocument } = $props();

  const t = $derived(translator(i18n));
  const watched = $derived(new Watched(doc, () => doc.state));
  const state = $derived(watched.current);
  const status = $derived(state.status);
  const busy = $derived(state.phase !== "open" || state.savingFile);

  const statusLine = $derived.by(() => {
    const message = statusMessage(state);
    return message === null ? null : t(message.key, message.values);
  });

  function saveThenClose(): void {
    void doc.saveAsFile().then((result) => {
      // Saved: the file holds everything, so the document can go.
      if (result?.ok) void doc.closeAnyway();
    });
  }
</script>

<div class="notices">
  {#if status.problem !== null}
    <div role="alert" class="card">{noticeText(i18n, status.problem)}</div>
  {/if}
  {#each state.notices as notice, index (index)}
    <div role={notice.severity === "error" ? "alert" : "status"} class="card">
      {noticeText(i18n, notice)}
      <button type="button" onclick={() => doc.dismissNotice(index)}>
        {t("editor:action.dismissNotice")}
      </button>
    </div>
  {/each}
</div>

<div class="bar">
  <span role="status" class="galatsa-save-status">{statusLine}</span>
  <button type="button" disabled={busy} onclick={() => void doc.saveAsFile()}>
    {t("editor:action.saveAsFile")}
  </button>
  <button type="button" disabled={busy} onclick={() => void doc.close()}>
    {t("editor:action.close")}
  </button>
</div>

{#if state.phase === "offer-save"}
  <Dialog heading={t("editor:close.heading")}>
    <p>{t("editor:close.detail")}</p>
    <div class="buttons">
      <button type="button" disabled={state.savingFile} onclick={saveThenClose}>
        {t("editor:action.saveAsFile")}
      </button>
      <button type="button" onclick={() => void doc.closeAnyway()}>
        {t("editor:close.anyway")}
      </button>
      <button type="button" onclick={() => doc.keepOpen()}>
        {t("editor:close.keepOpen")}
      </button>
    </div>
  </Dialog>
{/if}

<style>
  .bar {
    position: absolute;
    left: 8px;
    bottom: 8px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    pointer-events: auto;
  }
  .notices {
    position: absolute;
    left: 8px;
    top: 8px;
    max-width: min(36rem, calc(100% - 16px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: auto;
  }
  .card {
    padding: 8px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
</style>
