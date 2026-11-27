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
  const appState = $derived(watched.current);
  const offer = $derived(appState.phase === "recovery" ? appState.offers[0] : undefined);
  /** The toolbar and the properties are shown while a document is edited. */
  const shell = $derived(
    appState.phase === "editing" &&
      appState.document !== null &&
      appState.editor !== null,
  );
  let bandHeight = $state(0);
  let sideWidth = $state(0);
  const insets = $derived(
    shell ? { top: bandHeight, left: sideWidth } : { top: 0, left: 0 },
  );

  // The canvas lies beside the bars, never under them.
  $effect(() => app.setStageInsets(insets));
</script>

<div
  class="layer"
  style:--galatsa-stage-top="{insets.top}px"
  style:--galatsa-stage-left="{insets.left}px"
>
  {#if appState.noStorage}
    <div role="alert" class="card corner">{t("editor:status.noStorage")}</div>
  {/if}
  {#if appState.phase === "starting" || appState.phase === "opening"}
    <div role="status" class="card top">{t("editor:status.opening")}</div>
  {:else if appState.phase === "failed" && appState.problem !== null}
    <div role="alert" class="card top">{noticeText(i18n, appState.problem)}</div>
  {:else if appState.phase === "closed"}
    <div role="status" class="card top">{t("editor:status.closed")}</div>
  {/if}
  {#if appState.phase === "editing" && appState.document !== null}
    <DocumentBar {i18n} doc={appState.document} />
  {/if}
  {#if shell && appState.document !== null && appState.editor !== null}
    {#key appState.editor}
      <div class="band" bind:offsetHeight={bandHeight}>
        <Toolbar {app} editor={appState.editor} doc={appState.document} />
      </div>
      <div class="sidebar" bind:offsetWidth={sideWidth}>
        <Properties editor={appState.editor} />
      </div>
    {/key}
  {/if}
  {#if appState.editor !== null}
    <Panels editor={appState.editor} />
    <ContextMenu editor={appState.editor} />
    <EditorNotice editor={appState.editor} />
  {/if}
  {#if offer !== undefined}
    {#key offer.slot}
      <RecoveryDialog {i18n} {app} {offer} problem={appState.problem} />
    {/key}
  {/if}
  <Problems {i18n} problems={appState.problems} conflicts={appState.conflicts} />
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
  .band {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    padding: 4px 8px;
    background: #f8fafc;
    border-bottom: 1px solid #cbd5e1;
    pointer-events: auto;
  }
  .sidebar {
    position: absolute;
    left: 0;
    top: var(--galatsa-stage-top);
    bottom: 0;
    width: min(16rem, 40%);
    overflow: auto;
    background: #fff;
    border-right: 1px solid #cbd5e1;
    pointer-events: auto;
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
