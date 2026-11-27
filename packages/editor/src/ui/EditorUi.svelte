<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The editor's interface over the canvas: the toolbar and the properties
  panel (docs/adr/0016), the save status and the storage layer's notices, the
  recovery offers at start (docs/adr/0006, section 7.1), extensions that were
  not loaded, shortcut conflicts, and open custom panels.
-->
<script lang="ts">
  import { noticeText } from "@galatsa/storage";
  import type { EditorApp } from "../app.ts";
  import ContextMenu from "./ContextMenu.svelte";
  import DocumentBar from "./DocumentBar.svelte";
  import EditorNotice from "./EditorNotice.svelte";
  import Panels from "./Panels.svelte";
  import Problems from "./Problems.svelte";
  import Properties from "./Properties.svelte";
  import RecoveryDialog from "./RecoveryDialog.svelte";
  import Toolbar from "./Toolbar.svelte";
  import { translator, Watched } from "./reactive.ts";

  let { app }: { app: EditorApp } = $props();

  const i18n = $derived(app.i18n);
  const t = $derived(translator(i18n));
  const watched = $derived(new Watched(app, () => app.state));
  const state = $derived(watched.current);
  const offer = $derived(state.phase === "recovery" ? state.offers[0] : undefined);
</script>

<div class="layer">
  {#if state.noStorage}
    <div role="alert" class="card corner">{t("editor:status.noStorage")}</div>
  {/if}
  {#if state.phase === "starting" || state.phase === "opening"}
    <div role="status" class="card top">{t("editor:status.opening")}</div>
  {:else if state.phase === "failed" && state.problem !== null}
    <div role="alert" class="card top">{noticeText(i18n, state.problem)}</div>
  {:else if state.phase === "closed"}
    <div role="status" class="card top">{t("editor:status.closed")}</div>
  {/if}
  {#if state.phase === "editing" && state.document !== null}
    <DocumentBar {i18n} doc={state.document} />
  {/if}
  {#if state.phase === "editing" && state.document !== null && state.editor !== null}
    {#key state.editor}
      <div class="side">
        <Toolbar {app} editor={state.editor} doc={state.document} />
        <Properties editor={state.editor} />
      </div>
    {/key}
  {/if}
  {#if state.editor !== null}
    <Panels editor={state.editor} />
    <ContextMenu editor={state.editor} />
    <EditorNotice editor={state.editor} />
  {/if}
  {#if offer !== undefined}
    {#key offer.slot}
      <RecoveryDialog {i18n} {app} {offer} problem={state.problem} />
    {/key}
  {/if}
  <Problems {i18n} problems={state.problems} conflicts={state.conflicts} />
</div>

<style>
  .layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    font:
      14px/1.4 system-ui,
      sans-serif;
    color: #1e293b;
  }
  .side {
    position: absolute;
    left: 8px;
    top: 8px;
    bottom: 56px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    pointer-events: none;
  }
  .card {
    position: absolute;
    padding: 8px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
  }
  .top {
    left: 8px;
    top: 8px;
  }
  .corner {
    right: 8px;
    bottom: 8px;
  }
</style>
