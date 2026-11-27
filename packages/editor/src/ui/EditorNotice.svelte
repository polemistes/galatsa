<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- The editor's notice (a paste that was refused, say), until dismissed. -->
<script lang="ts">
  import type { Editor } from "../editor.ts";
  import { translator, Watched } from "./reactive.ts";

  let { editor }: { editor: Editor } = $props();

  const t = $derived(translator(editor.i18n));
  const watched = $derived(new Watched(editor, () => editor.notice));
  const notice = $derived(watched.current);
</script>

{#if notice !== null}
  <div role="alert" class="galatsa-editor-notice">
    {t(notice.message)}
    <button type="button" onclick={() => editor.dismissNotice()}>
      {t("editor:action.dismissNotice")}
    </button>
  </div>
{/if}

<style>
  div {
    position: absolute;
    left: 50%;
    top: 8px;
    transform: translateX(-50%);
    max-width: min(32rem, calc(100% - 16px));
    padding: 8px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
  }
  button {
    margin-inline-start: 8px;
  }
</style>
