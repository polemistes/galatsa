<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- The open panels whose view is a Svelte component. -->
<script lang="ts">
  import type { Editor } from "../editor.ts";
  import { svelteView } from "./panels.ts";
  import { translator, Watched } from "./reactive.ts";

  let { editor }: { editor: Editor } = $props();

  const t = $derived(translator(editor.i18n));
  const watched = $derived(new Watched(editor, () => editor.version));

  const open = $derived.by(() => {
    void watched.current;
    const context = editor.host.commands.context(editor.environment());
    const shown = editor.host
      .panels(editor.mode)
      .filter((panel) => editor.services.panels.isOpen(panel.id))
      .filter((panel) => {
        try {
          return panel.definition.visible?.(context) ?? true;
        } catch {
          return false;
        }
      })
      .map((panel) => ({ panel, View: svelteView(panel) }));
    return { context, shown };
  });
</script>

{#if open.shown.length > 0}
  <aside class="galatsa-panels" aria-label={t("editor:panels.label")}>
    {#each open.shown as { panel, View } (panel.id)}
      {#if View !== null}
        <section aria-label={t(panel.definition.label)}>
          <View context={open.context} />
        </section>
      {/if}
    {/each}
  </aside>
{/if}

<style>
  aside {
    position: absolute;
    right: 8px;
    top: 56px;
    bottom: 56px;
    width: min(20rem, calc(100% - 16px));
    overflow: auto;
    pointer-events: auto;
  }
</style>
