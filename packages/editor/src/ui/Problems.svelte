<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Extensions that were not loaded, and shortcuts that two commands claim. -->
<script lang="ts">
  import { problemMessage, type LoadProblem } from "@galatsa/extension-api/editing";
  import type { ShortcutConflict } from "@galatsa/extension-api/editing";
  import type { I18n } from "@galatsa/i18n";
  import { translator } from "./reactive.ts";

  let {
    i18n,
    problems,
    conflicts,
  }: {
    i18n: I18n;
    problems: readonly LoadProblem[];
    conflicts: readonly ShortcutConflict[];
  } = $props();

  const t = $derived(translator(i18n));

  function problemText(problem: LoadProblem): string {
    const { label, values } = problemMessage(problem);
    return t(label, values);
  }
</script>

{#if problems.length > 0 || conflicts.length > 0}
  <details>
    <summary>{t("editor:problems.heading")}</summary>
    <ul>
      {#each problems as problem (problem.extension)}
        <li>{problemText(problem)}</li>
      {/each}
      {#each conflicts as conflict (`${conflict.shortcut} ${conflict.ignored}`)}
        <li>
          {t("extensions:problem.shortcut-conflict", {
            shortcut: conflict.shortcut,
            ignored: conflict.ignored,
          })}
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  details {
    position: absolute;
    right: 8px;
    top: 8px;
    padding: 8px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    pointer-events: auto;
  }
</style>
